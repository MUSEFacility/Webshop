// server.js
require('dotenv').config();
const express    = require('express');
const bodyParser = require('body-parser');
const nodemailer = require('nodemailer');
const path       = require('path');

const app = express();

// ─── SMTP SETUP ───────────────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST,
  port:   Number(process.env.SMTP_PORT),
  secure: process.env.SMTP_PORT === '465',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

// ─── MIDDLEWARE ────────────────────────────────────────────────────────────────
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── LANDING PAGE ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  // serves public/index.html
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── INTERNAL (PASSWORD‐GATED) ─────────────────────────────────────────────────
app.get('/internal', (req, res) => {
  // serve the login form
  res.sendFile(path.join(__dirname, 'public', 'internal-login.html'));
});

app.post('/internal', (req, res) => {
  const entered = req.body.password;
  if (entered === process.env.INTERNAL_PW) {
    // correct password → show internal shop
    res.sendFile(path.join(__dirname, 'public', 'internal.html'));
  } else {
    // wrong → back to login with error flag
    res.redirect('/internal?error=1');
  }
});

// ─── EXTERNAL SHOP ─────────────────────────────────────────────────────────────
app.get('/external', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'external.html'));
});

// ─── CHECKOUT ENDPOINT ─────────────────────────────────────────────────────────
app.post('/checkout', async (req, res) => {
  try {
    const { region, name, email, cartJson } = req.body;
    const cart = JSON.parse(cartJson);

    // Build HTML summary
    let total = 0;
    let summaryHtml = `
      <h2>Nuovo ordine da ${name}</h2>
      <p><strong>Regione:</strong> ${region}</p>
      <p><em>Prezzi sempre mostrati IVA esclusa.</em></p>
      <ul>`;
    cart.forEach(item => {
      summaryHtml += `<li>${item.title} × ${item.qty} @ €${item.price.toFixed(2)}</li>`;
      total += item.qty * item.price;
    });
    summaryHtml += `
      </ul>
      <p><strong>Totale: €${total.toFixed(2)}</strong></p>
      <p><em>Pagamento: nessuno richiesto ora – verrà fatturato.</em></p>
      <hr/>
      <p><strong>Nome cliente:</strong> ${name}</p>
      <p><strong>Email cliente:</strong> ${email}</p>`;

    // Map regions to CC addresses
    const ccByRegion = {
      Dolomites:     'info@muse.holiday',
      'South Tyrol': 'suedtirol@muse.holiday',
      Garda:         'garda@muse.holiday'
    };
    const ccAddress = ccByRegion[region] || process.env.SHOP_CC_EMAIL;

    // 1) Email to shop owner (with CC)
    await transporter.sendMail({
      from:    `"MUSE.holiday Shop" <${process.env.SMTP_USER}>`,
      to:      process.env.SHOP_EMAIL,
      cc:      ccAddress,
      subject: `Ordine ricevuto: ${name}`,
      html:    summaryHtml
    });

    // 2) Confirmation to buyer
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

// ─── START SERVER ───────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
