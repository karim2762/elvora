import { config } from '../config/index.js';

// Email is optional. Nothing is "sent" unless SMTP is configured; callers must check isEmailConfigured().
let transport = null; // lazily created nodemailer transport (or a test double)

export const isEmailConfigured = () => Boolean(transport || (config.mail.host && config.mail.from));
// Stage 08A: SMTP settings that are present but incomplete used to be ignored silently. Returns human-readable warnings (never values).
export function mailConfigWarnings(mail = config.mail) {
  const w = [];
  const any = mail.host || mail.user || mail.pass || mail.from;
  if (!any) return w;
  if (!mail.host) w.push('SMTP_HOST is not set, so e-mail is OFF even though other mail settings are present.');
  if (mail.host && !mail.from) w.push('MAIL_FROM is not set, so e-mail is OFF (both SMTP_HOST and MAIL_FROM are required).');
  if (mail.user && !mail.pass) w.push('SMTP_USER is set without SMTP_PASS; sending will fail if the provider requires a password.');
  if (!mail.user && mail.pass) w.push('SMTP_PASS is set without SMTP_USER; the password will not be used.');
  return w;
}

export const __setTransportForTests = (t) => { transport = t; };

async function getTransport() {
  if (transport) return transport;
  const { default: nodemailer } = await import('nodemailer');
  transport = nodemailer.createTransport({
    host: config.mail.host, port: config.mail.port, secure: config.mail.secure,
    auth: config.mail.user ? { user: config.mail.user, pass: config.mail.pass } : undefined,
  });
  return transport;
}

export async function sendPasswordResetEmail({ to, name, link, minutes }) {
  const t = await getTransport();
  const from = config.mail.from || 'ELVORA <no-reply@localhost>';
  await t.sendMail({
    from, to, subject: 'Reset your ELVORA password',
    text: `Hi ${name},\n\nUse this link to choose a new password (valid for ${minutes} minutes, one use only):\n${link}\n\nIf you didn't request this, you can ignore this email. Your password will not change.\n\n— ELVORA`,
    html: `<p>Hi ${String(name).replace(/[<>&"]/g, '')},</p><p>Use the button below to choose a new password. The link is valid for ${minutes} minutes and works once.</p><p><a href="${link}" style="background:#2563eb;color:#fff;padding:10px 18px;border-radius:999px;text-decoration:none">Reset password</a></p><p>If you didn't request this, ignore this email. Your password will not change.</p>`,
  });
}

const h = (v) => String(v ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));

// Stage 07: e-mails an issued PDF (offer letter or certificate) to the student. Called only by the automation worker.
export async function sendDocumentEmail({ to, name, type, internshipTitle, documentNumber, verifyUrl, documentsUrl, fileName, pdf }) {
  const t = await getTransport();
  const from = config.mail.from || 'ELVORA <no-reply@localhost>';
  const cert = type === 'certificate';
  const subject = cert ? `Your ELVORA certificate — ${internshipTitle}` : `Your ELVORA internship offer letter — ${internshipTitle}`;
  const lead = cert
    ? `Congratulations on completing <b>${h(internshipTitle)}</b>! Your completion certificate is attached.`
    : `Congratulations! Your offer letter for <b>${h(internshipTitle)}</b> is attached. Please read the terms carefully.`;
  const leadText = cert ? `Congratulations on completing ${internshipTitle}! Your completion certificate is attached.` : `Congratulations! Your offer letter for ${internshipTitle} is attached. Please read the terms carefully.`;
  await t.sendMail({
    from, to, subject,
    text: `Hi ${name},\n\n${leadText}\n\nDocument number: ${documentNumber}\nVerify it any time: ${verifyUrl}\nYou can also download it from your dashboard: ${documentsUrl}\n\n— ELVORA`,
    html: `<p>Hi ${h(name)},</p><p>${lead}</p><p>Document number: <b>${h(documentNumber)}</b><br>Anyone can verify it at <a href="${h(verifyUrl)}">${h(verifyUrl)}</a>.</p><p><a href="${h(documentsUrl)}" style="background:#2563eb;color:#fff;padding:10px 18px;border-radius:999px;text-decoration:none">Open my documents</a></p><p>— ELVORA</p>`,
    attachments: [{ filename: fileName, content: pdf, contentType: 'application/pdf' }],
  });
}
