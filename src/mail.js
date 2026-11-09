import nodemailer from 'nodemailer';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
export function makeMailer(env) {
  const local = env.NODE_ENV !== 'production' && !env.SMTP_HOST;
  if (!local && (!env.SMTP_HOST || !env.MAIL_FROM)) throw new Error('Configure SMTP_HOST e MAIL_FROM.');
  const transport = local ? null : nodemailer.createTransport({
    host: env.SMTP_HOST, port: Number(env.SMTP_PORT || 587), secure: env.SMTP_SECURE === 'true',
    requireTLS: env.SMTP_SECURE !== 'true',
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    connectionTimeout: 10000, socketTimeout: 15000,
  });
  return async ({ email, url }) => {
    const message = { from: env.MAIL_FROM || 'MR Pag <acesso@mrpag.local>', to: email,
      subject: 'Redefina sua senha — MR Pag',
      text: `Recebemos um pedido para redefinir sua senha no MR Pag.\n\nAcesse o link em até 30 minutos:\n${url}\n\nO link só pode ser usado uma vez. Se não solicitou, ignore este e-mail.` };
    if (local) {
      const folder = env.MAIL_DIR || 'data/mail';
      await mkdir(folder, { recursive: true, mode: 0o700 });
      await writeFile(join(folder, `${randomUUID()}.json`), JSON.stringify(message, null, 2), { mode: 0o600 });
    } else await transport.sendMail(message);
  };
}
