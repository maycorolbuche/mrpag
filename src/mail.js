export async function sendRecovery(env, { email, url }) {
  const text = `Recebemos um pedido para redefinir sua senha no MR Pag.\n\nAcesse em até 30 minutos:\n${url}\n\nO link só pode ser usado uma vez. Se não solicitou, ignore esta mensagem.`;
  if (env.MAIL_MODE === 'log') {
    console.log(JSON.stringify({ event: 'local_password_reset', to: email, url }));
    return;
  }
  if (env.MAIL_MODE !== 'resend' || !env.RESEND_API_KEY || !env.MAIL_FROM) throw new Error('mail_not_configured');
  const result = await fetch('https://api.resend.com/emails', {
    method: 'POST', signal: AbortSignal.timeout(10000),
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.MAIL_FROM, to: [email], subject: 'Redefina sua senha — MR Pag', text }),
  });
  if (!result.ok) throw new Error(`mail_http_${result.status}`);
}
