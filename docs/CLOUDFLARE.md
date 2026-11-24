# Configurar o MR Pag no Cloudflare

## O que será criado

Um Worker chamado `mrpag`, com as páginas e os arquivos estáticos no mesmo deploy; um D1 chamado `mrpag-db`; um secret para proteger senhas. Todos os acessos usam um domínio, por exemplo `https://mrpag.seu-subdominio.workers.dev`. Não crie aplicação no Pages nem um frontend separado.

O repositório não contém credenciais de Cloudflare e não cria serviços pagos automaticamente. Observe uso e limites do plano no painel de Workers/D1 e do provedor de e-mail antes de disponibilizar para usuários reais. Este guia permite avaliar primeiro localmente e depois em um endereço workers.dev.

## 1. Baixar a alteração e testar localmente

Se ainda não fez merge, pode avaliar a branch:

```powershell
git fetch origin
git switch --track origin/feat/cloudflare-worker
npm ci
Copy-Item .dev.vars.example .dev.vars
npm run db:migrate:local
npm start
```

Se a branch já existir localmente, use `git switch feat/cloudflare-worker`. Após o merge, pode usar `git switch main` e `git pull origin main`.

Antes da primeira migration, ajuste `SEED_EMAIL` e `SEED_PASSWORD` no `.dev.vars` se quiser credenciais próprias. `npm run db:migrate:local` também cria o primeiro administrador quando o banco estiver vazio. Abra http://localhost:8787, entre com as credenciais configuradas e troque a senha inicial. Os valores do exemplo são `admin@mrpag.local` e `MrPag@2026!Inicial`. Teste logout, login, alterar senha e esqueci a senha. O link de recuperação aparece no terminal com `MAIL_MODE=log`. Não é necessário login Cloudflare nesta etapa.
Se `SEED_EMAIL` ou `SEED_PASSWORD` estiver ausente no ambiente local, o seed usa o valor padrão correspondente. A senha inicial pode ter um único caractere. A troca obrigatória no primeiro acesso exige uma nova senha de 12 a 128 caracteres.


O seed é idempotente: executá-lo de novo não redefine a senha. As tabelas locais e remotas são separadas; os usuários criados localmente não aparecem no remoto. O `.env` da versão Express não é lido pelo novo projeto. Preserve `data/` caso queira consultar o banco anterior.

Para mudar a porta local, rode `npm start -- --port 8788` e altere o `APP_URL` de `.dev.vars` para `http://localhost:8788`.

## 2. Entrar na conta Cloudflare

Pare o servidor local com Ctrl+C e execute:

```powershell
npm run cf:login
```

O Wrangler abrirá o navegador para autorizar sua conta. Se necessário, confira com `npx wrangler whoami`. As credenciais ficam no seu computador, não no código.

## 3. Criar e vincular o D1

```powershell
npx wrangler d1 create mrpag-db
```

Copie o `database_id` retornado. Em `wrangler.jsonc`, substitua apenas o UUID zerado pelo ID real, mantendo o nome e o binding:

```json
"d1_databases": [{
  "binding": "DB",
  "database_name": "mrpag-db",
  "database_id": "ID-REAL-DO-BANCO",
  "migrations_dir": "migrations"
}]
```

Se o Wrangler oferecer configurar automaticamente, confira o resultado no arquivo. Não adicione um segundo binding `DB`. Se já houver banco com esse nome, use `npx wrangler d1 list` para obter seu ID em vez de criar novamente.

No painel, o banco fica em **Storage & databases → D1**. O Worker terá o binding pelo arquivo de configuração no deploy; não é preciso duplicar manualmente no painel.

## 4. Definir a URL e publicar a estrutura

Em **Workers & Pages**, confira o subdomínio `workers.dev` da sua conta (ou conclua a configuração se ainda não houver). Em `wrangler.jsonc`, substitua:

```json
"vars": {
  "APP_URL": "https://mrpag.seu-subdominio.workers.dev",
  "MAIL_MODE": "disabled"
}
```

`APP_URL` deve ser só a origem: sem `/login`, parâmetros ou credenciais. Não deixe `SEU-SUBDOMINIO` nem `localhost` na configuração publicada.

```powershell
npm run deploy
```

Esse comando aplica as migrations remotas, compila os templates, prepara Bootstrap/CSS/JS e publica tudo junto. Não executa o seed. Confirme as migrations quando o Wrangler perguntar.

O projeto usa um único Cron Trigger, `*/5 * * * *`. Ele processa as recorrências e a fila de e-mails a cada cinco minutos. A limpeza de sessões, recuperações de senha e tentativas expiradas roda nesse mesmo cron, às 04h UTC (01h de Brasília). O deploy atualiza os agendamentos do Worker e remove o antigo trigger diário.

O terminal informa a URL definitiva. Se for diferente da que colocou em `APP_URL`, corrija e execute `npm run deploy` novamente. Neste momento a aplicação ainda pode responder com erro de configuração: falta cadastrar o secret e criar o administrador nos passos seguintes.

## 5. Criar o secret e o administrador remoto

Gere uma chave aleatória:

```powershell
node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))"
```

Guarde esse valor em local privado. Ele será o `PASSWORD_PEPPER`. Configure no Worker:

```powershell
npx wrangler secret put PASSWORD_PEPPER
```

Cole o valor quando solicitado. O mesmo valor precisa ser usado para gerar a senha do primeiro administrador. Inclua os seguintes valores no mesmo `.dev.vars` usado para desenvolvimento:

```dotenv
REMOTE_PASSWORD_PEPPER=O-MESMO-VALOR-DO-SECRET
REMOTE_SEED_EMAIL=seu-email@seu-dominio.com.br
REMOTE_SEED_PASSWORD="Sua senha inicial"
```

Defina uma senha inicial para o acesso remoto. O arquivo é ignorado pelo Git. Se a senha contiver `#` ou espaços, mantenha as aspas. Execute:

```powershell
npm run db:seed:remote
```

Confirme a execução remota se solicitado. Um registro já existente nunca é sobrescrito pelo seed; ele não é uma ferramenta de redefinição de senha. Abra a URL publicada e entre com `REMOTE_SEED_EMAIL` e `REMOTE_SEED_PASSWORD`. A primeira troca é obrigatória. Após criar a conta, remova as três variáveis remotas do `.dev.vars` e preserve o pepper em um local seguro. Se você já usava `.seed.vars`, transfira os valores para os nomes `REMOTE_*` apenas se precisar provisionar uma base remota vazia.

Não altere o pepper a cada deploy. Ele é necessário para conferir as senhas existentes e não fica no D1. Nenhuma senha ou chave deve ser adicionada ao `wrangler.jsonc`.

## 6. Ativar esqueci a senha com envio real (opcional para avaliar o layout)

Com `MAIL_MODE=disabled`, login e alteração funcionam; a recuperação informa que ainda não está configurada.

Para habilitar o envio implementado:

1. Crie ou use uma conta no [Resend](https://resend.com).
2. Adicione e verifique um domínio de envio seguindo os registros DNS informados pelo provedor.
3. Crie uma API key com permissão de envio.
4. Cadastre a chave no Cloudflare:

```powershell
npx wrangler secret put RESEND_API_KEY
```

5. Ajuste as variáveis públicas em `wrangler.jsonc`:

```json
"vars": {
  "APP_URL": "https://mrpag.seu-subdominio.workers.dev",
  "MAIL_MODE": "resend",
  "MAIL_FROM": "MR Pag <acesso@seu-dominio.com.br>"
}
```

6. Execute `npm run deploy` e teste **Esqueci minha senha** com o e-mail real do administrador.

O remetente deve pertencer ao domínio autorizado pelo Resend. Contas de teste do provedor podem restringir destinatários. Verifique spam e o painel de envios. Os testes automatizados simulam o provedor; a entrega real só pode ser validada após esta configuração.

Nunca use `MAIL_MODE=log` em domínio público: a aplicação rejeita essa configuração para evitar exposição de links nos logs.

### Enviar pelo SMTP do cPanel da HostGator

1. No cPanel, abra **Contas de e-mail** e crie uma caixa, por exemplo `cobrancas@mxsoft.com.br`.
2. Na caixa criada, clique em **Conectar dispositivos** e procure **Configurações manuais → SSL/TLS seguro**. Anote o **Servidor de saída SMTP** da hospedagem e confira a porta **465**. Use o hostname indicado no cPanel, como `br00.hostgator.com.br`. O endereço precisa apontar para o servidor SMTP diretamente.
3. No Cloudflare, abra **Workers & Pages → mrpag → Production → Settings → Variables and Secrets**. Cadastre os valores abaixo e clique em **Deploy**.

| Nome | Tipo | Valor |
| --- | --- | --- |
| `MAIL_MODE` | Text | `smtp` |
| `SMTP_HOST` | Text | Hostname do SMTP seguro indicado no cPanel |
| `SMTP_USER` | Text | Endereço completo da caixa, por exemplo `cobrancas@mxsoft.com.br` |
| `SMTP_PASSWORD` | Secret | Senha da caixa de e-mail |
| `MAIL_FROM` | Text | `MR Pag <cobrancas@mxsoft.com.br>`, usando o endereço de `SMTP_USER` |

O Worker abre uma conexão TLS na porta 465 e autentica com a conta criada no cPanel. Os e-mails de cobrança usam a fila existente do cron de cinco minutos. A recuperação de senha usa o mesmo remetente. Se a conexão cair depois de o envio da mensagem começar e o SMTP não confirmar o resultado, confira a entrega antes de reenviar para evitar duplicidade.

[Configuração de e-mail seguro da HostGator](https://suporte.hostgator.com.br/hc/pt-br/articles/30820322757779-Como-configurar-uma-conta-de-e-mail-no-ThunderBird)


## 7. Publicações futuras

```powershell
git pull origin main
npm ci
npm run deploy
```

Migrations aplicadas não rodam novamente. O comando publica código/assets, preserva o D1 e não muda a senha do administrador. Os secrets continuam no Cloudflare. O Cron diário remove registros temporários expirados; validade e autorização são verificadas em cada requisição independentemente do Cron.

Se quiser usar seu domínio, adicione um **Custom Domain** ao Worker, atualize `APP_URL` e publique novamente. Mantenha a URL no `wrangler.jsonc` como fonte da configuração.

## 8. Deploy automático pelo GitHub Actions

Em **Settings → Secrets and variables → Actions** do repositório, configure:

| Tipo | Nome | Valor |
|---|---|---|
| Secret | `CLOUDFLARE_API_TOKEN` | Token da conta Cloudflare com **Workers Scripts: Edit** e **D1: Edit** |
| Variable | `CLOUDFLARE_ACCOUNT_ID` | ID da conta Cloudflare |
| Variable | `CLOUDFLARE_D1_DATABASE_ID` | UUID do D1 **mrpag-db** de produção |
| Variable | `CLOUDFLARE_APP_URL` | Origem HTTPS do MR Pag, por exemplo `https://mrpag.mxsoft.com.br` |

Depois que um push chegar à `main`, o workflow executa os testes, aplica as migrations pendentes no D1 e publica o Worker. A etapa de deploy usa uma cópia temporária da configuração com a URL e o banco de produção. Mantenha as variáveis de e-mail e os secrets da aplicação, como `PASSWORD_PEPPER` e `PAYMENT_INTEGRATION_KEY`, no Worker.

Acompanhe em **GitHub → Actions → Worker e autenticação → Deploy Cloudflare**. Se o primeiro deploy falhar por falta de configuração, salve os valores acima e use **Re-run failed jobs** no GitHub. Use o GitHub Actions como origem das publicações automáticas.


## 9. Logs e diagnóstico

```powershell
npx wrangler tail
```

Ou abra o Worker em **Workers & Pages → mrpag → Observability**. Erros de aplicação mostram uma referência `error_id`; procure-a nos logs. As mensagens detalham falhas de binding/configuração sem devolver detalhes internos ao navegador.

- **no such table:** execute `npm run db:migrate:remote` e confira o ID/binding DB.
- **Erro de configuração:** confira APP_URL e o secret PASSWORD_PEPPER.
- **Login inválido após seed:** confirme e-mail, senha e o mesmo pepper usado no seed e no Worker. Reexecutar seed não altera senha existente.
- **Recuperação indisponível:** configure MAIL_MODE, remetente autorizado e API key.
- **CSRF/sessão expirada:** confira se APP_URL corresponde exatamente à origem usada no navegador.

## Diferenças e limites para decidir

| Parte | Como ficou |
|---|---|
| Hospedagem | Um Worker com assets; sem servidor Node permanente |
| Banco | D1 vinculado ao Worker; sem arquivo SQLite da aplicação |
| Páginas | Mesmo visual; templates pré-compilados em JS estático |
| Senhas | WebCrypto com salt e pepper fora do D1 |
| E-mails | SMTP seguro ou Resend por HTTPS |
| Local | Wrangler + D1 emulado, porta 8787 |
| Deploy | Wrangler; migrations antes do deploy |

O Node.js é usado nas ferramentas locais/build, não como processo Express em produção. D1 é um recurso separado administrativamente, mas o usuário acessa uma aplicação única. Não há migração automática do banco antigo: a estrutura inicial provisiona uma conta nova e preserva os arquivos antigos no seu computador.

Se decidir voltar à implementação anterior, volte o código para o commit anterior ao PR e use o banco antigo; contas criadas no D1 não serão sincronizadas de volta. Você pode interromper a avaliação sem excluir o Worker/D1. Se optar por excluir recursos, isso precisa ser feito conscientemente no painel; a troca de branch não os remove.

Referências oficiais:

- [Workers com assets](https://developers.cloudflare.com/workers/static-assets/)
- [Criar e vincular D1](https://developers.cloudflare.com/d1/get-started/)
- [Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Envio com Resend](https://developers.cloudflare.com/workers/tutorials/send-emails-with-resend/)
- [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)

## Atualização com contas e clientes

Para quem já configurou a versão anterior, basta aplicar este PR e publicar com `npm run deploy` (ou o deploy automático já configurado com esse comando). Ele aplica `0002_accounts_customers.sql` antes de publicar o Worker. Não recrie o banco, não troque o pepper e não repita o seed.

Cada usuário existente recebe uma conta própria. Senhas e sessões válidas são preservadas, agora com o vínculo à conta. No menu **Minha conta**, personalize o nome. Em **Clientes**, teste cadastro, detalhes, edição, busca, filtro de situação e inativação/reativação. O banco novo continua usando migrations + seed conforme os passos anteriores.

A atualização é uma migration para frente; não há comando de rollback destrutivo incluído. Caso precise reverter uma implantação em produção, preserve um backup/ponto de restauração do D1 e avalie a compatibilidade do código antes de voltar a versão. A migration adiciona estruturas e não apaga dados anteriores.
