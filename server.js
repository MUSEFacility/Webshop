// User submits quote request (returns immediately; emails sent in background)
app.post('/cleaning-quote', (req, res) => {
  try {
    const { region, name, email, apartmentId, dateISO } = req.body;

    // Eligibility: region Val Gardena — enforce here
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

    // Build decision link payload
    const payload = {
      type: 'cleaning-quote',
      region, name, email,
      apartmentId, dateISO,
      requestedAt: Date.now()
    };
    const token = signToken(payload);
    const decisionURL = `${BASE_URL}/quote/decision?token=${encodeURIComponent(token)}`;

    // ⚡️ Respond to the browser immediately
    res.json({ success: true });

    // 📧 Continue in the background (no await)
    setImmediate(async () => {
      try {
        // Email owner (you)
        const ownerHtml = `
          <h2>Nuova richiesta preventivo pulizia (Val Gardena)</h2>
          <p><strong>Cliente:</strong> ${name} &lt;${email}&gt;</p>
          <p><strong>Appartamento:</strong> ${apartmentId}</p>
          <p><strong>Data richiesta pulizia:</strong> ${dateISO}</p>
          <p>Apri per <strong>Accettare</strong> o <strong>Rifiutare</strong> e inserire il prezzo:</p>
          <p><a href="${decisionURL}">${decisionURL}</a></p>
        `;
        await transporter.sendMail({
          from: `"MUSE.holiday Shop" <${process.env.SMTP_USER}>`,
          to:   process.env.SHOP_EMAIL,
          cc:   'suedtirol@muse.holiday',
          subject: `Richiesta preventivo pulizia — ${name} (${apartmentId})`,
          html: ownerHtml
        });

        // Email requester (disclaimer: request ≠ confirmation)
        const clientHtml = `
          <h2>Richiesta preventivo inviata</h2>
          <p>Grazie ${name}, abbiamo ricevuto la tua richiesta per la pulizia dell'appartamento
          <strong>${apartmentId}</strong> il giorno <strong>${dateISO}</strong>.</p>
          <p><strong>Importante:</strong> questa è <em>solo</em> una richiesta; la pulizia verrà programmata
          esclusivamente dopo una <strong>conferma scritta da MUSE.holiday</strong>.</p>
          <p>Riceverai una risposta con accettazione o rifiuto (ed eventuale prezzo) appena possibile.</p>
        `;
        await transporter.sendMail({
          from: `"MUSE.holiday Shop" <${process.env.SMTP_USER}>`,
          to:   email,
          subject: `Richiesta preventivo pulizia ricevuta — ${apartmentId} (${dateISO})`,
          html: clientHtml
        });
      } catch (err) {
        console.error('Background email error (/cleaning-quote):', err);
      }
    });
  } catch (err) {
    console.error('Error /cleaning-quote:', err);
    // If we reach here before res.json above, send error. Otherwise, just log.
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: 'Errore interno' });
    }
  }
});
