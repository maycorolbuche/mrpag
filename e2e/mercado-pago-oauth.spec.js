import { test, expect } from '@playwright/test';
import { fixture, initial } from '../tests/helpers.js';

test('autoriza o Mercado Pago e retorna ao MR Pag na mesma aba', async ({ page }) => {
  const origin = 'https://pag.example.com';
  const settings = origin + '/account/payments';
  const f = await fixture({
    bindings: {
      APP_URL: origin,
      PAYMENT_INTEGRATION_KEY: 'a'.repeat(64),
      MERCADO_PAGO_CLIENT_ID: '42',
      MERCADO_PAGO_CLIENT_SECRET: 'client-secret-for-tests',
      MERCADO_PAGO_WEBHOOK_SECRET: 'webhook-secret-for-tests',
    },
    paymentApi: () => Response.json({
      access_token: 'access-for-tests', refresh_token: 'refresh-for-tests',
      expires_in: 3600, user_id: 123, live_mode: true,
    }),
  });
  try {
    await f.db.prepare('UPDATE users SET must_change=0').run();
    await page.route(origin + '/**', async route => {
      const request = route.request();
      const response = await f.mf.dispatchFetch(request.url(), {
        method: request.method(), headers: await request.allHeaders(),
        body: request.postDataBuffer() ?? undefined, redirect: 'manual',
      });
      await route.fulfill({
        status: response.status, headers: Object.fromEntries(response.headers),
        body: Buffer.from(await response.arrayBuffer()),
      });
    });
    await page.route('https://auth.mercadopago.com/authorization?**', async route => {
      const params = new URL(route.request().url()).searchParams;
      const approval = new URL('https://www.mercadopago.com.br/autorizar-teste');
      approval.search = params;
      await route.fulfill({ status: 302, headers: { location: approval.href } });
    });
    await page.route('https://www.mercadopago.com.br/autorizar-teste?**', async route => {
      const params = new URL(route.request().url()).searchParams;
      const callback = new URL(params.get('redirect_uri'));
      callback.search = new URLSearchParams({ code: 'authorization-code', state: params.get('state') });
      await route.fulfill({ contentType: 'text/html', body: `<a href="${callback.href}">Autorizar</a>` });
    });

    await page.goto(origin + '/login');
    await page.getByLabel('Seu e-mail').fill('admin@mrpag.local');
    await page.getByLabel('Sua senha', { exact: true }).fill(initial);
    await page.getByRole('button', { name: 'Entrar na minha conta' }).click();
    await expect(page).toHaveURL(origin + '/app');
    await page.goto(settings);
    await page.getByRole('button', { name: 'Conectar Mercado Pago' }).click();
    await page.getByRole('link', { name: 'Autorizar', exact: true }).click();
    await expect(page).toHaveURL(settings + '?oauth=connected');
    await expect(page.getByRole('status')).toContainText('Conta do Mercado Pago conectada.');
  } finally {
    await f.mf.dispose();
  }
});
