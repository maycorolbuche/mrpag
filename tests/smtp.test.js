import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendSmtp } from '../src/smtp.js';

function smtpServer(replies) {
  const writes = [];
  return {
    writes,
    connect(address, options) {
      assert.deepEqual(address, { hostname: 'br.example.com', port: 465 });
      assert.deepEqual(options, { secureTransport: 'on' });
      let input;
      const encoder = new TextEncoder();
      const readable = new ReadableStream({ start(c) { input = c; c.enqueue(encoder.encode('220 smtp\r\n')); } });
      const writable = new WritableStream({
        write(chunk) {
          writes.push(new TextDecoder().decode(chunk));
          const reply = replies.shift();
          if (reply === null) input.close();
          else for (const fragment of [].concat(reply)) input.enqueue(encoder.encode(fragment));
        },
      });
      return { opened: Promise.resolve(), closed: Promise.resolve(), readable, writable, async close() {} };
    },
  };
}

const env = { SMTP_HOST: 'br.example.com', SMTP_USER: 'sender@example.com', SMTP_PASSWORD: 'test', MAIL_FROM: 'MR Pag <sender@example.com>' };
const message = { email: 'customer@example.com', bcc: 'operator@example.com', subject: 'Cobrança Pix', text: 'Olá!', idempotencyKey: 'initial/charge' };

test('SMTP via TLS autentica, envia cópia apenas no envelope e codifica a mensagem', async () => {
  const server = smtpServer([['250-smt', 'p\r\n250 AUTH', ' PLAIN LOGIN\r\n'], '235 ok\r\n',
    '250 ok\r\n', '250 ok\r\n', '251 ok\r\n', '354 continue\r\n', '250 accepted\r\n']);
  let dataMarked = false;
  await sendSmtp(env, { ...message, beforeSmtpData() {
    assert.equal(server.writes.at(-1), 'DATA\r\n');
    dataMarked = true;
  } }, server.connect);
  assert.ok(dataMarked);
  assert.match(server.writes[1], /^AUTH PLAIN /);
  assert.equal(server.writes[4], 'RCPT TO:<operator@example.com>\r\n');
  const data = server.writes.at(-1);
  assert.doesNotMatch(data, /operator@example.com|^Bcc:/im);
  assert.match(data, /Message-ID: <initial\.charge@example.com>/);
  assert.match(data, /T2zDoSE=\r\n\.\r\n$/);
});

test('SMTP diferencia rejeição temporária de conexão interrompida após DATA', async () => {
  const steps = ['250 AUTH LOGIN\r\n', '334 user\r\n', '334 password\r\n', '235 ok\r\n',
    '250 ok\r\n', '250 ok\r\n', '250 ok\r\n', '354 continue\r\n'];
  const temporary = smtpServer([...steps, '451 try later\r\n']);
  await assert.rejects(sendSmtp(env, message, temporary.connect), { message: 'mail_smtp_451' });
  const unknown = smtpServer([...steps, null]);
  await assert.rejects(sendSmtp(env, message, unknown.connect), { message: 'mail_smtp_delivery_unknown' });
});

test('SMTP impede injeção de comandos por destinatário', async () => {
  await assert.rejects(sendSmtp(env, { ...message, email: 'test@example.com\r\nDATA' },
    () => assert.fail('socket should not be opened')), { message: 'mail_invalid_recipient' });
});
