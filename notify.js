import nodemailer from 'nodemailer';
import axios from 'axios';

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
    console.log('[correo sin enviar — falta configurar Gmail en .env]\n', subject, '\n', text);
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

// Canal alterno vía Telegram — mucho más ligero que WhatsApp: no requiere
// verificación de negocio ni aprobación de Meta, solo un bot creado con
// @BotFather (ver README) y el chat_id de la conversación con ese bot.
// Si no está configurado (TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID), se ignora en
// silencio — igual que el correo cuando falta Gmail.
export async function sendTelegramMessage(subject, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.log('[Telegram sin enviar — falta configurar TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID en .env]');
    return;
  }
  const message = `*${subject}*\n\n${text}`;
  await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
    chat_id: chatId,
    text: message,
    parse_mode: 'Markdown',
  });
}

// Punto de entrada único para avisar: manda por todos los canales que estén
// configurados (correo y/o Telegram). Si uno falla, no bloquea al otro — se
// registra el error en consola y sigue, en vez de perder la alerta completa
// porque, por ejemplo, Telegram tuvo un hiccup momentáneo.
export async function sendAlert(subject, text) {
  const results = await Promise.allSettled([
    sendAlertEmail(subject, text),
    sendTelegramMessage(subject, text),
  ]);
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      const channel = i === 0 ? 'correo' : 'Telegram';
      console.error(`No se pudo mandar el aviso por ${channel}:`, r.reason?.message || r.reason);
    }
  });
}
