// server.js
require('dotenv').config();
const express    = require('express');
const bodyParser = require('body-parser');
const nodemailer = require('nodemailer');
const path       = require('path');

const app = express();

// ─── Configure SMTP via env vars ─────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST,                    // e.g. "smtp.gmail.com"
  port:   Number(process.env.SMTP_PORT),            // 587 or 465
  secure: process.env.SMTP_PORT === '465',          // true for 465, false otherwise
  auth: {
    user: process.env.SMTP_USER,                    // your shop email
    pass: process.env.SMTP_PASS                     // your SMTP password/app-password
  }
});

// ─── Express setup ───────────────────────────────────────────────────────────
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Serve the default front-end (could be a selector or external)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Serve the internal shop page
app.get('/internal', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'internal.html'));
});

// Serve the external shop page
app.get('/external', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'external.html'));
});

// ─── Checkout endpoint ────────────────────────────────────────────────────────
app.post('/checkout', async (req, res) => {
  try {
    // now reading region as well
    const { region, name, email, cartJson } = req.body;
    const cart = JSON.parse(cartJson);

    // Build the HTML summary
    let total = 0;
    let summaryHtml = `
      <h2>Nuovo ordine da ${name}</h2>
      <p><strong>Regione:</strong> ${region}</p>
      <p><em>Prezzi sempre mostrati IVA esclusa.</em></p>
      <ul>`;
    cart.forEach(item => {
      summaryHtml += `
        <li>${item.title} × ${item.qty} @ €${item.price.toFixed(2)}</li>`;
      total += item.qty * item.price;
    });
    summaryHtml += `
      </ul>
      <p><strong>Totale: €${total.toFixed(2)}</strong></p>
      <p><em>Pagamento: nessuno richiesto ora – verrà fatturato.</em></p>
      <hr/>
      <p><strong>Nome cliente:</strong> ${name}</p>
      <p><strong>Email cliente:</strong> ${email}</p>
    `;

    // Map regions to their CC addresses
    const ccByRegion = {
      Dolomites:    'info@muse.holiday',
      'South Tyrol':'suedtirol@muse.holiday',
      Garda:        'garda@muse.holiday'
    };
    const ccAddress = ccByRegion[region] || process.env.SHOP_CC_EMAIL;

    // 1) Notify the shop owner with region-specific CC
    const infoOwner = await transporter.sendMail({
      from:    `"MUSE.holiday Shop" <${process.env.SMTP_USER}>`,
      to:      process.env.SHOP_EMAIL,
      cc:      ccAddress,
      subject: `Ordine ricevuto: ${name}`,
      html:    summaryHtml
    });
    console.log('STORE Preview URL:', nodemailer.getTestMessageUrl(infoOwner));

    // 2) Confirmation to buyer
    const buyerSubject = `Conferma ordine €${total.toFixed(2)}`;
    const infoBuyer = await transporter.sendMail({
      from:    `"MUSE.holiday Shop" <${process.env.SMTP_USER}>`,
      to:      email,
      subject: buyerSubject,
      html:    summaryHtml
    });
    console.log('BUYER Preview URL:', nodemailer.getTestMessageUrl(infoBuyer));

    res.json({ success: true });
  } catch (err) {
    console.error('Error in /checkout:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ─── Start server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
