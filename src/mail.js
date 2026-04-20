// src/mail.js — Resend HTTP helper. Replaces Nodemailer/SMTP.
//
// Workers cannot open raw TCP to SMTP, so we POST to Resend's REST API.

export async function sendEmail(env, { to, cc, subject, html, from }) {
  const sender = from || env.MAIL_FROM;
  if (!env.RESEND_API_KEY) throw new Error('RESEND_API_KEY not configured');
  if (!sender) throw new Error('MAIL_FROM not configured');

  const body = { from: sender, to: Array.isArray(to) ? to : [to], subject, html };
  if (cc) body.cc = Array.isArray(cc) ? cc : [cc];

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Resend send failed: HTTP ${res.status} ${text}`);
  }
  return res.json();
}
