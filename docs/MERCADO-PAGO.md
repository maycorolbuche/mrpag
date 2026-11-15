# Integrar o MR Pag com o Mercado Pago

O MR Pag usa o Mercado Pago para emitir cobranças avulsas via Pix e acompanhar o pagamento. Configure três valores antes da primeira cobrança.

| Valor | Onde obter | Onde cadastrar |
| --- | --- | --- |
| `PAYMENT_INTEGRATION_KEY` | Gerada por você no terminal | Secret do Worker `mrpag` no Cloudflare |
| Access Token | Credenciais da aplicação no Mercado Pago | **Cobranças → Integrações** no MR Pag |
| Assinatura secreta do webhook | Configuração de Webhooks da mesma aplicação no Mercado Pago | **Cobranças → Integrações** no MR Pag |

## 1. Prepare o Worker no Cloudflare

1. Use a versão publicada do MR Pag e abra **Cobranças → Integrações**. Se estiver atualizando a instalação, aguarde o deploy da `main` aplicar as migrations. Em instalações com deploy manual, use `npm run deploy`.
2. Confirme que a URL de produção é o endereço HTTPS público do MR Pag. No deploy pelo GitHub Actions, o endereço vem de `CLOUDFLARE_APP_URL`. [Configuração do Cloudflare](CLOUDFLARE.md)
3. Se o Worker ainda não tiver `PAYMENT_INTEGRATION_KEY`, gere uma chave com 64 caracteres hexadecimais no PowerShell:

   ```powershell
   node -p "require('node:crypto').randomBytes(32).toString('hex')"
   ```

4. No Cloudflare, abra **Workers & Pages → mrpag → Settings → Variables and Secrets → Add**. Escolha **Secret**, informe o nome `PAYMENT_INTEGRATION_KEY`, cole a chave gerada e confirme a publicação da configuração. Pelo terminal, na pasta do projeto, você também pode usar:

   ```powershell
   npx wrangler secret put PAYMENT_INTEGRATION_KEY
   ```

   Cole a chave quando solicitado. Guarde uma cópia segura e preserve o valor nos próximos deploys. O MR Pag precisa dele para ler as credenciais de pagamento já salvas. Em desenvolvimento local, use uma chave própria no `.dev.vars`.

## 2. Crie a aplicação no Mercado Pago

1. Entre no [Mercado Pago Developers](https://www.mercadopago.com.br/developers/panel/app) com a conta que receberá os pagamentos.
2. Abra **Suas integrações → Criar aplicação**. Dê o nome **MR Pag**.
3. Se o painel pedir o produto, escolha **Checkout Transparente**. Se houver opção entre **Payments** e **Orders**, escolha **API de Pagamentos (Payments)**. O MR Pag usa o endpoint `/v1/payments`.
4. Abra a aplicação e acesse **Credenciais → Teste**. Copie o **Access Token**. O formulário do MR Pag usa o Access Token. [Pix na API de Pagamentos](https://www.mercadopago.com.br/developers/pt/docs/checkout-api-payments/integration-configuration/integrate-pix)

## 3. Configure o webhook e conecte o MR Pag

1. No **MR Pag publicado**, abra **Cobranças → Integrações**. Copie a **URL do webhook** exibida junto ao formulário. Mantenha a aba aberta até salvar. Recarregar o formulário gera outro endereço para a integração que está sendo criada.
2. Em outra aba, abra a mesma aplicação no Mercado Pago e vá em **Webhooks** ou **Configuração de Webhooks**.
3. Selecione o ambiente **Teste**, cole a URL HTTPS copiada do MR Pag, marque o evento **Pagamentos** e salve. Copie a **assinatura secreta** exibida na configuração.
4. Volte ao formulário do MR Pag. Cole o **Access Token** e a **Assinatura secreta do webhook** da mesma aplicação e do mesmo ambiente.
5. Clique em **Conectar Mercado Pago**. A tela deve mostrar **Integração ativa** e a URL do webhook ativo. Confira se ela corresponde à cadastrada no painel do Mercado Pago.

## 4. Emita e confira a primeira cobrança

1. Em **Clientes**, escolha um cadastro ativo com **e-mail e CPF ou CNPJ válidos**.
2. Abra **Cobranças → Nova cobrança**, selecione o cliente e informe **descrição, valor e vencimento**.
3. Clique em **Gerar Pix**. Confira o valor, a situação e o **QR Code** ou **Pix copia e cola** nos detalhes da cobrança.
4. Clique em **Consultar situação** para verificar se o MR Pag consegue buscar o pagamento na API. Em localhost, use essa opção para acompanhar a situação.
5. O teste de entrega de webhook no painel ajuda a confirmar que a URL recebe a notificação. Para validar a baixa de ponta a ponta, use uma cobrança cujo status mude para aprovado no Mercado Pago. Reabra os detalhes **antes de clicar em Consultar situação** e confira se a situação já mudou para **Paga**. Assim você verifica se a atualização veio pelo webhook.

Se a emissão falhar, **Tentar emitir novamente** reutiliza a cobrança e a mesma chave de idempotência por até 15 minutos. Após esse prazo, confira o painel do Mercado Pago antes de emitir outra cobrança.

## 5. Passe para produção

Na aplicação do Mercado Pago, obtenha o **Access Token de produção**. Abra novamente **Cobranças → Integrações** no MR Pag, copie a URL do novo formulário e cadastre-a na aba **Produção** da configuração de Webhooks do Mercado Pago. Marque **Pagamentos**, salve e copie a assinatura secreta correspondente. Use os dois valores de produção para salvar a nova integração no MR Pag.

Se usar um Pix de baixo valor para validar a emissão e a baixa automática em produção, o pagamento movimenta dinheiro real. As cobranças anteriores continuam vinculadas à integração usada na emissão. Preserve as credenciais e webhooks anteriores enquanto houver pagamentos pendentes.
