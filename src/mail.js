async function sendEmail(env, { email, subject, text, idempotencyKey }) {
  if (env.MAIL_MODE !== 'resend' || !env.RESEND_API_KEY || !env.MAIL_FROM) throw new Error('mail_not_configured');
  const result = await fetch('https://api.resend.com/emails', {
    method: 'POST', signal: AbortSignal.timeout(10000),
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body: JSON.stringify({ from: env.MAIL_FROM, to: [email], subject, text }),
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
  return sendEmail(env, { email, subject: 'Redefina sua senha — MR Pag', text });
}

export function sendChargeEmail(env, { email, url, amount, dueDate, idempotencyKey }) {
  const text = `Você recebeu uma cobrança Pix pelo MR Pag.\n\nValor: ${amount}\nVencimento: ${dueDate}\n\nAbra o link para pagar ou acompanhar a situação:\n${url}`;
  return sendEmail(env, { email, subject: 'Cobrança Pix — MR Pag', text, idempotencyKey });
}
