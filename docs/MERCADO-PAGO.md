# Cobrança Pix com Mercado Pago

1. Gere uma chave de 32 bytes em hexadecimal com `node -p "require('node:crypto').randomBytes(32).toString('hex')"`. Configure-a no Worker com `npx wrangler secret put PAYMENT_INTEGRATION_KEY`. Para desenvolver localmente, coloque uma chave de teste própria no `.dev.vars`. Preserve a chave de cada ambiente para que as integrações já salvas continuem legíveis.
2. Publique com `npm run deploy` para aplicar a migration do D1 e atualizar o Worker. O `APP_URL` publicado deve ser o endereço HTTPS do MR Pag.
3. Entre em **Cobranças → Integrações**. Copie a URL exibida antes de salvar e mantenha essa tela aberta. Na aplicação do Mercado Pago, configure essa URL em **Webhooks**, selecione eventos de **Pagamentos** e copie a assinatura secreta gerada. Use o Access Token e a assinatura da mesma aplicação e do ambiente escolhido.
4. No MR Pag, preencha o Access Token e a assinatura secreta e salve. Use **Nova cobrança** para escolher um cliente ativo com e-mail e CPF/CNPJ válidos, informar valor, descrição e vencimento e gerar o Pix.
5. Os detalhes exibem QR Code e Pix copia e cola quando disponibilizados pelo provedor. A confirmação chega pelo webhook assinado, e **Consultar situação** permite conferir o status pela API a qualquer momento.

Use credenciais de teste e uma URL HTTPS acessível para validar o webhook antes de emitir cobranças reais. Em localhost, use a consulta manual para conferir o status. Se uma emissão falhar, **Tentar emitir novamente** reutiliza a mesma cobrança e a mesma chave de idempotência por até 15 minutos. Depois desse prazo, confira o painel do Mercado Pago antes de criar outra cobrança.

Ao salvar novas credenciais, cobranças anteriores continuam vinculadas à integração usada na emissão. Mantenha as credenciais e a assinatura das integrações anteriores válidas enquanto houver pagamentos pendentes.

- [Pix na API de Pagamentos](https://www.mercadopago.com.br/developers/pt/docs/checkout-api-payments/integration-configuration/integrate-pix)
