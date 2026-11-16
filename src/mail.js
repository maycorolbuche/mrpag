import { connect } from 'cloudflare:sockets';
import { sendSmtp } from './smtp.js';
import { emailLayout } from './email-layout.js';

export function mailSendingEnabled(env) {
  return ['resend', 'smtp'].includes(env.MAIL_MODE);
}

async function sendEmail(env, { email, bcc, subject, text, html, idempotencyKey, beforeSmtpData }) {
  if (env.MAIL_MODE === 'smtp') return sendSmtp(env, { email, bcc, subject, text, html, idempotencyKey, beforeSmtpData }, connect);
  if (env.MAIL_MODE !== 'resend' || !env.RESEND_API_KEY || !env.MAIL_FROM) throw new Error('mail_not_configured');
  const result = await fetch('https://api.resend.com/emails', {
    method: 'POST', signal: AbortSignal.timeout(10000),
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body: JSON.stringify({ from: env.MAIL_FROM, to: [email], ...(bcc && bcc.toLowerCase() !== email.toLowerCase() ? { bcc: [bcc] } : {}), subject, text, html }),
  });
  await result.body?.cancel();
  if (!result.ok) throw new Error(`mail_http_${result.status}`);
}

export async function sendRecovery(env, { email, url }) {
  if (env.MAIL_MODE === 'log') {
    console.log(JSON.stringify({ event: 'local_password_reset', to: email, url }));
    return;
  }
  const text = `Recebemos um pedido para redefinir sua senha no MR Pag.\n\nAcesse em até 30 minutos:\n${url}\n\nO link só pode ser usado uma vez. Se não solicitou, ignore esta mensagem.`;
  const html = emailLayout({
    title: 'Redefina sua senha', badge: 'Segurança da conta',
    introduction: 'Recebemos um pedido para redefinir sua senha no MR Pag.',
    action: 'Redefinir senha', url,
    note: 'O link vale por 30 minutos e só pode ser usado uma vez. Se você não fez o pedido, ignore este e-mail.',
  });
  return sendEmail(env, { email, subject: 'Redefina sua senha — MR Pag', text, html });
}

export const chargeEmailLayoutVersion = 2;

const chargeMessages = {
  charge: {
    title: 'Cobrança Pix', badge: 'Aguardando pagamento',
    introduction: 'Você recebeu uma cobrança Pix pelo MR Pag. Abra a cobrança para ver o QR Code ou copiar o código Pix.',
    action: 'Ver cobrança e pagar',
  },
  before_due: {
    title: 'Lembrete de vencimento', badge: 'Vence em 3 dias', tone: 'amber',
    introduction: 'Sua cobrança Pix vence em três dias. Confira os dados e pague até a data indicada.',
    action: 'Ver cobrança',
  },
  due_today: {
    title: 'Cobrança vence hoje', badge: 'Vence hoje', tone: 'amber',
    introduction: 'Hoje é o dia do vencimento da sua cobrança Pix.',
    action: 'Ver cobrança e pagar',
  },
  overdue: {
    title: 'Cobrança vencida', badge: 'Vencida há 3 dias', tone: 'red',
    introduction: 'Sua cobrança venceu há três dias. Consulte a situação e fale com o recebedor se precisar de um novo Pix.',
    action: 'Consultar situação',
  },
  confirmation: {
    title: 'Pagamento confirmado', badge: 'Paga',
    introduction: 'Seu pagamento Pix foi confirmado. Você pode consultar os dados da cobrança pelo link.',
    action: 'Ver cobrança paga',
  },
};

export const isChargeEmailPurpose = purpose => Object.hasOwn(chargeMessages, purpose);

// Resend requires the original request body on retries started before the HTML rollout.
const legacyIntroductions = {
  charge: 'Você recebeu uma cobrança Pix pelo MR Pag.',
  before_due: 'Sua cobrança Pix está próxima do vencimento.',
  due_today: 'Sua cobrança Pix vence hoje.',
  overdue: 'Sua cobrança passou do vencimento. Consulte a situação e fale com o recebedor se precisar de um novo Pix.',
  confirmation: 'Seu pagamento Pix foi confirmado.',
};

export function sendChargeEmail(env, { email, bcc, url, amount, dueDate, description, purpose, idempotencyKey, beforeSmtpData, preview = false, layoutVersion = chargeEmailLayoutVersion }) {
  const message = chargeMessages[purpose];
  const displayedDescription = layoutVersion >= 2 ? description : null;
  const details = `${displayedDescription ? `Descrição: ${displayedDescription}\n` : ''}Valor: ${amount}\nVencimento: ${dueDate}`;
  if (layoutVersion === 0) {
    const text = `${legacyIntroductions[purpose]}\n\n${details}\n\nConsulte a cobrança:\n${url}`;
    return sendEmail(env, { email, bcc, subject: `${message.title} — MR Pag`, text, idempotencyKey, beforeSmtpData });
  }
  const text = preview
    ? `E-MAIL DE TESTE — dados fictícios\n\n${message.introduction}\n\n${details}`
    : `${message.introduction}\n\n${details}\n\n${message.action}:\n${url}`;
  const html = emailLayout({ ...message, amount, dueDate, description: displayedDescription, url, preview });
  const subject = `${preview ? '[Teste] ' : ''}${message.title} — MR Pag`;
  return sendEmail(env, { email, bcc, subject, text, html, idempotencyKey, beforeSmtpData });
}
