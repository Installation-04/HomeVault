import nodemailer from 'nodemailer';

let transporter = null;

export function getTransporter() {
  if (!process.env.SMTP_HOST) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    });
  }
  return transporter;
}

export async function sendMail({ to, subject, text }) {
  const t = getTransporter();
  if (!t) return { skipped: true }; // SMTP not configured; in-app reminders still work.
  return t.sendMail({ from: process.env.SMTP_FROM || 'homevault@example.com', to, subject, text });
}
