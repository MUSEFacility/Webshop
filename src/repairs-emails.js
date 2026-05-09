// src/repairs-emails.js — bilingual templates for the two repairs emails.
//
// Footer + body HTML lifted byte-for-byte from the n8n "Build HTML + footer"
// code nodes in n8n/new subtask created (6).json and
// n8n/Reminder – 72h (72h capped) (5).json. The only deliberate change is
// the magic-link host: `www.musevision.it` → `www.muse.services` (canonical
// since PR #22).

const FOOTER = `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="border-collapse:collapse;margin:0 auto;">
  <tr>
    <td style="padding:0 12px 0 0;">
      <a href="https://www.instagram.com/muse.holiday/" target="_blank">
        <img src="https://cdn.muse.holiday/instagram-blue_3x.png" width="24" height="24" border="0" style="display:block;">
      </a>
    </td>
    <td style="padding:0 12px 0 0;">
      <a href="https://www.facebook.com/muse.holiday/" target="_blank">
        <img src="https://cdn.muse.holiday/facebook-blue_3x.png" width="24" height="24" border="0" style="display:block;">
      </a>
    </td>
    <td style="padding:0 12px 0 0;">
      <a href="https://tiktok.com/@muse.holiday/" target="_blank">
        <img src="https://cdn.muse.holiday/tiktok-blue_3x.png" width="24" height="24" border="0" style="display:block;">
      </a>
    </td>
    <td style="padding:0 12px 0 0;">
      <a href="https://wa.me/390471786250" target="_blank">
        <img src="https://cdn.muse.holiday/whatsapp-blue_3x.png" width="24" height="24" border="0" style="display:block;">
      </a>
    </td>
    <td>
      <a href="https://www.iata.org/" target="_blank">
        <img src="https://cdn.muse.holiday/iata-blue_3x.png" width="24" height="24" border="0" style="display:block;">
      </a>
    </td>
  </tr>
</table>

<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;margin:18px 0 0 0;">
  <tr>
    <td align="center" style="padding:18px 0 0 0;">
      <img src="https://cdn.muse.holiday/logo.png?w=130&amp;h=80" width="130" height="80" border="0" style="display:block;margin:0 auto;">
    </td>
  </tr>
  <tr>
    <td align="center" style="padding:12px 0 0 0;font-family:Helvetica, Arial, sans-serif;font-size:14px;line-height:20px;color:#033A53;">
      <div style="font-weight:700;">Apartment4holiday Srl</div>
      <div>IT02875780211</div>
      <div>IATA TIDS 96191852</div>
    </td>
  </tr>
</table>
`;

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function magicLink(token) {
  return `https://www.muse.services/?token=${encodeURIComponent(token)}`;
}

function listHtml(subtaskNames) {
  if (!subtaskNames.length) return '';
  return `<ul style="margin:10px 0 16px 18px;padding:0;">${subtaskNames
    .map((n) => `<li>${esc(n)}</li>`)
    .join('')}</ul>`;
}

export function newSubtaskSubject(appNumber) {
  return `Neuer Reparaturauftrag ${appNumber ? `(${appNumber})` : ''} | Nuova richiesta di riparazione`;
}

export function reminderSubject(appNumber) {
  return `Erinnerung ${appNumber ? `(${appNumber}) ` : ''}: Reparaturauftrag noch offen | Promemoria ${appNumber ? `(${appNumber}) ` : ''}: richiesta ancora aperta`;
}

export function renderNewSubtaskEmail({ token, subtaskNames }) {
  const link = magicLink(token);
  const list = listHtml(subtaskNames);
  return `
<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#ffffff;">
    <div style="font-family:Helvetica, Arial, sans-serif;padding:24px;font-size:14px;line-height:20px;color:#111111;">

      <p style="margin:0 0 10px 0;">
        Neuer Reparaturauftrag erstellt:
      </p>
      ${list}

      <p style="margin:0 0 18px 0;">
        Öffne die Schadensmeldung:<br>
        <a href="${link}" target="_blank" style="color:#0a7cff;text-decoration:underline;">${link}</a>
      </p>

      <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;">

      <p style="margin:0 0 10px 0;">
        Nuova richiesta di riparazione creata:
      </p>
      ${list}

      <p style="margin:0;">
        Apri la segnalazione:<br>
        <a href="${link}" target="_blank" style="color:#0a7cff;text-decoration:underline;">${link}</a>
      </p>

      <div style="margin-top:30px;border-top:1px solid #e5e7eb;padding-top:20px;">
        ${FOOTER}
      </div>

    </div>
  </body>
</html>
`;
}

export function renderReminderEmail({ token, subtaskNames }) {
  const link = magicLink(token);
  const list = listHtml(subtaskNames);
  return `
<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#ffffff;">
    <div style="font-family:Helvetica, Arial, sans-serif;padding:24px;font-size:14px;line-height:20px;color:#111111;">

      <p style="margin:0 0 10px 0;">
        Erinnerung: Folgende Reparaturaufgaben sind noch offen (älter als 72 Stunden):
      </p>

      ${list}

      <p style="margin:0 0 18px 0;">
        Öffne die Schadensmeldung:<br>
        <a href="${link}" target="_blank" style="color:#0a7cff;text-decoration:underline;">
          ${link}
        </a>
      </p>

      <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;">

      <p style="margin:0 0 10px 0;">
        Promemoria: le seguenti richieste di riparazione sono ancora aperte (oltre 72 ore):
      </p>

      ${list}

      <p style="margin:0;">
        Apri la segnalazione:<br>
        <a href="${link}" target="_blank" style="color:#0a7cff;text-decoration:underline;">
          ${link}
        </a>
      </p>

      <div style="margin-top:30px;border-top:1px solid #e5e7eb;padding-top:20px;">
        ${FOOTER}
      </div>

    </div>
  </body>
</html>
`;
}
