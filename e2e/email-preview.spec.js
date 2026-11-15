import { test, expect } from '@playwright/test';
import { fixture, initial } from '../tests/helpers.js';

test('envia um modelo de cobrança sem salvar as preferências', async ({ page }) => {
  const { db, mf, messages } = await fixture({ serve: true });
  try {
    const origin = (await mf.ready).origin;
    await db.prepare('UPDATE users SET must_change=0').run();
    await page.goto(origin + '/login');
    await page.getByLabel('Seu e-mail').fill('admin@mrpag.local');
    await page.getByLabel('Sua senha', { exact: true }).fill(initial);
    await page.getByRole('button', { name: 'Entrar na minha conta' }).click();
    await expect(page).toHaveURL(origin + '/app');

    await page.goto(origin + '/account/notifications');
    await page.getByLabel('No dia do vencimento', { exact: true }).check();
    await page.getByRole('button', { name: 'Enviar teste: No dia do vencimento' }).click();
    await expect(page.getByRole('status')).toContainText('E-mail de teste aceito');
    expect(messages).toHaveLength(1);
    expect(messages[0].subject).toBe('[Teste] Cobrança vence hoje — MR Pag');
    expect(messages[0].html).toContain('E-mail de teste');
    await expect(page.getByLabel('No dia do vencimento', { exact: true })).not.toBeChecked();
  } finally {
    await mf.dispose();
  }
});
