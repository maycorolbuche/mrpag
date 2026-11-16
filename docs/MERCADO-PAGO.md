# Integrar o MR Pag com o Mercado Pago

O MR Pag usa o Mercado Pago para emitir cobranças Pix avulsas e acompanhar o pagamento. Depois da configuração inicial no Cloudflare e no Mercado Pago Developers, cada conta no MR Pag pode autorizar sua própria conta recebedora pelo botão **Conectar Mercado Pago**.

## 1. Configure a aplicação no Mercado Pago Developers

1. Abra [Suas integrações](https://www.mercadopago.com.br/developers/panel/app) e selecione ou crie uma aplicação para o MR Pag. Escolha **Checkout Transparente → API de Orders** quando essas opções aparecerem. As novas cobranças Pix usam `/v1/orders`.
2. Nos **Detalhes da aplicação**, clique em **Editar**. Adicione a URL de redirecionamento `https://mrpag.mxsoft.com.br/account/payments/mercado-pago/callback` e habilite **PKCE** para o fluxo de código de autorização. Se usar outro domínio, substitua a origem pelo valor de `APP_URL`. A URL de retorno precisa coincidir com a registrada no Mercado Pago.
3. Copie o **Client ID** e o **Client Secret** da aplicação. Os dois valores identificam a aplicação na troca e na renovação de tokens.
4. Na mesma aplicação, abra **Configuração de webhooks** e selecione **Produção**. Cadastre `https://mrpag.mxsoft.com.br/webhooks/mercado-pago/oauth`, marque **Order (Mercado Pago)** e salve. Se a mesma aplicação já tiver cobranças emitidas pela API anterior, mantenha também **Pagamentos (legacy)**. Copie a **assinatura secreta** exibida após salvar. Preserve as URLs das integrações manuais antigas enquanto houver pagamentos pendentes. Se uma delas já ocupar a URL de Produção desta aplicação, use uma aplicação dedicada ao OAuth para manter o webhook antigo cadastrado.
5. Para um ambiente de homologação, cadastre o webhook e a URL de redirecionamento públicos desse ambiente e use a aba **Teste** para o webhook. Configure `MERCADO_PAGO_OAUTH_MODE=test` no Worker de homologação. A emissão de Pix depende dos meios habilitados pelo Mercado Pago naquele ambiente.

[Documentação do OAuth e PKCE](https://www.mercadopago.com.br/developers/pt/docs/split-payments/split-1-1/additional-content/security/oauth/creation)

## 2. Configure o Worker no Cloudflare

Em **Workers & Pages → mrpag → Settings → Variables and Secrets**, adicione os valores abaixo como **Secret**. O deploy da `main` aplica a migration automaticamente. Confira também se `CLOUDFLARE_APP_URL` corresponde ao domínio HTTPS cadastrado na etapa anterior.

| Secret | Valor |
| --- | --- |
| `MERCADO_PAGO_CLIENT_ID` | Client ID da aplicação |
| `MERCADO_PAGO_CLIENT_SECRET` | Client Secret da aplicação |
| `MERCADO_PAGO_WEBHOOK_SECRET` | Assinatura secreta do webhook OAuth |
| `PAYMENT_INTEGRATION_KEY` | Chave de criptografia existente do Worker |

Se for uma instalação nova sem `PAYMENT_INTEGRATION_KEY`, gere uma chave hexadecimal de 64 caracteres com `node -p "require('node:crypto').randomBytes(32).toString('hex')"`. Preserve a chave e as credenciais da aplicação nos próximos deploys para que o MR Pag consiga ler e renovar as conexões salvas. Em homologação, use uma instalação e um D1 separados da produção.

## 3. Autorize a conta que receberá os Pix

1. No MR Pag, abra **Cobranças → Integrações** e clique em **Conectar Mercado Pago**.
2. Entre no Mercado Pago com a conta que receberá os Pix e autorize o MR Pag na página do provedor.
3. Ao voltar, confira o número da **Conta Mercado Pago** e o ambiente exibido. As novas cobranças usarão essa conta. Se trocar de recebedor, as cobranças anteriores continuam vinculadas à conexão usada na emissão.
4. Se o acesso for revogado, clique em **Conectar Mercado Pago** e autorize novamente a mesma conta recebedora para recuperar o acesso às cobranças vinculadas àquela conexão OAuth.

## 4. Emita e confira a primeira cobrança

1. Em **Clientes**, escolha um cadastro ativo com **e-mail e CPF ou CNPJ válidos**.
2. Abra **Cobranças → Nova cobrança**, selecione o cliente e informe **descrição, valor e vencimento**.
3. Clique em **Gerar Pix**. Confira o valor, a situação e o **QR Code** ou **Pix copia e cola** nos detalhes da cobrança.
4. Clique em **Consultar situação** para verificar se o MR Pag consegue buscar o pagamento na API. Em localhost, use essa opção para acompanhar a situação.
5. O teste de entrega de webhook no painel ajuda a confirmar que a URL recebe a notificação. Para validar a baixa de ponta a ponta, use uma cobrança cujo status mude para aprovado no Mercado Pago. Reabra os detalhes **antes de clicar em Consultar situação** e confira se a situação já mudou para **Paga**. Assim você verifica se a atualização veio pelo webhook.

Se a emissão falhar, **Tentar emitir novamente** reutiliza a cobrança e a mesma chave de idempotência por até 15 minutos. Após esse prazo, confira o painel do Mercado Pago antes de emitir outra cobrança.

## Atualização de uma integração que já emitia Pix

As cobranças anteriores continuam usando a API de Payments, o token e o webhook da integração original. Mantenha a aplicação antiga, suas credenciais e o evento **Pagamentos (legacy)** ativos enquanto houver cobranças desse tipo em acompanhamento.

Se trocar a aplicação **OAuth** por outra, mantenha o webhook antigo apontando para `/webhooks/mercado-pago/oauth`. Antes de substituir os valores atuais no Cloudflare, configure `MERCADO_PAGO_LEGACY_CLIENT_ID`, `MERCADO_PAGO_LEGACY_CLIENT_SECRET` e `MERCADO_PAGO_LEGACY_WEBHOOK_SECRET` com os dados da aplicação anterior. Configure os secrets principais com os valores da nova aplicação e autorize novamente a conta pelo botão **Conectar Mercado Pago**. Se já usava a mesma aplicação e ela está habilitada para Orders, basta habilitar o novo evento no webhook, preservando o evento anterior.

## Configuração manual

A integração por Access Token continua disponível em **Configuração manual**. Use o token e a assinatura do ambiente escolhido. Para emitir cobranças reais, use as credenciais de produção e cadastre o webhook na aba **Produção**.


1. No **MR Pag publicado**, abra **Cobranças → Integrações → Configuração manual**. Copie a **URL do webhook** exibida junto ao formulário. Mantenha a aba aberta até salvar. Recarregar o formulário gera outro endereço para a integração que está sendo criada.
2. Em outra aba, abra a mesma aplicação no Mercado Pago e vá em **Webhooks** ou **Configuração de Webhooks**.
3. Selecione o ambiente **Teste**, cole a URL HTTPS copiada do MR Pag, marque o evento **Order (Mercado Pago)** e salve. Copie a **assinatura secreta** exibida na configuração.
4. Volte ao formulário do MR Pag. Cole o **Access Token** e a **Assinatura secreta do webhook** da mesma aplicação e do mesmo ambiente.
5. Clique em **Salvar integração manual**. A tela deve mostrar **Integração ativa** e a URL do webhook ativo. Confira se ela corresponde à cadastrada no painel do Mercado Pago.


[Guia oficial de migração de Payments para Orders](https://www.mercadopago.com.br/developers/pt/docs/checkout-api-orders/resources/migrate-payments-to-orders)

## Link de pagamento e envio por e-mail

Novas cobranças com Pix disponível entram na fila de e-mail automaticamente. O Worker processa a fila a cada cinco minutos com o provedor definido em `MAIL_MODE`. O MR Pag aceita SMTP seguro da HostGator ou Resend. Veja como [configurar o envio de e-mails](CLOUDFLARE.md#enviar-pelo-smtp-do-cpanel-da-hostgator). O modo local `log` continua disponível para redefinição de senha.

Na tela da cobrança, copie o **Link de pagamento** ou use **Enviar por e-mail**. O link pode ser aberto sem login e mostra a situação da cobrança. Quando o MR Pag registra a baixa, a página aberta se atualiza automaticamente para **Paga**. Cobranças antigas já emitidas ficam disponíveis para compartilhamento e envio manual. A atualização do Worker não dispara e-mails retroativos.

O histórico mostra o destinatário, cada tentativa e a resposta do serviço. **Aceito pelo serviço de e-mail** indica que o provedor recebeu a mensagem para envio. Falhas temporárias são repetidas automaticamente. Se houver uma falha definitiva, corrija a causa e use **Enviar novamente por e-mail**.

Cada e-mail de cobrança inclui uma cópia oculta para o usuário que emitiu o Pix ou solicitou o reenvio. O MR Pag registra esse endereço ao agendar o e-mail, para que o envio automático e as novas tentativas usem o mesmo destinatário.

## Cobranças recorrentes

Em **Cobranças → Recorrências → Nova recorrência**, escolha o cliente, o valor, a descrição, o primeiro vencimento, a frequência e a antecedência de emissão. As frequências disponíveis são mensal, bimestral, semestral e anual. O primeiro vencimento define o dia de referência. Nos meses que não têm esse dia, o vencimento cai no último dia do mês.

O cron de cinco minutos gera um Pix por ciclo. Quando o Pix fica disponível, ele segue pela fila de e-mails já configurada. O pagador precisa pagar cada Pix. Se uma série estiver pausada, os ciclos que vencerem durante a pausa não são emitidos ao retomar.

O detalhe da série permite editar valor, descrição e antecedência para os próximos ciclos, pausar, retomar, encerrar e acompanhar as cobranças geradas. Para mudar cliente, frequência ou dia de referência, encerre a série e crie outra. As cobranças já geradas mantêm seu próprio vencimento e podem ser gerenciadas individualmente.

### Domínio alternativo no e-mail enviado ao Mercado Pago

No Worker de produção, em **Settings → Variables and Secrets**, adicione `MERCADO_PAGO_PAYER_EMAIL_DOMAIN` como **Text** se quiser substituir o domínio de `payer.email` nas próximas emissões. Informe somente o domínio, por exemplo `mxsoft.com.br`. O MR Pag mantém o e-mail real para seu envio automático. O reenvio manual usa o e-mail atual do cadastro.

A regra vale para cobranças avulsas e recorrentes. Para desativar a troca, remova ou esvazie a variável e publique a configuração. Cobranças já criadas, inclusive as que aguardam uma nova tentativa de emissão, mantêm a solicitação original ao Mercado Pago.

## Lembretes e confirmação de pagamento

Abra **Minha conta → Configurar e-mails de cobrança**. Ative os lembretes que quiser usar. Os horários seguem Brasília. O aviso inicial de uma cobrança avulsa segue no próximo ciclo da fila, a qualquer hora. Avisos de novas cobranças recorrentes e lembretes são enviados das 8h até antes das 10h. Avisos de novas recorrentes enfileirados após essa janela aguardam a próxima manhã, se a cobrança ainda estiver pendente e dentro do vencimento. Os lembretes são enviados três dias antes do vencimento, no dia ou três dias depois, conforme as opções da conta. Envios manuais e confirmações de pagamento seguem a fila normal ao longo do dia. O aviso pós-vencimento orienta o cliente a consultar a situação e falar com o recebedor se precisar de um novo Pix.

Antes de disparar um lembrete, o MR Pag consulta o Mercado Pago. Se a cobrança já estiver paga ou cancelada, a mensagem de cobrança é dispensada. Se a consulta falhar, o histórico registra a falha e agenda uma nova tentativa dentro da janela do aviso.

A confirmação de pagamento vem ativada e pode ser desligada nessa mesma tela. O e-mail é enfileirado uma vez na transição para **Paga**, seja pelo webhook ou por **Consultar situação**. A publicação da migration não envia confirmações retroativas. Os lembretes e confirmações aparecem no histórico de e-mails da cobrança.

Em **Minha conta → Configurar e-mails de cobrança**, use **Enviar teste** ao lado de cada modelo para recebê-lo no e-mail do usuário autenticado. As amostras usam valores e datas fictícios e indicam que são testes. O botão da amostra é ilustrativo. O envio de teste não cria cobranças nem salva preferências.
