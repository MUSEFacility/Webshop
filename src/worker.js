// src/worker.js — Cloudflare Worker port of the Express server (server.js).
//
// Static HTML under public/ is served automatically by the Cloudflare Assets
// binding before this Worker runs; only dynamic routes land here.

import { Hono } from 'hono';
import crypto from 'node:crypto';
import { makeDb } from './db.js';
import { sendEmail } from './mail.js';
import adminHtml from '../views/admin.html';

/* ─────────────────────────── Helpers ─────────────────────────── */

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

function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

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

function signToken(secret, obj) {
  const data = Buffer.from(JSON.stringify(obj)).toString('base64url');
  const sig  = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verifyToken(secret, token) {
  const [data, sig] = String(token || '').split('.');
  if (!data || !sig) throw new Error('Malformed token');
  const expected = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  if (sig !== expected) throw new Error('Bad signature');
  return JSON.parse(Buffer.from(data, 'base64url').toString());
}

function readCookie(c, name) {
  const raw = c.req.header('cookie') || '';
  const match = raw.split(';').map(s => s.trim()).find(s => s.startsWith(name + '='));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

const MUSE_AUTH_TTL_MS = 12 * 60 * 60 * 1000;
const ADMIN_AUTH_TTL_MS = 2 * 60 * 60 * 1000;

function buildAuthCookie(name, type, ttlMs, secret) {
  const token = signToken(secret, { type, exp: Date.now() + ttlMs });
  const maxAge = Math.floor(ttlMs / 1000);
  return `${name}=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

function is72hBeforeMidnight(dateISO) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateISO || ''))) return false;
  const midnight = new Date(`${dateISO}T00:00:00`);
  const now = new Date();
  return (midnight - now) >= 72 * 60 * 60 * 1000;
}

/* ──────────────────────── Environment validation ────────────────────────
   Replaces server.js:885–899. Runs once per isolate; throws on bad config
   so Hono returns 500, instead of process.exit which doesn't apply to Workers. */

let envValidated = false;
function validateEnv(env) {
  if (envValidated) return;
  if (!env.INTERNAL_PW) throw new Error('INTERNAL_PW is not set — cannot verify passwords.');
  if (!env.ADMIN_PW) throw new Error('ADMIN_PW is not set — admin dashboard unreachable.');
  if (env.ADMIN_PW === env.INTERNAL_PW) {
    throw new Error('ADMIN_PW must differ from INTERNAL_PW — MUSE users would otherwise get admin access.');
  }
  if (!env.QUOTE_SIGNING_SECRET || env.QUOTE_SIGNING_SECRET === 'CHANGE_ME') {
    console.warn('WARNING: QUOTE_SIGNING_SECRET is missing or default.');
  }
  envValidated = true;
}

/* ──────────────────────── Hono app ──────────────────────── */

const app = new Hono();

app.use('*', async (c, next) => {
  validateEnv(c.env);
  await next();
});

/* ── Middleware: require a valid muse_auth cookie ── */
function requireMuseAuth(c, next) {
  try {
    const raw = readCookie(c, 'muse_auth');
    if (!raw) return c.json({ success: false, error: 'Autenticazione MUSE richiesta.' }, 401);
    const payload = verifyToken(c.env.QUOTE_SIGNING_SECRET, raw);
    if (payload.type !== 'muse-auth' || !payload.exp || payload.exp < Date.now()) {
      return c.json({ success: false, error: 'Sessione MUSE scaduta.' }, 401);
    }
    return next();
  } catch {
    return c.json({ success: false, error: 'Sessione MUSE non valida.' }, 401);
  }
}

function requireAdminAuth(c, next) {
  const wantsHtml = (c.req.header('accept') || '').includes('text/html');
  const fail = (msg) => wantsHtml
    ? c.redirect('/', 302)
    : c.json({ success: false, error: msg }, 401);
  try {
    const raw = readCookie(c, 'admin_auth');
    if (!raw) return fail('Autenticazione admin richiesta.');
    const payload = verifyToken(c.env.QUOTE_SIGNING_SECRET, raw);
    if (payload.type !== 'admin-auth' || !payload.exp || payload.exp < Date.now()) {
      return fail('Sessione admin scaduta.');
    }
    return next();
  } catch {
    return fail('Sessione admin non valida.');
  }
}

/* ── Password gates ── */

// GET /internal -> funnel through the portal (same behaviour as Express)
app.get('/internal', (c) => c.redirect('/', 301));

// POST /internal -> password then serve internal.html
app.post('/internal', async (c) => {
  const body = await c.req.parseBody();
  if (body.password === c.env.INTERNAL_PW) {
    const cookie = buildAuthCookie('muse_auth', 'muse-auth', MUSE_AUTH_TTL_MS, c.env.QUOTE_SIGNING_SECRET);
    const asset = await c.env.ASSETS.fetch(new URL('/internal.html', c.req.url));
    return new Response(asset.body, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': cookie }
    });
  }
  return c.redirect('/internal?error=1', 302);
});

app.post('/api/verify-password', async (c) => {
  const body = await c.req.parseBody();
  const ok = body.password === c.env.INTERNAL_PW;
  if (ok) c.header('Set-Cookie', buildAuthCookie('muse_auth', 'muse-auth', MUSE_AUTH_TTL_MS, c.env.QUOTE_SIGNING_SECRET));
  return c.json({ ok });
});

app.post('/api/verify-admin-password', async (c) => {
  const body = await c.req.parseBody();
  const ok = body.password === c.env.ADMIN_PW;
  if (ok) c.header('Set-Cookie', buildAuthCookie('admin_auth', 'admin-auth', ADMIN_AUTH_TTL_MS, c.env.QUOTE_SIGNING_SECRET));
  return c.json({ ok });
});

app.get('/external', (c) => c.redirect('/', 301));

/* ── Checkout ── */

app.post('/checkout', async (c) => {
  try {
    const body = await c.req.parseBody();
    const { region, name, email, cartJson } = body;
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
    const ccAddress = ccByRegion[region] || c.env.SHOP_CC_EMAIL;

    await sendEmail(c.env, {
      to:      c.env.SHOP_EMAIL,
      cc:      [ccAddress, c.env.ADMIN_CC_EMAIL].filter(Boolean),
      subject: `Ordine ricevuto: ${name}`,
      html:    emailWrap(summaryHtml)
    });

    await sendEmail(c.env, {
      to:      email,
      subject: `Conferma ordine €${total.toFixed(2)}`,
      html:    emailWrap(summaryHtml)
    });

    // Analytics write — D1 via binding. Fire-and-forget with waitUntil so the
    // response returns immediately.
    const db = makeDb(c.env.DB);
    c.executionCtx.waitUntil((async () => {
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
    })());

    return c.json({ success: true });
  } catch (err) {
    console.error('Error in /checkout:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/* ── Cleaning quote ── */

app.post('/cleaning-quote', requireMuseAuth, async (c) => {
  try {
    const body = await c.req.parseBody();
    const { region, name, email, apartmentId, dateISO } = body;

    if (region !== 'Val Gardena' && region !== 'Dolomites') {
      return c.json({ success: false, error: 'Disponibile solo per Val Gardena e Dolomites.' }, 400);
    }
    if (!/^[A-Za-z0-9]{4,5}$/.test(String(apartmentId || ''))) {
      return c.json({ success: false, error: 'ID appartamento non valido.' }, 400);
    }
    if (!is72hBeforeMidnight(dateISO)) {
      return c.json({
        success: false,
        error: 'La data deve essere richiesta 72h prima della mezzanotte del giorno scelto.'
      }, 400);
    }

    const quoteId = crypto.randomUUID();
    const payload = {
      type: 'cleaning-quote',
      quoteId,
      region, name, email,
      apartmentId, dateISO,
      requestedAt: Date.now()
    };
    const token = signToken(c.env.QUOTE_SIGNING_SECRET, payload);
    const decisionURL = `${c.env.APP_BASE_URL}/quote/decision?token=${encodeURIComponent(token)}`;

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

    const db = makeDb(c.env.DB);
    c.executionCtx.waitUntil((async () => {
      try {
        await sendEmail(c.env, {
          to:      c.env.SHOP_EMAIL,
          cc:      ['info@muse.holiday', c.env.ADMIN_CC_EMAIL].filter(Boolean),
          subject: `Richiesta preventivo pulizia — ${name} (${apartmentId})`,
          html:    emailWrap(ownerHtml)
        });
      } catch (e) {
        console.error('Background email error (owner /cleaning-quote):', e.message);
      }

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
        await sendEmail(c.env, {
          to:      email,
          subject: `Richiesta preventivo pulizia ricevuta — ${apartmentId} (${dateISO})`,
          html:    emailWrap(clientHtml)
        });
      } catch (e) {
        console.error('Background email error (client /cleaning-quote):', e.message);
      }

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
    })());

    const includeLink = String(c.env.EXPOSE_DECISION_URL).toLowerCase() === 'true'
      || String(c.req.query('debug') || '').toLowerCase() === '1';
    return c.json(includeLink ? { success: true, decisionURL } : { success: true });
  } catch (err) {
    console.error('Error /cleaning-quote:', err);
    return c.json({ success: false, error: 'Errore interno' }, 500);
  }
});

app.get('/quote/decision', (c) => {
  try {
    const token = c.req.query('token');
    const data = verifyToken(c.env.QUOTE_SIGNING_SECRET, token);
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
    return c.html(html);
  } catch {
    return c.text('Link non valido o scaduto.', 400);
  }
});

async function sendQuoteDecisionEmails(env, { name, email, apartmentId, dateISO, action, price }) {
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
    await sendEmail(env, {
      to:      email,
      subject: `Preventivo pulizia ACCETTATO — ${apartmentId} (${dateISO})`,
      html:    emailWrap(html)
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
    await sendEmail(env, {
      to:      email,
      subject: `Preventivo pulizia RIFIUTATO — ${apartmentId} (${dateISO})`,
      html:    emailWrap(html)
    });
  }

  await sendEmail(env, {
    to:      env.SHOP_EMAIL,
    subject: `Decisione inviata — ${String(action).toUpperCase()} — ${apartmentId} (${dateISO})`,
    html:    emailWrap(`<p>Decisione: <strong>${esc(action)}</strong> ${price ? `— Prezzo €${price.toFixed(2)}` : ''}<br/>
           Cliente: ${esc(name)} &lt;${esc(email)}&gt;</p>`)
  });
}

function persistQuoteDecision(db, ctx, { quoteId, action, price }) {
  ctx.waitUntil((async () => {
    if (!quoteId) return;
    try {
      const status = action === 'accept' ? 'accepted' : 'denied';
      const priceCents = action === 'accept' ? Math.round(price * 100) : null;
      await db.query(
        `UPDATE cleaning_quotes SET status = ?, quoted_price_cents = ?, decided_at = ? WHERE id = ?`,
        [status, priceCents, Date.now(), quoteId]
      );
    } catch (e) {
      console.error('D1 update failed (quote decision):', e.message);
    }
  })());
}

app.post('/quote/decision', async (c) => {
  try {
    const body = await c.req.parseBody();
    const { token, action } = body;
    const price = body.price ? Number(body.price) : undefined;
    const data = verifyToken(c.env.QUOTE_SIGNING_SECRET, token);
    if (data.type !== 'cleaning-quote') throw new Error('Bad type');

    if (action === 'accept' && !(price >= 0)) {
      return c.text('Inserisci un prezzo valido per accettare.', 400);
    }

    await sendQuoteDecisionEmails(c.env, {
      name: data.name,
      email: data.email,
      apartmentId: data.apartmentId,
      dateISO: data.dateISO,
      action,
      price
    });

    persistQuoteDecision(makeDb(c.env.DB), c.executionCtx, {
      quoteId: data.quoteId,
      action,
      price
    });

    return c.text('Decisione inviata con successo. Puoi chiudere questa pagina.');
  } catch (e) {
    console.error('Error /quote/decision:', e);
    return c.text('Errore nella decisione.', 400);
  }
});

/* ── Email previews (dev/QA only) ── */

function previewsEnabled(c) {
  return String(c.env.ENABLE_EMAIL_PREVIEWS).toLowerCase() === 'true';
}

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

app.get('/debug/preview/order', (c) => {
  if (!previewsEnabled(c)) return c.text('Email previews disabled', 404);
  const name   = c.req.query('name')   || 'Mario Rossi';
  const email  = c.req.query('email')  || 'mario.rossi@example.com';
  const region = c.req.query('region') || 'Val Gardena';
  let cart = [
    { title: 'ASCIUGAMANO BAGNO 100x150', qty: 2, price: 9.77 },
    { title: 'LENZUOLO 2P 240x300', qty: 1, price: 23.53 }
  ];
  if (c.req.query('cart_b64')) {
    try {
      cart = JSON.parse(Buffer.from(c.req.query('cart_b64'), 'base64url').toString());
    } catch (_) {}
  }
  return c.html(emailWrap(renderOrderEmail({ name, email, region, cart })));
});

app.get('/debug/preview/cleaning-owner', (c) => {
  if (!previewsEnabled(c)) return c.text('Email previews disabled', 404);
  const name = c.req.query('name') || 'Mario Rossi';
  const email = c.req.query('email') || 'mario.rossi@example.com';
  const apt = c.req.query('apt') || '1234A';
  const date = c.req.query('date') || '2025-11-05';
  const link = c.req.query('link') || `${c.env.APP_BASE_URL}/quote/decision?token=TEST_TOKEN`;
  const html = `
    <h2 style="margin:0 0 16px;font-size:20px;color:#2d5016;">Nuova richiesta preventivo pulizia</h2>
    <div style="background:#f8f5f0;border-radius:8px;padding:14px 16px;margin-bottom:16px;font-size:14px;line-height:1.8;">
      <strong>Cliente:</strong> ${esc(name)} &lt;${esc(email)}&gt;<br/>
      <strong>Appartamento:</strong> ${esc(apt)}<br/>
      <strong>Data pulizia:</strong> ${esc(date)}
    </div>
    <p style="font-size:14px;">Apri per <strong>Accettare</strong> o <strong>Rifiutare</strong> e inserire il prezzo:</p>
    <p><a href="${link}" style="display:inline-block;padding:10px 24px;background:#2d5016;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;font-size:14px;">Gestisci richiesta &rarr;</a></p>`;
  return c.html(emailWrap(html));
});

app.get('/debug/preview/cleaning-client', (c) => {
  if (!previewsEnabled(c)) return c.text('Email previews disabled', 404);
  const name = c.req.query('name') || 'Mario Rossi';
  const apt  = c.req.query('apt')  || '1234A';
  const date = c.req.query('date') || '2025-11-05';
  const html = `
    <h2 style="margin:0 0 12px;font-size:20px;color:#2d5016;">Richiesta preventivo inviata</h2>
    <p style="font-size:14px;line-height:1.6;">Grazie <strong>${esc(name)}</strong>, abbiamo ricevuto la tua richiesta per la pulizia
    dell'appartamento <strong>${esc(apt)}</strong> il giorno <strong>${esc(date)}</strong>.</p>
    <div style="background:#fef6e0;border-left:4px solid #e2a300;padding:12px 16px;border-radius:0 8px 8px 0;margin:16px 0;font-size:13px;">
      <strong>Importante:</strong> questa è solo una richiesta. Conferma solo dopo risposta scritta MUSE.holiday.
    </div>`;
  return c.html(emailWrap(html));
});

app.get('/debug/preview/decision-accept', (c) => {
  if (!previewsEnabled(c)) return c.text('Email previews disabled', 404);
  const name  = c.req.query('name')  || 'Mario Rossi';
  const apt   = c.req.query('apt')   || '1234A';
  const date  = c.req.query('date')  || '2025-11-05';
  const price = Number(c.req.query('price') || '80');
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
  return c.html(emailWrap(html));
});

app.get('/debug/preview/decision-deny', (c) => {
  if (!previewsEnabled(c)) return c.text('Email previews disabled', 404);
  const name = c.req.query('name') || 'Mario Rossi';
  const apt  = c.req.query('apt')  || '1234A';
  const date = c.req.query('date') || '2025-11-05';
  const html = `
    <div style="background:#fef5f5;border-left:4px solid #9b2626;padding:14px 16px;border-radius:0 8px 8px 0;margin-bottom:16px;">
      <h2 style="margin:0 0 8px;font-size:20px;color:#9b2626;">Preventivo rifiutato</h2>
      <p style="margin:0;font-size:14px;">Appartamento <strong>${esc(apt)}</strong> &mdash; ${esc(date)}</p>
    </div>
    <p style="font-size:14px;">Ciao <strong>${esc(name)}</strong>, la tua richiesta è stata rifiutata.</p>
    <p style="font-size:13px;color:#666;">Se vuoi, invia una nuova richiesta con un'altra data.</p>`;
  return c.html(emailWrap(html));
});

/* ── Admin ── */

app.get('/admin', requireAdminAuth, (c) => c.html(adminHtml));

function buildDateRangeClause(c, column = 'created_at') {
  const where = [];
  const params = [];
  const from = String(c.req.query('from') || '').trim();
  const to   = String(c.req.query('to')   || '').trim();
  const region = String(c.req.query('region') || '').trim();
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
  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}

app.get('/admin/api/stats', requireAdminAuth, async (c) => {
  try {
    const db = makeDb(c.env.DB);
    const { sql: ordersWhere, params: ordersParams } = buildDateRangeClause(c);
    const { sql: quotesWhere, params: quotesParams } = buildDateRangeClause(c);

    const summary = await db.query(
      `SELECT COUNT(*) AS total_orders,
              COALESCE(SUM(total_cents),0) AS total_revenue_cents,
              COALESCE(SUM(item_count),0) AS total_items,
              COALESCE(AVG(total_cents),0) AS avg_order_cents
       FROM orders ${ordersWhere}`,
      ordersParams
    );

    const quotesSummary = await db.query(
      `SELECT
         SUM(CASE WHEN status='pending'  THEN 1 ELSE 0 END) AS pending_quotes,
         SUM(CASE WHEN status='accepted' THEN 1 ELSE 0 END) AS accepted_quotes,
         SUM(CASE WHEN status='denied'   THEN 1 ELSE 0 END) AS denied_quotes,
         COALESCE(SUM(CASE WHEN status='accepted' THEN quoted_price_cents ELSE 0 END),0) AS accepted_revenue_cents
       FROM cleaning_quotes ${quotesWhere}`,
      quotesParams
    );

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

    const byRegion = await db.query(
      `SELECT region, COUNT(*) AS order_count, SUM(total_cents) AS total_revenue_cents
       FROM orders ${ordersWhere}
       GROUP BY region
       ORDER BY total_revenue_cents DESC`,
      ordersParams
    );

    const recentOrders = await db.query(
      `SELECT id, created_at, region, customer_name, customer_email, total_cents, item_count
       FROM orders ${ordersWhere}
       ORDER BY created_at DESC
       LIMIT 50`,
      ordersParams
    );

    const recentQuotes = await db.query(
      `SELECT id, created_at, region, requester_name, requester_email, apartment_id,
              requested_date, status, quoted_price_cents, decided_at
       FROM cleaning_quotes ${quotesWhere}
       ORDER BY created_at DESC
       LIMIT 50`,
      quotesParams
    );

    return c.json({
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
    return c.json({ success: false, error: err.message }, 500);
  }
});

app.post('/admin/api/quote-decide', requireAdminAuth, async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { quoteId, decision } = body;
    if (!quoteId || (decision !== 'accept' && decision !== 'deny')) {
      return c.json({ success: false, error: 'Parametri non validi.' }, 400);
    }
    let price;
    if (decision === 'accept') {
      const priceCents = Number(body.priceCents);
      if (!Number.isFinite(priceCents) || priceCents < 0) {
        return c.json({ success: false, error: 'Prezzo non valido.' }, 400);
      }
      price = priceCents / 100;
    }

    const db = makeDb(c.env.DB);
    const lookup = await db.query(
      `SELECT id, requester_name, requester_email, apartment_id, requested_date, status
       FROM cleaning_quotes WHERE id = ? LIMIT 1`,
      [quoteId]
    );
    const row = (lookup.results || [])[0];
    if (!row) return c.json({ success: false, error: 'Preventivo non trovato.' }, 404);
    if (row.status !== 'pending') {
      return c.json({ success: false, error: `Preventivo già ${row.status}.` }, 409);
    }

    await sendQuoteDecisionEmails(c.env, {
      name: row.requester_name,
      email: row.requester_email,
      apartmentId: row.apartment_id,
      dateISO: row.requested_date,
      action: decision,
      price
    });

    persistQuoteDecision(db, c.executionCtx, { quoteId, action: decision, price });

    return c.json({ success: true });
  } catch (err) {
    console.error('Error /admin/api/quote-decide:', err);
    return c.json({ success: false, error: err.message }, 500);
  }
});

app.get('/admin/export-orders.csv', requireAdminAuth, async (c) => {
  try {
    const db = makeDb(c.env.DB);
    const { sql: where, params } = buildDateRangeClause(c, 'o.created_at');
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

    return new Response(lines.join('\n'), {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="orders-pivot-${new Date().toISOString().slice(0,10)}.csv"`
      }
    });
  } catch (err) {
    console.error('Error /admin/export-orders.csv:', err);
    return c.text('Export error: ' + err.message, 500);
  }
});

app.get('/admin/export.csv', requireAdminAuth, async (c) => {
  try {
    const db = makeDb(c.env.DB);
    const { sql: where, params } = buildDateRangeClause(c, 'o.created_at');
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
    return new Response(lines.join('\n'), {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="orders-${new Date().toISOString().slice(0,10)}.csv"`
      }
    });
  } catch (err) {
    console.error('Error /admin/export.csv:', err);
    return c.text('Export error: ' + err.message, 500);
  }
});

export default app;
