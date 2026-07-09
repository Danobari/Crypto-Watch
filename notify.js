import nodemailer from 'nodemailer';

let transporter = null;

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,
      },
    });
  }
  return transporter;
}

export async function sendAlertEmail(subject, text) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    console.log('[aviso sin enviar — falta configurar Gmail en .env]\n', subject, '\n', text);
    return;
  }
  const t = getTransporter();
  await t.sendMail({
    from: process.env.GMAIL_USER,
    to: process.env.NOTIFY_TO || process.env.GMAIL_USER,
    subject,
    text,
  });
}
