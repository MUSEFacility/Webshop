// server.js
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express    = require('express');
const bodyParser = require('body-parser');
const nodemailer = require('nodemailer');
const path       = require('path');
const crypto     = require('crypto');

const app = express();

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
app.use(express.static(path.join(__dirname, 'public')));

/* ─────────────────────────────── ROUTES ─────────────────────────────── */

// Landing
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Internal (password gated)
app.get('/internal', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'internal-login.html'));
});

app.post('/internal', (req, res) => {
  const entered = req.body.password;
  if (entered === process.env.INTERNAL_PW) {
    res.sendFile(path.join(__dirname, 'public', 'internal.html'));
  } else {
    res.redirect('/internal?error=1');
  }
});

// Password verification for SPA
app.post('/api/verify-password', (req, res) => {
  const entered = req.body.password;
  res.json({ ok: entered === process.env.INTERNAL_PW });
});

// External shop
app.get('/external', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'external.html'));
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
      cc:      ccAddress,
      subject: `Ordine ricevuto: ${name}`,
      html:    emailWrap(summaryHtml)
    });

    await transporter.sendMail({
      from:    `"MUSE.holiday Shop" <${process.env.SMTP_USER}>`,
      to:      email,
      subject: `Conferma ordine €${total.toFixed(2)}`,
      html:    emailWrap(summaryHtml)
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
app.post('/cleaning-quote', async (req, res) => {
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

    // Build decision link
    const payload = {
      type: 'cleaning-quote',
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
          cc:   'info@muse.holiday',
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

    if (action === 'accept') {
      const html = `
        <div style="background:#f4faf6;border-left:4px solid #1f6640;padding:14px 16px;border-radius:0 8px 8px 0;margin-bottom:16px;">
          <h2 style="margin:0 0 8px;font-size:20px;color:#1f6640;">Preventivo accettato ✓</h2>
          <p style="margin:0;font-size:14px;">Appartamento <strong>${esc(data.apartmentId)}</strong> &mdash; ${esc(data.dateISO)}</p>
        </div>
        <p style="font-size:14px;line-height:1.6;">Ciao <strong>${esc(data.name)}</strong>, la tua richiesta è stata <strong>ACCETTATA</strong>.</p>
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
        to:   data.email,
        subject: `Preventivo pulizia ACCETTATO — ${data.apartmentId} (${data.dateISO})`,
        html: emailWrap(html)
      });
    } else {
      const html = `
        <div style="background:#fef5f5;border-left:4px solid #9b2626;padding:14px 16px;border-radius:0 8px 8px 0;margin-bottom:16px;">
          <h2 style="margin:0 0 8px;font-size:20px;color:#9b2626;">Preventivo rifiutato</h2>
          <p style="margin:0;font-size:14px;">Appartamento <strong>${esc(data.apartmentId)}</strong> &mdash; ${esc(data.dateISO)}</p>
        </div>
        <p style="font-size:14px;line-height:1.6;">Ciao <strong>${esc(data.name)}</strong>, la tua richiesta è stata <strong>RIFIUTATA</strong>.</p>
        <p style="font-size:13px;color:#666;line-height:1.6;">L'invio della richiesta non implica conferma del servizio. Se vuoi, invia una nuova richiesta con un'altra data.</p>
      `;
      await transporter.sendMail({
        from: `"MUSE.holiday Shop" <${process.env.SMTP_USER}>`,
        to:   data.email,
        subject: `Preventivo pulizia RIFIUTATO — ${data.apartmentId} (${data.dateISO})`,
        html: emailWrap(html)
      });
    }

    // Notify owner (thread)
    await transporter.sendMail({
      from: `"MUSE.holiday Shop" <${process.env.SMTP_USER}>`,
      to:   process.env.SHOP_EMAIL,
      subject: `Decisione inviata — ${String(action).toUpperCase()} — ${data.apartmentId} (${data.dateISO})`,
      html: emailWrap(`<p>Decisione: <strong>${esc(action)}</strong> ${price ? `— Prezzo €${price.toFixed(2)}` : ''}<br/>
             Cliente: ${esc(data.name)} &lt;${esc(data.email)}&gt;</p>`)
    });

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

/* ─────────────────────────── STARTUP VALIDATION ───────────────────────── */
if (!process.env.INTERNAL_PW) {
  console.error('FATAL: INTERNAL_PW is not set in .env — server cannot verify passwords.');
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
