// server.js
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express    = require('express');
const bodyParser = require('body-parser');
const nodemailer = require('nodemailer');
const path       = require('path');
const crypto     = require('crypto');
const db         = require('./db');

const app = express();

/* ── slug helper for stable product identity across price changes ── */
function slug(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'unknown';
}

// Fixed product list for pivoted CSV export. Order = column order in CSV.
// Union of all titles in public/catalog.json (external + muse regions).
const EXPORT_PRODUCTS = [
  'Asciugamano bagno 100×150',
  'Lenzuolo Deluxe 2P 200×210',
  'Lenzuolo Deluxe 1P 100×210',
  'Lenzuolo 2P 240×300',
  'Lenzuolo 1P 160×300',
  'Federa grande 60×80',
  'Federa piccola 50×80',
  'Copripiumino 1P 135×200',
  'Tovaglia 150×150',
  'Strofinacci bicchieri 50×70',
  'Scendibagno 50×90',
  'Asciugamano bidet 40×60',
  'Asciugamano viso 50×100'
];

/* ── HTML-escape helper (prevents XSS in email templates) ── */
function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

/* ── Branded email wrapper ── */
function emailWrap(bodyHtml) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#f8f5f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f8f5f0;padding:24px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.06);">
  <tr><td style="background:#2d5016;padding:20px 28px;">
    <span style="color:#ffffff;font-size:20px;font-weight:600;letter-spacing:0.04em;">MUSE</span>
    <span style="color:rgba(255,255,255,.7);font-size:13px;margin-left:8px;">.holiday</span>
  </td></tr>
  <tr><td style="padding:28px 28px 24px;">${bodyHtml}</td></tr>
  <tr><td style="padding:16px 28px 20px;border-top:1px solid #e8e3dc;font-size:11px;color:#a09888;line-height:1.6;">
    MUSE.holiday &mdash; Biancheria, pulizie e gestione appartamenti<br/>
    Questa email è stata generata automaticamente. Non rispondere a questo indirizzo.
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

/* ────────────────────────── DOMAIN REDIRECTS ──────────────────────────
   Allow the Fly domain for testing, still force www → apex, and don't
   interfere with ACME TLS validation. Put this BEFORE other routes. */
app.use((req, res, next) => {
  const host = (req.headers['x-forwarded-host'] || req.hostname || '').toLowerCase();

  // Let Fly *.fly.dev work during setup
  if (host.endsWith('.fly.dev')) return next();

  // Don't break TLS issuance checks
  if (req.path.startsWith('/.well-known/acme-challenge')) return next();

  // Keep canonical redirect for your own domain (www → apex)
  if (host === 'www.musevision.it') {
    return res.redirect(301, 'https://musevision.it' + req.originalUrl);
  }

  next();
});

/* ─────────────────────────── SMTP TRANSPORT ─────────────────────────── */
const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST,
  port:   Number(process.env.SMTP_PORT),
  secure: process.env.SMTP_PORT === '465',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

/* ────────────────────────────── HELPERS ─────────────────────────────── */
const BASE_URL = process.env.APP_BASE_URL || 'https://musevision.it';
const SIGNING_SECRET = process.env.QUOTE_SIGNING_SECRET || 'CHANGE_ME';
const EXPOSE_DECISION_URL = String(process.env.EXPOSE_DECISION_URL || '').toLowerCase() === 'true';

// Sign/verify small payloads for emailed decision links
function signToken(obj) {
  const data = Buffer.from(JSON.stringify(obj)).toString('base64url');
  const sig  = crypto.createHmac('sha256', SIGNING_SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}
function verifyToken(token) {
  const [data, sig] = String(token || '').split('.');
  if (!data || !sig) throw new Error('Malformed token');
  const expected = crypto.createHmac('sha256', SIGNING_SECRET).update(data).digest('base64url');
  if (sig !== expected) throw new Error('Bad signature');
  return JSON.parse(Buffer.from(data, 'base64url').toString());
}

// Read a single cookie value from the request (avoids adding cookie-parser dep)
function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  const match = raw.split(';').map(s => s.trim()).find(s => s.startsWith(name + '='));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

// Build the Set-Cookie header value for the MUSE auth cookie
const MUSE_AUTH_TTL_MS = 12 * 60 * 60 * 1000; // 12h
function buildMuseAuthCookie(req) {
  const token = signToken({ type: 'muse-auth', exp: Date.now() + MUSE_AUTH_TTL_MS });
  const maxAge = Math.floor(MUSE_AUTH_TTL_MS / 1000);
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || '').toLowerCase();
  const secure = proto === 'https' ? '; Secure' : '';
  return `muse_auth=${encodeURIComponent(token)}; HttpOnly${secure}; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

// Admin auth is a separate session from MUSE. Shorter TTL since more sensitive.
const ADMIN_AUTH_TTL_MS = 2 * 60 * 60 * 1000; // 2h
function buildAdminAuthCookie(req) {
  const token = signToken({ type: 'admin-auth', exp: Date.now() + ADMIN_AUTH_TTL_MS });
  const maxAge = Math.floor(ADMIN_AUTH_TTL_MS / 1000);
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || '').toLowerCase();
  const secure = proto === 'https' ? '; Secure' : '';
  return `admin_auth=${encodeURIComponent(token)}; HttpOnly${secure}; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

// Middleware: require a valid, unexpired muse_auth cookie
function requireMuseAuth(req, res, next) {
  try {
    const raw = readCookie(req, 'muse_auth');
    if (!raw) return res.status(401).json({ success: false, error: 'Autenticazione MUSE richiesta.' });
    const payload = verifyToken(raw);
    if (payload.type !== 'muse-auth' || !payload.exp || payload.exp < Date.now()) {
      return res.status(401).json({ success: false, error: 'Sessione MUSE scaduta.' });
    }
    next();
  } catch {
    return res.status(401).json({ success: false, error: 'Sessione MUSE non valida.' });
  }
}

// Middleware: require admin_auth. HTML page requests get a redirect to /,
// API/JSON requests get a 401 so the caller can show an error.
function requireAdminAuth(req, res, next) {
  const wantsHtml = (req.headers.accept || '').includes('text/html');
  const fail = (msg) => wantsHtml
    ? res.redirect('/')
    : res.status(401).json({ success: false, error: msg });
  try {
    const raw = readCookie(req, 'admin_auth');
    if (!raw) return fail('Autenticazione admin richiesta.');
    const payload = verifyToken(raw);
    if (payload.type !== 'admin-auth' || !payload.exp || payload.exp < Date.now()) {
      return fail('Sessione admin scaduta.');
    }
    next();
  } catch {
    return fail('Sessione admin non valida.');
  }
}

// 72h before 00:00 of chosen day (dateISO = "YYYY-MM-DD")
function is72hBeforeMidnight(dateISO) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateISO || ''))) return false;
  const midnight = new Date(`${dateISO}T00:00:00`);
  const now = new Date();
  const diffMs = midnight - now;
  return diffMs >= 72 * 60 * 60 * 1000; // 72 hours
}

/* ───────────────────────────── MIDDLEWARE ───────────────────────────── */
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ─────────────────────────────── ROUTES ─────────────────────────────── */

// Landing
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Internal (password gated) — direct URL funnels through the portal
app.get('/internal', (req, res) => {
  res.redirect(301, '/');
});

app.post('/internal', (req, res) => {
  const entered = req.body.password;
  if (entered === process.env.INTERNAL_PW) {
    res.setHeader('Set-Cookie', buildMuseAuthCookie(req));
    res.sendFile(path.join(__dirname, 'public', 'internal.html'));
  } else {
    res.redirect('/internal?error=1');
  }
});

// Password verification for SPA
app.post('/api/verify-password', (req, res) => {
  const entered = req.body.password;
  const ok = entered === process.env.INTERNAL_PW;
  if (ok) res.setHeader('Set-Cookie', buildMuseAuthCookie(req));
  res.json({ ok });
});

// Admin password verification — separate from MUSE auth.
// Hidden access: triggered by 5 clicks on the nav logo in the SPA.
app.post('/api/verify-admin-password', (req, res) => {
  const entered = req.body.password;
  const ok = entered === process.env.ADMIN_PW;
  if (ok) res.setHeader('Set-Cookie', buildAdminAuthCookie(req));
  res.json({ ok });
});

// External shop — direct URL funnels through the portal
app.get('/external', (req, res) => {
  res.redirect(301, '/');
});

// Checkout (existing)
app.post('/checkout', async (req, res) => {
  try {
    const { region, name, email, cartJson } = req.body;
    const cart = JSON.parse(cartJson || '[]');

    let total = 0;
    let summaryHtml = `
      <h2 style="margin:0 0 8px;font-size:20px;color:#2d5016;">Nuovo ordine</h2>
      <p style="margin:0 0 4px;color:#666;font-size:14px;">Da: <strong>${esc(name)}</strong> &mdash; ${esc(region)}</p>
      <p style="margin:0 0 16px;color:#999;font-size:12px;font-style:italic;">Prezzi IVA esclusa</p>
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px;">`;
    cart.forEach(item => {
      const price = Number(item.price) || 0;
      const desc = item.description ? `<br/><span style="color:#999;font-size:12px;">${esc(item.description)}</span>` : '';
      const lineTotal = (Number(item.qty) || 0) * price;
      summaryHtml += `<tr style="border-bottom:1px solid #f0ebe4;">
        <td style="padding:10px 0;">${esc(item.title)}${desc}</td>
        <td style="padding:10px 8px;text-align:center;color:#666;">×${Number(item.qty)||0}</td>
        <td style="padding:10px 0;text-align:right;font-weight:600;">€${lineTotal.toFixed(2)}</td></tr>`;
      total += item.qty * price;
    });
    summaryHtml += `</table>
      <div style="margin:16px 0;padding:12px 16px;background:#f8f5f0;border-radius:8px;text-align:right;">
        <span style="font-size:13px;color:#666;">Totale:</span>
        <strong style="font-size:20px;color:#2d5016;margin-left:8px;">€${total.toFixed(2)}</strong>
      </div>
      <p style="font-size:12px;color:#999;margin:0;">Pagamento: nessuno richiesto ora – verrà fatturato.</p>
      <div style="margin-top:16px;padding-top:12px;border-top:1px solid #f0ebe4;font-size:13px;color:#666;">
        <strong>Cliente:</strong> ${esc(name)}<br/>
        <strong>Email:</strong> ${esc(email)}
      </div>`;

    const ccByRegion = {
      Dolomites:     'info@muse.holiday',
      'South Tyrol': 'suedtirol@muse.holiday',
      Garda:         'garda@muse.holiday',
      'Val Gardena': 'info@muse.holiday'
    };
    const ccAddress = ccByRegion[region] || process.env.SHOP_CC_EMAIL;

    await transporter.sendMail({
      from:    `"MUSE.holiday Shop" <${process.env.SMTP_USER}>`,
      to:      process.env.SHOP_EMAIL,
      cc:      [ccAddress, process.env.ADMIN_CC_EMAIL].filter(Boolean),
      subject: `Ordine ricevuto: ${name}`,
      html:    emailWrap(summaryHtml)
    });

    await transporter.sendMail({
      from:    `"MUSE.holiday Shop" <${process.env.SMTP_USER}>`,
      to:      email,
      subject: `Conferma ordine €${total.toFixed(2)}`,
      html:    emailWrap(summaryHtml)
    });

    // Analytics write — fire-and-forget. D1 mirrors the email; failures don't block checkout.
    setImmediate(async () => {
      if (!db.isConfigured()) return;
      try {
        const orderId = crypto.randomUUID();
        const createdAt = Date.now();
        const totalCents = Math.round(total * 100);
        const itemCount = cart.reduce((n, it) => n + (Number(it.qty) || 0), 0);

        const statements = [{
          sql: `INSERT INTO orders (id, created_at, region, customer_name, customer_email, total_cents, item_count, source)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'external')`,
          params: [orderId, createdAt, region || '', name || '', email || '', totalCents, itemCount]
        }];
        cart.forEach(it => {
          const qty = Number(it.qty) || 0;
          const unitCents = Math.round((Number(it.price) || 0) * 100);
          const productId = slug(it.title);
          statements.push({
            sql: `INSERT INTO order_items (order_id, product_id, product_title, qty, unit_price_cents, line_total_cents)
                  VALUES (?, ?, ?, ?, ?, ?)`,
            params: [orderId, productId, String(it.title || ''), qty, unitCents, qty * unitCents]
          });
        });
        await db.batch(statements);
      } catch (e) {
        console.error('D1 write failed (/checkout):', e.message);
      }
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Error in /checkout:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/* ─────────────── Cleaning Quote (Internal, Val Gardena) ───────────────
   POST /cleaning-quote   → user submits (region=Val Gardena, aptId, date)
   GET  /quote/decision   → you open from email to Accept/Deny (with price)
   POST /quote/decision   → you submit Accept/Deny; system emails requester
*/

// User submits quote request
app.post('/cleaning-quote', requireMuseAuth, async (req, res) => {
  try {
    const { region, name, email, apartmentId, dateISO } = req.body;

    // Eligibility: region Val Gardena — we trust caller page, enforce region here
    if (region !== 'Val Gardena' && region !== 'Dolomites') {
      return res.status(400).json({ success: false, error: 'Disponibile solo per Val Gardena e Dolomites.' });
    }

    // ID 4–5 alphanumeric
    if (!/^[A-Za-z0-9]{4,5}$/.test(String(apartmentId || ''))) {
      return res.status(400).json({ success: false, error: 'ID appartamento non valido.' });
    }

    // Must be requested 72h in advance (before 00:00 of chosen day)
    if (!is72hBeforeMidnight(dateISO)) {
      return res.status(400).json({
        success: false,
        error: 'La data deve essere richiesta 72h prima della mezzanotte del giorno scelto.'
      });
    }

    // Build decision link — include quoteId so the decision step can update the DB row
    const quoteId = crypto.randomUUID();
    const payload = {
      type: 'cleaning-quote',
      quoteId,
      region, name, email,
      apartmentId, dateISO,
      requestedAt: Date.now()
    };
    const token = signToken(payload);
    const decisionURL = `${BASE_URL}/quote/decision?token=${encodeURIComponent(token)}`;

    // Email owner (you)
    const ownerHtml = `
      <h2 style="margin:0 0 16px;font-size:20px;color:#2d5016;">Nuova richiesta preventivo pulizia</h2>
      <div style="background:#f8f5f0;border-radius:8px;padding:14px 16px;margin-bottom:16px;font-size:14px;line-height:1.8;">
        <strong>Cliente:</strong> ${esc(name)} &lt;${esc(email)}&gt;<br/>
        <strong>Appartamento:</strong> ${esc(apartmentId)}<br/>
        <strong>Data pulizia:</strong> ${esc(dateISO)}
      </div>
      <p style="font-size:14px;">Apri per <strong>Accettare</strong> o <strong>Rifiutare</strong> e inserire il prezzo:</p>
      <p><a href="${decisionURL}" style="display:inline-block;padding:10px 24px;background:#2d5016;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;font-size:14px;">Gestisci richiesta &rarr;</a></p>
    `;

    // Send emails in background so API can return quickly
    setImmediate(async () => {
      try {
        await transporter.sendMail({
          from: `"MUSE.holiday Shop" <${process.env.SMTP_USER}>`,
          to:   process.env.SHOP_EMAIL,
          cc:   ['info@muse.holiday', process.env.ADMIN_CC_EMAIL].filter(Boolean),
          subject: `Richiesta preventivo pulizia — ${name} (${apartmentId})`,
          html: emailWrap(ownerHtml)
        });
      } catch (e) {
        console.error('Background email error (owner /cleaning-quote):', e);
      }

      // Email requester (with disclaimers incl. linen not included)
      const clientHtml = `
        <h2 style="margin:0 0 12px;font-size:20px;color:#2d5016;">Richiesta preventivo inviata</h2>
        <p style="font-size:14px;line-height:1.6;">Grazie <strong>${esc(name)}</strong>, abbiamo ricevuto la tua richiesta per la pulizia dell'appartamento
        <strong>${esc(apartmentId)}</strong> il giorno <strong>${esc(dateISO)}</strong>.</p>
        <div style="background:#fef6e0;border-left:4px solid #e2a300;padding:12px 16px;border-radius:0 8px 8px 0;margin:16px 0;font-size:13px;line-height:1.6;">
          <strong>Importante:</strong> questa è solo una richiesta. La pulizia verrà programmata
          esclusivamente dopo una <strong>conferma scritta</strong> da MUSE.holiday.
        </div>
        <div style="background:#fef5f5;border-left:4px solid #b00020;padding:12px 16px;border-radius:0 8px 8px 0;font-size:13px;line-height:1.6;">
          <strong>Nota:</strong> Il prezzo della pulizia <u>NON</u> include biancheria/lavanderia.
        </div>
      `;
      try {
        await transporter.sendMail({
          from: `"MUSE.holiday Shop" <${process.env.SMTP_USER}>`,
          to:   email,
          subject: `Richiesta preventivo pulizia ricevuta — ${apartmentId} (${dateISO})`,
          html: emailWrap(clientHtml)
        });
      } catch (e) {
        console.error('Background email error (client /cleaning-quote):', e);
      }

      // Analytics: insert pending quote row
      if (db.isConfigured()) {
        try {
          await db.query(
            `INSERT INTO cleaning_quotes
               (id, created_at, region, requester_name, requester_email, apartment_id, requested_date, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
            [quoteId, Date.now(), region, name, email, apartmentId, dateISO]
          );
        } catch (e) {
          console.error('D1 write failed (/cleaning-quote):', e.message);
        }
      }
    });

    // Allow testing without relying on email:
    const includeLink = EXPOSE_DECISION_URL || String(req.query.debug || '').toLowerCase() === '1';
    res.json(includeLink ? { success: true, decisionURL } : { success: true });
  } catch (err) {
    console.error('Error /cleaning-quote:', err);
    res.status(500).json({ success: false, error: 'Errore interno' });
  }
});

// Decision page (rendered when you click email link)
app.get('/quote/decision', (req, res) => {
  try {
    const { token } = req.query;
    const data = verifyToken(token);
    if (data.type !== 'cleaning-quote') throw new Error('Bad type');

    const html = `
      <!DOCTYPE html><html lang="it"><head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1"/>
        <title>Decisione Preventivo</title>
        <style>
          body{font-family:sans-serif;max-width:640px;margin:20px auto;padding:16px}
          label{display:block;margin:.5em 0 .25em}
          input,button{padding:.6em;font-size:1rem;width:100%;box-sizing:border-box}
          .meta{background:#fafafa;padding:12px;border-radius:6px;margin-bottom:12px}
          .actions{display:flex;gap:.5rem;margin-top:10px}
          .accept{background:#0a7a2f;color:#fff;border:0}
          .deny{background:#b00020;color:#fff;border:0}
        </style>
      </head><body>
        <h2>Decisione Preventivo Pulizia</h2>
        <div class="meta">
          <div><strong>Cliente:</strong> ${esc(data.name)} &lt;${esc(data.email)}&gt;</div>
          <div><strong>Appartamento:</strong> ${esc(data.apartmentId)}</div>
          <div><strong>Data pulizia richiesta:</strong> ${esc(data.dateISO)}</div>
          <div><strong>Regione:</strong> ${esc(data.region)}</div>
        </div>

        <form method="POST" action="/quote/decision">
          <input type="hidden" name="token" value="${encodeURIComponent(token)}"/>
          <label for="price">Prezzo (in € — obbligatorio se accetti)</label>
          <input id="price" name="price" type="number" min="0" step="0.01" placeholder="Es. 80.00"/>

          <div class="actions">
            <button class="accept" name="action" value="accept">Accetta & Invia Preventivo</button>
            <button class="deny"   name="action" value="deny">Rifiuta Richiesta</button>
          </div>
        </form>
      </body></html>
    `;
    res.send(html);
  } catch (e) {
    res.status(400).send('Link non valido o scaduto.');
  }
});

async function sendQuoteDecisionEmails({ name, email, apartmentId, dateISO, action, price, notes }) {
  if (action === 'accept') {
    const html = `
      <div style="background:#f4faf6;border-left:4px solid #1f6640;padding:14px 16px;border-radius:0 8px 8px 0;margin-bottom:16px;">
        <h2 style="margin:0 0 8px;font-size:20px;color:#1f6640;">Preventivo accettato ✓</h2>
        <p style="margin:0;font-size:14px;">Appartamento <strong>${esc(apartmentId)}</strong> &mdash; ${esc(dateISO)}</p>
      </div>
      <p style="font-size:14px;line-height:1.6;">Ciao <strong>${esc(name)}</strong>, la tua richiesta è stata <strong>ACCETTATA</strong>.</p>
      <div style="background:#f8f5f0;border-radius:8px;padding:14px 16px;margin:16px 0;text-align:center;">
        <span style="font-size:13px;color:#666;">Prezzo:</span>
        <strong style="font-size:24px;color:#2d5016;margin-left:8px;">€${price.toFixed(2)}</strong>
        <span style="font-size:12px;color:#999;display:block;margin-top:4px;">IVA esclusa</span>
      </div>
      <div style="background:#fef5f5;border-left:4px solid #b00020;padding:12px 16px;border-radius:0 8px 8px 0;font-size:13px;margin:16px 0;">
        <strong>Nota:</strong> Il prezzo della pulizia <u>NON</u> include biancheria/lavanderia.
      </div>
      <p style="font-size:13px;color:#666;">Questa email costituisce <strong>conferma scritta</strong> della prenotazione.</p>
    `;
    await transporter.sendMail({
      from: `"MUSE.holiday Shop" <${process.env.SMTP_USER}>`,
      to:   email,
      subject: `Preventivo pulizia ACCETTATO — ${apartmentId} (${dateISO})`,
      html: emailWrap(html)
    });
  } else {
    const html = `
      <div style="background:#fef5f5;border-left:4px solid #9b2626;padding:14px 16px;border-radius:0 8px 8px 0;margin-bottom:16px;">
        <h2 style="margin:0 0 8px;font-size:20px;color:#9b2626;">Preventivo rifiutato</h2>
        <p style="margin:0;font-size:14px;">Appartamento <strong>${esc(apartmentId)}</strong> &mdash; ${esc(dateISO)}</p>
      </div>
      <p style="font-size:14px;line-height:1.6;">Ciao <strong>${esc(name)}</strong>, la tua richiesta è stata <strong>RIFIUTATA</strong>.</p>
      <p style="font-size:13px;color:#666;line-height:1.6;">L'invio della richiesta non implica conferma del servizio. Se vuoi, invia una nuova richiesta con un'altra data.</p>
    `;
    await transporter.sendMail({
      from: `"MUSE.holiday Shop" <${process.env.SMTP_USER}>`,
      to:   email,
      subject: `Preventivo pulizia RIFIUTATO — ${apartmentId} (${dateISO})`,
      html: emailWrap(html)
    });
  }

  const noteHtml = notes
    ? `<p style="margin:8px 0 0;font-size:13px;color:#666;"><strong>Note interne:</strong><br/>${esc(notes).replace(/\n/g, '<br/>')}</p>`
    : '';
  await transporter.sendMail({
    from: `"MUSE.holiday Shop" <${process.env.SMTP_USER}>`,
    to:   process.env.SHOP_EMAIL,
    subject: `Decisione inviata — ${String(action).toUpperCase()} — ${apartmentId} (${dateISO})`,
    html: emailWrap(`<p>Decisione: <strong>${esc(action)}</strong> ${price ? `— Prezzo €${price.toFixed(2)}` : ''}<br/>
           Cliente: ${esc(name)} &lt;${esc(email)}&gt;</p>${noteHtml}`)
  });
}

function persistQuoteDecision({ quoteId, action, price, notes }) {
  setImmediate(async () => {
    if (!db.isConfigured() || !quoteId) return;
    try {
      const status = action === 'accept' ? 'accepted' : 'denied';
      const priceCents = action === 'accept' ? Math.round(price * 100) : null;
      const decisionNotes = (typeof notes === 'string' && notes.trim()) ? notes.trim() : null;
      await db.query(
        `UPDATE cleaning_quotes SET status = ?, quoted_price_cents = ?, decided_at = ?, decision_notes = ? WHERE id = ?`,
        [status, priceCents, Date.now(), decisionNotes, quoteId]
      );
    } catch (e) {
      console.error('D1 update failed (quote decision):', e.message);
    }
  });
}

// Process Accept/Deny
app.post('/quote/decision', async (req, res) => {
  try {
    const { token, action } = req.body;
    const price = req.body.price ? Number(req.body.price) : undefined;
    const data = verifyToken(token);
    if (data.type !== 'cleaning-quote') throw new Error('Bad type');

    if (action === 'accept' && !(price >= 0)) {
      return res.status(400).send('Inserisci un prezzo valido per accettare.');
    }

    await sendQuoteDecisionEmails({
      name: data.name,
      email: data.email,
      apartmentId: data.apartmentId,
      dateISO: data.dateISO,
      action,
      price
    });

    persistQuoteDecision({ quoteId: data.quoteId, action, price });

    res.send('Decisione inviata con successo. Puoi chiudere questa pagina.');
  } catch (e) {
    console.error('Error /quote/decision:', e);
    res.status(400).send('Errore nella decisione.');
  }
});

/* ───────────────────── EMAIL PREVIEWS (DEV/QA ONLY) ─────────────────────
   Enable by setting: ENABLE_EMAIL_PREVIEWS=true
   Then open the URLs below to see the exact HTML that would be emailed.
*/
function previewsEnabled(res) {
  if (process.env.ENABLE_EMAIL_PREVIEWS === 'true') return true;
  res.status(404).send('Email previews disabled');
  return false;
}

// Helper to render the ORDER email body (same structure you send now)
function renderOrderEmail({ name, email, region, cart }) {
  let total = 0;
  let summaryHtml = `
    <h2 style="margin:0 0 8px;font-size:20px;color:#2d5016;">Nuovo ordine</h2>
    <p style="margin:0 0 4px;color:#666;font-size:14px;">Da: <strong>${esc(name)}</strong> &mdash; ${esc(region)}</p>
    <p style="margin:0 0 16px;color:#999;font-size:12px;font-style:italic;">Prezzi IVA esclusa</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px;">`;
  cart.forEach(item => {
    const price = Number(item.price) || 0;
    const desc = item.description ? `<br/><span style="color:#999;font-size:12px;">${esc(item.description)}</span>` : '';
    const lineTotal = (Number(item.qty) || 0) * price;
    summaryHtml += `<tr style="border-bottom:1px solid #f0ebe4;">
      <td style="padding:10px 0;">${esc(item.title)}${desc}</td>
      <td style="padding:10px 8px;text-align:center;color:#666;">×${Number(item.qty)||0}</td>
      <td style="padding:10px 0;text-align:right;font-weight:600;">€${lineTotal.toFixed(2)}</td></tr>`;
    total += item.qty * price;
  });
  summaryHtml += `</table>
    <div style="margin:16px 0;padding:12px 16px;background:#f8f5f0;border-radius:8px;text-align:right;">
      <span style="font-size:13px;color:#666;">Totale:</span>
      <strong style="font-size:20px;color:#2d5016;margin-left:8px;">€${total.toFixed(2)}</strong>
    </div>
    <p style="font-size:12px;color:#999;margin:0;">Pagamento: nessuno richiesto ora – verrà fatturato.</p>
    <div style="margin-top:16px;padding-top:12px;border-top:1px solid #f0ebe4;font-size:13px;color:#666;">
      <strong>Cliente:</strong> ${esc(name)}<br/>
      <strong>Email:</strong> ${esc(email)}
    </div>`;
  return summaryHtml;
}

// ORDER email preview (owner + buyer share same body in your code)
app.get('/debug/preview/order', (req, res) => {
  if (!previewsEnabled(res)) return;

  const name   = req.query.name   || 'Mario Rossi';
  const email  = req.query.email  || 'mario.rossi@example.com';
  const region = req.query.region || 'Val Gardena';

  // You can pass a cart JSON as base64url in ?cart_b64=… (optional)
  let cart = [
    { title: 'ASCIUGAMANO BAGNO 100x150', qty: 2, price: 9.77 },
    { title: 'LENZUOLO 2P 240x300', qty: 1, price: 23.53 }
  ];
  if (req.query.cart_b64) {
    try {
      cart = JSON.parse(Buffer.from(req.query.cart_b64, 'base64url').toString());
    } catch (_) {}
  }

  const html = renderOrderEmail({ name, email, region, cart });
  res.set('Content-Type','text/html; charset=utf-8').send(emailWrap(html));
});

// CLEANING: owner email preview (includes decision link)
app.get('/debug/preview/cleaning-owner', (req, res) => {
  if (!previewsEnabled(res)) return;

  const name   = req.query.name   || 'Mario Rossi';
  const email  = req.query.email  || 'mario.rossi@example.com';
  const apt    = req.query.apt    || '1234A';
  const date   = req.query.date   || '2025-11-05';
  const link   = req.query.link   || `${(process.env.APP_BASE_URL || 'https://musevision.it')}/quote/decision?token=TEST_TOKEN`;

  const html = `
    <h2 style="margin:0 0 16px;font-size:20px;color:#2d5016;">Nuova richiesta preventivo pulizia</h2>
    <div style="background:#f8f5f0;border-radius:8px;padding:14px 16px;margin-bottom:16px;font-size:14px;line-height:1.8;">
      <strong>Cliente:</strong> ${esc(name)} &lt;${esc(email)}&gt;<br/>
      <strong>Appartamento:</strong> ${esc(apt)}<br/>
      <strong>Data pulizia:</strong> ${esc(date)}
    </div>
    <p style="font-size:14px;">Apri per <strong>Accettare</strong> o <strong>Rifiutare</strong> e inserire il prezzo:</p>
    <p><a href="${link}" style="display:inline-block;padding:10px 24px;background:#2d5016;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;font-size:14px;">Gestisci richiesta &rarr;</a></p>`;
  res.set('Content-Type','text/html; charset=utf-8').send(emailWrap(html));
});

// CLEANING: client acknowledgement preview
app.get('/debug/preview/cleaning-client', (req, res) => {
  if (!previewsEnabled(res)) return;
  const name = req.query.name || 'Mario Rossi';
  const apt  = req.query.apt  || '1234A';
  const date = req.query.date || '2025-11-05';
  const html = `
    <h2 style="margin:0 0 12px;font-size:20px;color:#2d5016;">Richiesta preventivo inviata</h2>
    <p style="font-size:14px;line-height:1.6;">Grazie <strong>${esc(name)}</strong>, abbiamo ricevuto la tua richiesta per la pulizia
    dell'appartamento <strong>${esc(apt)}</strong> il giorno <strong>${esc(date)}</strong>.</p>
    <div style="background:#fef6e0;border-left:4px solid #e2a300;padding:12px 16px;border-radius:0 8px 8px 0;margin:16px 0;font-size:13px;">
      <strong>Importante:</strong> questa è solo una richiesta. Conferma solo dopo risposta scritta MUSE.holiday.
    </div>`;
  res.set('Content-Type','text/html; charset=utf-8').send(emailWrap(html));
});

// CLEANING: acceptance email preview
app.get('/debug/preview/decision-accept', (req, res) => {
  if (!previewsEnabled(res)) return;
  const name  = req.query.name  || 'Mario Rossi';
  const apt   = req.query.apt   || '1234A';
  const date  = req.query.date  || '2025-11-05';
  const price = Number(req.query.price || '80');
  const html = `
    <div style="background:#f4faf6;border-left:4px solid #1f6640;padding:14px 16px;border-radius:0 8px 8px 0;margin-bottom:16px;">
      <h2 style="margin:0 0 8px;font-size:20px;color:#1f6640;">Preventivo accettato ✓</h2>
      <p style="margin:0;font-size:14px;">Appartamento <strong>${esc(apt)}</strong> &mdash; ${esc(date)}</p>
    </div>
    <p style="font-size:14px;">Ciao <strong>${esc(name)}</strong>, la tua richiesta è stata <strong>ACCETTATA</strong>.</p>
    <div style="background:#f8f5f0;border-radius:8px;padding:14px 16px;margin:16px 0;text-align:center;">
      <span style="font-size:13px;color:#666;">Prezzo:</span>
      <strong style="font-size:24px;color:#2d5016;margin-left:8px;">€${price.toFixed(2)}</strong>
    </div>
    <p style="font-size:13px;color:#666;">Questa email costituisce conferma scritta della prenotazione.</p>`;
  res.set('Content-Type','text/html; charset=utf-8').send(emailWrap(html));
});

// CLEANING: denial email preview
app.get('/debug/preview/decision-deny', (req, res) => {
  if (!previewsEnabled(res)) return;
  const name = req.query.name || 'Mario Rossi';
  const apt  = req.query.apt  || '1234A';
  const date = req.query.date || '2025-11-05';
  const html = `
    <div style="background:#fef5f5;border-left:4px solid #9b2626;padding:14px 16px;border-radius:0 8px 8px 0;margin-bottom:16px;">
      <h2 style="margin:0 0 8px;font-size:20px;color:#9b2626;">Preventivo rifiutato</h2>
      <p style="margin:0;font-size:14px;">Appartamento <strong>${esc(apt)}</strong> &mdash; ${esc(date)}</p>
    </div>
    <p style="font-size:14px;">Ciao <strong>${esc(name)}</strong>, la tua richiesta è stata rifiutata.</p>
    <p style="font-size:13px;color:#666;">Se vuoi, invia una nuova richiesta con un'altra data.</p>`;
  res.set('Content-Type','text/html; charset=utf-8').send(emailWrap(html));
});

/* ────────────────────────────── ADMIN ───────────────────────────────────
   Password-gated analytics dashboard. Reads from Cloudflare D1.
*/

// Serve the dashboard HTML (from views/, not public/, so it is only reachable when authed)
app.get('/admin', requireAdminAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'admin.html'));
});

// Parse ?from=YYYY-MM-DD&to=YYYY-MM-DD&region=... into SQL WHERE clauses
function buildDateRangeClause(req, column = 'created_at') {
  const where = [];
  const params = [];
  const from = String(req.query.from || '').trim();
  const to   = String(req.query.to   || '').trim();
  const region = String(req.query.region || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(from)) {
    where.push(`${column} >= ?`);
    params.push(new Date(`${from}T00:00:00Z`).getTime());
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    where.push(`${column} < ?`);
    params.push(new Date(`${to}T00:00:00Z`).getTime() + 24 * 3600 * 1000);
  }
  if (region) {
    where.push(`region = ?`);
    params.push(region);
  }
  return {
    sql: where.length ? 'WHERE ' + where.join(' AND ') : '',
    params
  };
}

app.get('/admin/api/stats', requireAdminAuth, async (req, res) => {
  try {
    if (!db.isConfigured()) {
      return res.status(503).json({ success: false, error: 'Analytics DB not configured' });
    }
    const { sql: ordersWhere, params: ordersParams } = buildDateRangeClause(req);
    const { sql: quotesWhere, params: quotesParams } = buildDateRangeClause(req);

    // Summary (orders)
    const summary = await db.query(
      `SELECT COUNT(*) AS total_orders,
              COALESCE(SUM(total_cents),0) AS total_revenue_cents,
              COALESCE(SUM(item_count),0) AS total_items,
              COALESCE(AVG(total_cents),0) AS avg_order_cents
       FROM orders ${ordersWhere}`,
      ordersParams
    );

    // Summary (quotes)
    const quotesSummary = await db.query(
      `SELECT
         SUM(CASE WHEN status='pending'  THEN 1 ELSE 0 END) AS pending_quotes,
         SUM(CASE WHEN status='accepted' THEN 1 ELSE 0 END) AS accepted_quotes,
         SUM(CASE WHEN status='denied'   THEN 1 ELSE 0 END) AS denied_quotes,
         COALESCE(SUM(CASE WHEN status='accepted' THEN quoted_price_cents ELSE 0 END),0) AS accepted_revenue_cents
       FROM cleaning_quotes ${quotesWhere}`,
      quotesParams
    );

    // Per-product — JOIN items with their parent orders to apply the same filter
    const byProduct = await db.query(
      `SELECT oi.product_id, oi.product_title,
              SUM(oi.qty) AS total_qty,
              SUM(oi.line_total_cents) AS total_revenue_cents,
              COUNT(DISTINCT oi.order_id) AS order_count
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       ${ordersWhere ? ordersWhere.replace(/created_at/g, 'o.created_at').replace(/region/g, 'o.region') : ''}
       GROUP BY oi.product_id, oi.product_title
       ORDER BY total_qty DESC
       LIMIT 100`,
      ordersParams
    );

    // Per-customer
    const byCustomer = await db.query(
      `SELECT customer_email, MAX(customer_name) AS customer_name,
              COUNT(*) AS order_count,
              SUM(item_count) AS total_qty,
              SUM(total_cents) AS total_revenue_cents
       FROM orders ${ordersWhere}
       GROUP BY customer_email
       ORDER BY total_revenue_cents DESC
       LIMIT 100`,
      ordersParams
    );

    // Per-region
    const byRegion = await db.query(
      `SELECT region, COUNT(*) AS order_count, SUM(total_cents) AS total_revenue_cents
       FROM orders ${ordersWhere}
       GROUP BY region
       ORDER BY total_revenue_cents DESC`,
      ordersParams
    );

    // Recent orders
    const recentOrders = await db.query(
      `SELECT id, created_at, region, customer_name, customer_email, total_cents, item_count
       FROM orders ${ordersWhere}
       ORDER BY created_at DESC
       LIMIT 50`,
      ordersParams
    );

    // Recent quotes
    const recentQuotes = await db.query(
      `SELECT id, created_at, region, requester_name, requester_email, apartment_id,
              requested_date, status, quoted_price_cents, decided_at, decision_notes
       FROM cleaning_quotes ${quotesWhere}
       ORDER BY created_at DESC
       LIMIT 50`,
      quotesParams
    );

    res.json({
      success: true,
      summary: (summary.results || [{}])[0],
      quotesSummary: (quotesSummary.results || [{}])[0],
      byProduct: byProduct.results || [],
      byCustomer: byCustomer.results || [],
      byRegion: byRegion.results || [],
      recentOrders: recentOrders.results || [],
      recentQuotes: recentQuotes.results || []
    });
  } catch (err) {
    console.error('Error /admin/api/stats:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/admin/api/quote-decide', requireAdminAuth, async (req, res) => {
  try {
    if (!db.isConfigured()) {
      return res.status(503).json({ success: false, error: 'Analytics DB not configured' });
    }
    const { quoteId, decision } = req.body || {};
    if (!quoteId || (decision !== 'accept' && decision !== 'deny')) {
      return res.status(400).json({ success: false, error: 'Parametri non validi.' });
    }
    let price;
    if (decision === 'accept') {
      const priceCents = Number(req.body.priceCents);
      if (!Number.isFinite(priceCents) || priceCents < 0) {
        return res.status(400).json({ success: false, error: 'Prezzo non valido.' });
      }
      price = priceCents / 100;
    }

    let notes = null;
    if (typeof req.body.notes === 'string') {
      notes = req.body.notes.trim().slice(0, 1000) || null;
    }

    const lookup = await db.query(
      `SELECT id, requester_name, requester_email, apartment_id, requested_date, status
       FROM cleaning_quotes WHERE id = ? LIMIT 1`,
      [quoteId]
    );
    const row = (lookup.results || [])[0];
    if (!row) return res.status(404).json({ success: false, error: 'Preventivo non trovato.' });
    if (row.status !== 'pending') {
      return res.status(409).json({ success: false, error: `Preventivo già ${row.status}.` });
    }

    await sendQuoteDecisionEmails({
      name: row.requester_name,
      email: row.requester_email,
      apartmentId: row.apartment_id,
      dateISO: row.requested_date,
      action: decision,
      price,
      notes
    });

    persistQuoteDecision({ quoteId, action: decision, price, notes });

    res.json({ success: true });
  } catch (err) {
    console.error('Error /admin/api/quote-decide:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/admin/export-orders.csv', requireAdminAuth, async (req, res) => {
  try {
    if (!db.isConfigured()) {
      return res.status(503).send('Analytics DB not configured');
    }
    const { sql: where, params } = buildDateRangeClause(req, 'o.created_at');
    const result = await db.query(
      `SELECT o.id AS order_id, o.created_at, o.region, o.customer_name, o.customer_email,
              o.total_cents, o.item_count,
              oi.product_id, oi.qty
       FROM orders o
       LEFT JOIN order_items oi ON oi.order_id = o.id
       ${where.replace(/region/g, 'o.region')}
       ORDER BY o.created_at DESC`,
      params
    );
    const rows = result.results || [];

    const orders = new Map();
    rows.forEach(r => {
      if (!orders.has(r.order_id)) {
        orders.set(r.order_id, {
          order_id: r.order_id,
          created_at: r.created_at,
          region: r.region,
          customer_name: r.customer_name,
          customer_email: r.customer_email,
          total_cents: r.total_cents,
          item_count: r.item_count,
          qtys: {}
        });
      }
      if (r.product_id) {
        const o = orders.get(r.order_id);
        o.qtys[r.product_id] = (o.qtys[r.product_id] || 0) + Number(r.qty || 0);
      }
    });

    const csvEscape = (v) => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const productSlugs = EXPORT_PRODUCTS.map(slug);
    const header = [
      'order_id','created_at_iso','region','customer_name','customer_email',
      'order_total_eur','item_count',
      ...EXPORT_PRODUCTS
    ];
    const lines = [header.map(csvEscape).join(',')];
    for (const o of orders.values()) {
      const base = [
        o.order_id,
        new Date(o.created_at).toISOString(),
        o.region,
        o.customer_name,
        o.customer_email,
        (o.total_cents / 100).toFixed(2),
        o.item_count
      ];
      const productQtys = productSlugs.map(s => o.qtys[s] || 0);
      lines.push([...base, ...productQtys].map(csvEscape).join(','));
    }

    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition',
      `attachment; filename="orders-pivot-${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(lines.join('\n'));
  } catch (err) {
    console.error('Error /admin/export-orders.csv:', err);
    res.status(500).send('Export error: ' + err.message);
  }
});

app.get('/admin/export.csv', requireAdminAuth, async (req, res) => {
  try {
    if (!db.isConfigured()) {
      return res.status(503).send('Analytics DB not configured');
    }
    const { sql: where, params } = buildDateRangeClause(req, 'o.created_at');
    const result = await db.query(
      `SELECT o.id AS order_id, o.created_at, o.region, o.customer_name, o.customer_email,
              o.total_cents, oi.product_id, oi.product_title, oi.qty,
              oi.unit_price_cents, oi.line_total_cents
       FROM orders o
       LEFT JOIN order_items oi ON oi.order_id = o.id
       ${where.replace(/region/g, 'o.region')}
       ORDER BY o.created_at DESC`,
      params
    );
    const rows = result.results || [];
    const csvEscape = (v) => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = [
      'order_id','created_at_iso','region','customer_name','customer_email',
      'order_total_eur','product_id','product_title','qty','unit_price_eur','line_total_eur'
    ];
    const lines = [header.join(',')];
    rows.forEach(r => {
      lines.push([
        r.order_id,
        new Date(r.created_at).toISOString(),
        r.region,
        r.customer_name,
        r.customer_email,
        (r.total_cents / 100).toFixed(2),
        r.product_id,
        r.product_title,
        r.qty,
        r.unit_price_cents != null ? (r.unit_price_cents / 100).toFixed(2) : '',
        r.line_total_cents != null ? (r.line_total_cents / 100).toFixed(2) : ''
      ].map(csvEscape).join(','));
    });
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="orders-${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(lines.join('\n'));
  } catch (err) {
    console.error('Error /admin/export.csv:', err);
    res.status(500).send('Export error: ' + err.message);
  }
});

/* ─────────────────────────── STARTUP VALIDATION ───────────────────────── */
if (!process.env.INTERNAL_PW) {
  console.error('FATAL: INTERNAL_PW is not set in .env — server cannot verify passwords.');
  process.exit(1);
}
if (!process.env.ADMIN_PW) {
  console.error('FATAL: ADMIN_PW is not set in .env — admin dashboard unreachable.');
  process.exit(1);
}
if (process.env.ADMIN_PW === process.env.INTERNAL_PW) {
  console.error('FATAL: ADMIN_PW must differ from INTERNAL_PW — MUSE users would otherwise get admin access.');
  process.exit(1);
}
if ((process.env.QUOTE_SIGNING_SECRET || 'CHANGE_ME') === 'CHANGE_ME') {
  console.warn('WARNING: QUOTE_SIGNING_SECRET is using the default value. Set a strong secret in .env for production.');
}

/* ─────────────────────────── START SERVER ───────────────────────────── */
const PORT = process.env.PORT || 8080;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on 0.0.0.0:${PORT}`);
});
