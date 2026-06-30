// Thin email layer.
//
// Provider chosen by EARSHOT_MAILER env: 'resend' | 'off' (default off).
// When off, every call returns ok and logs to console — useful during
// dev and prevents the app from blowing up when keys aren't set yet.

const MAILER = (process.env.EARSHOT_MAILER || 'off').toLowerCase();
const FROM = process.env.EARSHOT_MAIL_FROM || 'Earshot <noreply@earshot.cc>';

async function sendViaResend({ to, subject, html, text }) {
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY not set');
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: FROM, to, subject, html, text }),
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`resend ${r.status}: ${body.slice(0, 200)}`);
  }
}

export async function sendMail({ to, subject, html, text }) {
  if (!to) return { ok: false, reason: 'no recipient' };
  if (MAILER === 'off') {
    console.log(`[mailer:off] → ${to}  ${subject}`);
    return { ok: true, stub: true };
  }
  try {
    if (MAILER === 'resend') await sendViaResend({ to, subject, html, text });
    else throw new Error(`unknown EARSHOT_MAILER=${MAILER}`);
    return { ok: true };
  } catch (e) {
    console.error('[mailer] send failed:', e.message);
    return { ok: false, reason: e.message };
  }
}

// Template helpers — keep them inline so swapping to a real templating
// engine later is a single-file change.
export function collabInviteEmail({ inviterEmail, projectName, inviteUrl }) {
  const subject = `${inviterEmail || 'Someone'} invited you to "${projectName}" on Earshot`;
  const text =
`${inviterEmail || 'Someone'} added you as a collaborator on the Earshot project "${projectName}".

Open it here:
${inviteUrl}

If you don't have an Earshot account yet, sign up with this email and the
project will be waiting for you.

— Earshot`;
  const html = `
<div style="font-family:ui-monospace,Menlo,monospace;max-width:560px;margin:0 auto;padding:32px;background:#0e0e10;color:#ede9e2">
  <h1 style="font-size:18px;letter-spacing:0.18em;color:#7a7770;margin:0 0 12px">EARSHOT</h1>
  <p style="font-size:15px;line-height:1.5">
    <strong>${escapeHtml(inviterEmail || 'Someone')}</strong> invited you to the project
    <strong style="color:#ffb347">${escapeHtml(projectName)}</strong>.
  </p>
  <p style="margin:24px 0">
    <a href="${inviteUrl}" style="display:inline-block;background:#ffb347;color:#0e0e10;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:700">
      Open project
    </a>
  </p>
  <p style="font-size:12px;color:#7a7770">If the button doesn't work, paste this into your browser:<br>${inviteUrl}</p>
  <p style="font-size:11px;color:#7a7770;margin-top:32px">
    Don't have an account yet? Sign up with this email and the project will be waiting for you.
  </p>
</div>`;
  return { subject, text, html };
}

function escapeHtml(s = '') {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
