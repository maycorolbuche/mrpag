import { test, expect } from '@playwright/test';
import { fixture } from '../tests/helpers.js';
let mf, base, messages;
test.beforeAll(async () => {
  const f = await fixture({ serve: true }); mf = f.mf; messages = f.messages; base = (await mf.ready).origin;
});
test.afterAll(async () => { await mf?.dispose(); });
test('desktop and mobile authentication journey', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/login`);
  await expect(page.getByRole('heading', { name: 'Bom ter você aqui.' })).toBeVisible();
  await page.screenshot({ path: 'test-results/login-desktop.png', fullPage: true });
  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/login-mobile.png', fullPage: true });
  await page.getByLabel('Seu e-mail').fill('admin@mrpag.local');
  await page.getByLabel('Sua senha', { exact: true }).fill('MrPag@2026!Inicial');
  await page.getByRole('button', { name: 'Mostrar senha', exact: true }).click();
  await expect(page.locator('#password')).toHaveAttribute('type', 'text');
  await page.getByRole('button', { name: 'Entrar na minha conta' }).click();
  await expect(page).toHaveURL(`${base}/account/password`);
  await expect(page.getByRole('status')).toContainText('substitua a senha inicial');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByLabel('Senha atual', { exact: true }).fill('MrPag@2026!Inicial');
  await page.getByLabel('Nova senha', { exact: true }).fill('Minha senha pessoal 2026!');
  await page.getByLabel('Confirme a nova senha').fill('Minha senha pessoal 2026!');
  await page.getByRole('button', { name: 'Salvar nova senha' }).click();
  await expect(page.getByRole('heading', { name: 'Olá, Administrador.' })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: 'test-results/dashboard-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Sair' }).click();
  await page.getByRole('link', { name: 'Esqueci minha senha' }).click();
  await page.getByLabel('Seu e-mail').fill('admin@mrpag.local');
  await page.getByRole('button', { name: 'Enviar link' }).click();
  await expect(page.getByRole('status')).toContainText('Se o e-mail estiver cadastrado');
  await page.goto(new URL(messages[0].text.match(/http:\/\/[^\s]+\/reset-password\/[a-f0-9]+/)[0]).href);
  await page.getByLabel('Nova senha', { exact: true }).fill('Minha outra senha pessoal!');
  await page.getByLabel('Confirme a nova senha').fill('Minha outra senha pessoal!');
  await page.getByRole('button', { name: 'Salvar nova senha' }).click();
  await expect(page.getByRole('status')).toContainText('Senha redefinida');
  await page.getByLabel('Seu e-mail').fill('admin@mrpag.local');
  await page.getByLabel('Sua senha', { exact: true }).fill('Minha outra senha pessoal!');
  await page.getByRole('button', { name: 'Entrar na minha conta' }).click();
  await expect(page.getByRole('heading', { name: 'Olá, Administrador.' })).toBeVisible();
  expect(errors).toEqual([]);
});
