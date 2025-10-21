// server.js
require('dotenv').config();
const express    = require('express');
const bodyParser = require('body-parser');
const nodemailer = require('nodemailer');
const path       = require('path');
const crypto     = require('crypto');

const app = express();

/* ────────────────────────── DOMAIN REDIRECTS ──────────────────────────
   Redirect www.musevision.it and *.fly.dev → https://musevision.it
   (Place before other routes) */
app.use((req, res, next) => {
  const host = (req.hostname || '').toLowerCase();
  if (host === 'www.musevision.it') {
    return res.redirect(301, 'https://musevision.it' + req.originalUrl);
  }
  if (host.endsWith('.fly.dev')) {
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
      <h2>Nuovo ordine da ${name}</h2>
      <p><strong>Regione:</strong> ${region}</p>
      <p><em>Prezzi sempre mostrati IVA esclusa.</em></p>
      <ul>`;
    cart.forEach(item => {
      const price = Number(item.price) || 0;
      summaryHtml += `<li>${item.title} × ${item.qty} @ €${price.toFixed(2)}</li>`;
      total += item.qty * price;
    });
    summaryHtml += `
      </ul>
      <p><strong>Totale: €${total.toFixed(2)}</strong></p>
      <p><em>Pagamento: nessuno richiesto ora – verrà fatturato.</em></p>
      <hr/>
      <p><strong>Nome cliente:</strong> ${name}</p>
      <p><strong>Email cliente:</strong> ${email}</p>`;

    const ccByRegion = {
      Dolomites:     'info@muse.holiday',
      'South Tyrol': 'suedtirol@muse.holiday',
      Garda:         'garda@muse.holiday',
      'Val Gardena': 'suedtirol@muse.holiday'
    };
    const ccAddress = ccByRegion[region] || process.env.SHOP_CC_EMAIL;

    await transporter.sendMail({
      from:    `"MUSE.holiday Shop" <${process.env.SMTP_USER}>`,
      to:      process.env.SHOP_EMAIL,
      cc:      ccAddress,
      subject: `Ordine ricevuto: ${name}`,
      html:    summaryHtml
    });

    await transporter.sendMail({
      from:    `"MUSE.holiday Shop" <${process.env.SMTP_USER}>`,
      to:      email,
      subject: `Conferma ordine €${total.toFixed(2)}`,
      html:    summaryHtml
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
    if (region !== 'Val Gardena') {
      return res.status(400).json({ success: false, error: 'Disponibile solo per Val Gardena.' });
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
      <h2>Nuova richiesta preventivo pulizia (Val Gardena)</h2>
      <p><strong>Cliente:</strong> ${name} &lt;${email}&gt;</p>
      <p><strong>Appartamento:</strong> ${apartmentId}</p>
      <p><strong>Data richiesta pulizia:</strong> ${dateISO}</p>
      <p>Apri per <strong>Accettare</strong> o <strong>Rifiutare</strong> e inserire il prezzo:</p>
      <p><a href="${decisionURL}">${decisionURL}</a></p>
    `;

    // Send emails in background so API can return quickly
    setImmediate(async () => {
      try {
        await transporter.sendMail({
          from: `"MUSE.holiday Shop" <${process.env.SMTP_USER}>`,
          to:   process.env.SHOP_EMAIL,
          cc:   'suedtirol@muse.holiday',
          subject: `Richiesta preventivo pulizia — ${name} (${apartmentId})`,
          html: ownerHtml
        });
      } catch (e) {
        console.error('Background email error (owner /cleaning-quote):', e);
      }

      // Email requester (with disclaimers incl. linen not included)
      const clientHtml = `
        <h2>Richiesta preventivo inviata</h2>
        <p>Grazie ${name}, abbiamo ricevuto la tua richiesta per la pulizia dell'appartamento
        <strong>${apartmentId}</strong> il giorno <strong>${dateISO}</strong>.</p>
        <p><strong>Importante:</strong> questa è <em>solo</em> una richiesta; la pulizia verrà programmata
        esclusivamente dopo una <strong>conferma scritta da MUSE.holiday</strong>.</p>
        <p style="color:#b00020"><strong>Nota:</strong> la pulizia <u>NON</u> include biancheria/lavanderia;
        la fornitura o il ritiro della biancheria va ordinata separatamente nel carrello.</p>
      `;
      try {
        await transporter.sendMail({
          from: `"MUSE.holiday Shop" <${process.env.SMTP_USER}>`,
          to:   email,
          subject: `Richiesta preventivo pulizia ricevuta — ${apartmentId} (${dateISO})`,
          html: clientHtml
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
          <div><strong>Cliente:</strong> ${data.name} &lt;${data.email}&gt;</div>
          <div><strong>Appartamento:</strong> ${data.apartmentId}</div>
          <div><strong>Data pulizia richiesta:</strong> ${data.dateISO}</div>
          <div><strong>Regione:</strong> ${data.region}</div>
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
        <h2>Preventivo accettato</h2>
        <p>Ciao ${data.name}, la tua richiesta per la pulizia dell'appartamento <strong>${data.apartmentId}</strong>
        in data <strong>${data.dateISO}</strong> è stata <strong>ACCETTATA</strong>.</p>
        <p><strong>Prezzo:</strong> €${price.toFixed(2)} (IVA esclusa, salvo diverse indicazioni)</p>
        <p style="color:#b00020"><strong>Nota:</strong> la pulizia <u>NON</u> include biancheria/lavanderia; la fornitura o il ritiro
        della biancheria va ordinata separatamente nel carrello.</p>
        <p>Questa email costituisce <strong>conferma scritta</strong> della prenotazione.</p>
      `;
      await transporter.sendMail({
        from: `"MUSE.holiday Shop" <${process.env.SMTP_USER}>`,
        to:   data.email,
        subject: `Preventivo pulizia ACCETTATO — ${data.apartmentId} (${data.dateISO})`,
        html
      });
    } else {
      const html = `
        <h2>Preventivo rifiutato</h2>
        <p>Ciao ${data.name}, la tua richiesta per la pulizia dell'appartamento <strong>${data.apartmentId}</strong>
        in data <strong>${data.dateISO}</strong> è stata <strong>RIFIUTATA</strong>.</p>
        <p><em>Nota:</em> l’invio della richiesta non implica conferma del servizio.</p>
        <p style="color:#b00020"><strong>Nota:</strong> la pulizia <u>NON</u> include biancheria/lavanderia.</p>
        <p>Se vuoi, invia una nuova richiesta con un'altra data.</p>
      `;
      await transporter.sendMail({
        from: `"MUSE.holiday Shop" <${process.env.SMTP_USER}>`,
        to:   data.email,
        subject: `Preventivo pulizia RIFIUTATO — ${data.apartmentId} (${data.dateISO})`,
        html
      });
    }

    // Notify owner (thread)
    await transporter.sendMail({
      from: `"MUSE.holiday Shop" <${process.env.SMTP_USER}>`,
      to:   process.env.SHOP_EMAIL,
      subject: `Decisione inviata — ${String(action).toUpperCase()} — ${data.apartmentId} (${data.dateISO})`,
      html: `<p>Decisione: <strong>${action}</strong> ${price ? `— Prezzo €${price.toFixed(2)}` : ''}<br/>
             Cliente: ${data.name} &lt;${data.email}&gt;</p>`
    });

    res.send('Decisione inviata con successo. Puoi chiudere questa pagina.');
  } catch (e) {
    console.error('Error /quote/decision:', e);
    res.status(400).send('Errore nella decisione.');
  }
});

/* ─────────────────────────── START SERVER ───────────────────────────── */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
