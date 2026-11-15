const encoder = new TextEncoder();
const utf8Base64 = value => btoa(Array.from(encoder.encode(value), byte => String.fromCharCode(byte)).join(''));
const mailboxPattern = /^[a-z0-9.!#$%&'*+/=?^_{`|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;

function settings(env) {
  const host = env.SMTP_HOST?.trim();
  const user = env.SMTP_USER?.trim();
  const password = env.SMTP_PASSWORD;
  const configuredFrom = env.MAIL_FROM?.trim() || '';
  const named = /^([^<>\r\n]+) <([^<>\r\n]+)>$/.exec(configuredFrom);
  const from = named?.[2] || configuredFrom;
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(host || '') ||
      !mailboxPattern.test(user || '') || !password || !mailboxPattern.test(from)) {
    throw new Error('mail_not_configured');
  }
  const sender = named ? `=?UTF-8?B?${utf8Base64(named[1])}?= <${from}>` : from;
  return { host, user, password, from, sender };
}

function smtpConnection(socket) {
  const reader = socket.readable.getReader();
  const writer = socket.writable.getWriter();
  const decoder = new TextDecoder();
  let buffer = '';

  async function line() {
    while (!buffer.includes('\r\n')) {
      const { done, value } = await reader.read();
      if (done) throw new Error('mail_transport_error');
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > 16384) throw new Error('mail_transport_error');
    }
    const end = buffer.indexOf('\r\n');
    const result = buffer.slice(0, end);
    buffer = buffer.slice(end + 2);
    return result;
  }

  return {
    async reply(...expected) {
      const lines = [];
      let code;
      for (let count = 0; count < 50; count++) {
        const match = /^(\d{3})([ -])(.*)$/.exec(await line());
        if (!match || (code && code !== match[1])) throw new Error('mail_transport_error');
        code = match[1];
        lines.push(match[3]);
        if (match[2] === ' ') {
          if (!expected.includes(Number(code))) throw new Error(`mail_smtp_${code}`);
          return lines;
        }
      }
      throw new Error('mail_transport_error');
    },
    async write(value) { await writer.write(encoder.encode(value + '\r\n')); },
  };
}

async function authenticate(connection, capabilities, user, password) {
  const auth = capabilities.flatMap(line => /^AUTH[ =](.+)$/i.exec(line)?.[1].toUpperCase().split(/\s+/) || []);
  if (auth.includes('PLAIN')) {
    await connection.write('AUTH PLAIN ' + utf8Base64(`\0${user}\0${password}`));
    await connection.reply(235);
    return;
  }
  if (!auth.includes('LOGIN')) throw new Error('mail_smtp_auth_unavailable');
  await connection.write('AUTH LOGIN');
  await connection.reply(334);
  await connection.write(utf8Base64(user));
  await connection.reply(334);
  await connection.write(utf8Base64(password));
  await connection.reply(235);
}

function messageData(sender, from, { email, subject, text, idempotencyKey }) {
  const id = idempotencyKey?.replace(/[^a-z0-9-]/gi, '.') || crypto.randomUUID();
  return [
    `From: ${sender}`, `To: <${email}>`, `Subject: =?UTF-8?B?${utf8Base64(subject)}?=`,
    `Date: ${new Date().toUTCString()}`, `Message-ID: <${id}@${from.split('@')[1]}>`,
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64', '',
    ...(utf8Base64(text.replace(/\r?\n/g, '\r\n')).match(/.{1,76}/g) || []), '.',
  ].join('\r\n');
}

export async function sendSmtp(env, message, connect) {
  const { host, user, password, from, sender } = settings(env);
  const { email, bcc } = message;
  if (!mailboxPattern.test(email || '') || (bcc && !mailboxPattern.test(bcc))) throw new Error('mail_invalid_recipient');
  const recipients = [email];
  if (bcc && bcc.toLowerCase() !== email.toLowerCase()) recipients.push(bcc);
  const data = messageData(sender, from, message);

  const socket = connect({ hostname: host, port: 465 }, { secureTransport: 'on' });
  // Socket shutdown can reject independently of the active read or write.
  socket.closed.catch(() => {});
  let bodyStarted = false;
  let timer;
  const transmission = async () => {
    await socket.opened;
    const connection = smtpConnection(socket);
    await connection.reply(220);
    await connection.write('EHLO ' + from.split('@')[1]);
    await authenticate(connection, await connection.reply(250), user, password);
    await connection.write(`MAIL FROM:<${from}>`);
    await connection.reply(250);
    for (const recipient of recipients) {
      await connection.write(`RCPT TO:<${recipient}>`);
      await connection.reply(250, 251);
    }
    await connection.write('DATA');
    await connection.reply(354);
    await message.beforeSmtpData?.();
    bodyStarted = true;
    await connection.write(data);
    await connection.reply(250);
  };
  try {
    await Promise.race([
      transmission(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('mail_transport_error')), 10000); }),
    ]);
  } catch (error) {
    if (/^mail_smtp_[45]\d{2}$/.test(error.message) || error.message === 'mail_smtp_auth_unavailable') throw error;
    throw new Error(bodyStarted ? 'mail_smtp_delivery_unknown' : 'mail_transport_error');
  } finally {
    clearTimeout(timer);
    socket.close().catch(() => {});
  }
}
