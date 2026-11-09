import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

function launch(port) {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: { ...process.env, NODE_ENV: 'development', PORT: String(port), APP_URL: '', DATABASE_PATH: ':memory:', SMTP_HOST: '', ADMIN_EMAIL: '', ADMIN_PASSWORD: '', SESSION_SECRET: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  return { child, output: () => output };
}

test('occupied port reports failure and never prints a successful startup', { timeout: 15000 }, async t => {
  const occupied = createServer(); occupied.listen(0);
  await once(occupied, 'listening');
  t.after(() => occupied.close());
  const { child, output } = launch(occupied.address().port);
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const [code] = await once(child, 'exit');
  assert.equal(code, 1);
  assert.match(output(), /porta .* já está em uso/);
  assert.doesNotMatch(output(), /MR Pag disponível/);
});

test('server keeps listening and serves HTTP after startup', { timeout: 15000 }, async t => {
  const { child, output } = launch(0);
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(output())), 10000);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Exited: ${code}: ${output()}`)); });
    child.stdout.on('data', () => {
      const match = output().match(/http:\/\/localhost:(\d+)/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
  });
  const response = await fetch(`${url}/login`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Bom ter você aqui/);
  assert.equal(child.exitCode, null);
});
