import { test, expect } from '@playwright/test';
import { fixture } from '../tests/helpers.js';

test('a página de pagamento aberta se atualiza automaticamente após a baixa', async ({ page }) => {
  const { db, mf } = await fixture({ serve: true });
  try {
    const token = 'a'.repeat(64);
    const chargeId = crypto.randomUUID();
    const due = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    await db.batch([
      db.prepare(`INSERT INTO customers(id,account_id,name,person_type,created_at,updated_at)
        VALUES (1,1,'Cliente','person',0,0)`),
      db.prepare(`INSERT INTO payment_integrations(id,account_id,provider,credentials,created_at)
        VALUES ('integration',1,'mercado-pago','{}',0)`),
      db.prepare(`INSERT INTO charges(id,account_id,customer_id,integration_id,description,amount_cents,
        due_date,provider_payload,provider_id,status,pix_code,created_at,public_token)
        VALUES (?,1,1,'integration','Cobrança',1000,?,'{}','321','pending','pix-deteste',0,?)`)
        .bind(chargeId, due, token),
    ]);
    const url = (await mf.ready).origin + '/pay/' + token;
    await page.goto(url);
    await expect(page.getByText('Aguardando pagamento')).toBeVisible();
    await expect(page.getByLabel('Pix copia e cola')).toHaveValue('pix-deteste');

    const pending = await page.waitForResponse(response => response.url() === url + '/status');
    expect(await pending.json()).toEqual({ status: 'pending' });
    await expect(page.getByText('Aguardando pagamento')).toBeVisible();

    await db.prepare("UPDATE charges SET status='paid' WHERE id=?").bind(chargeId).run();
    await expect(page.getByText('Paga', { exact: true })).toBeVisible({ timeout: 10000 });
    await expect(page.getByLabel('Pix copia e cola')).toHaveCount(0);
  } finally {
    await mf.dispose();
  }
});
