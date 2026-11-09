# MR Pag — Cloudflare Workers + D1

Aplicação única com páginas renderizadas no Worker, Bootstrap 5.3.8 e assets no mesmo deploy. D1 persiste usuários, sessões, tokens de recuperação e limites de tentativas. Não é necessário separar frontend/API ou criar projeto no Pages.

## Rodar localmente (PowerShell)

Requer Node.js 24 ou superior. Não precisa entrar na conta Cloudflare para testar localmente.

```powershell
npm ci
Copy-Item .dev.vars.example .dev.vars
npm run db:migrate:local
npm run db:seed:local
npm start
```

Abra **http://localhost:8787**. Usuário: `admin@mrpag.local`; senha: `MrPag@2026!Inicial`. A troca é obrigatória no primeiro acesso. Em `MAIL_MODE=log`, o link de recuperação aparece no terminal, somente em ambiente localhost. Este modo é bloqueado em domínio público.

`npm start` e `npm run dev` executam o Wrangler, com recarregamento automático, build de templates e assets. O estado local fica em `.wrangler/state`, separado do banco remoto. O antigo `.env` e `data/mrpag.sqlite` não são usados. Não exclua um banco anterior se quiser conservar seus dados.

## Publicar e avaliar no Cloudflare

Siga [o passo a passo completo](docs/CLOUDFLARE.md), com criação do D1, secrets, administrador, envio de e-mail, deploy e integração opcional com GitHub.

Comandos de uso recorrente:

```sh
npm run cf:login
npm run db:migrate:remote
npm run db:seed:remote
npm run deploy
```

`npm run deploy` aplica migrations remotas antes de publicar o Worker e seus assets. O seed é separado e nunca sobrescreve uma conta existente. Os recursos remotos não são criados pelos testes nem pelo build.

## Autenticação

Login, lembrar por 30 dias (normal: 2 horas), logout, troca inicial obrigatória, alteração validando senha atual e recuperação por e-mail. Links expiram em 30 minutos, têm uso único inclusive sob concorrência e são guardados como hash. Mudanças de senha invalidam outras sessões e links pendentes. Sem cadastro público.

Cookies opacos de 256 bits, apenas hash persistido em D1, HttpOnly/SameSite e Secure em HTTPS. Formulários têm CSRF e validação de Origin. Limites de tentativas persistem no D1 por IP e conta. A configuração de origem pública é fixa, evitando construir links de recuperação com um Host fornecido pelo visitante.

As senhas agora usam PBKDF2-SHA256 (100.000 iterações, limite do WebCrypto do Workers), salt aleatório e HMAC com um `PASSWORD_PEPPER` secreto fora do banco. Esse segredo deve ser preservado: alterá-lo invalida a verificação das senhas existentes; a recuperação poderá definir novas senhas com o novo segredo. Não há SESSION_SECRET: a sessão é um token aleatório opaco, não um objeto assinado no cookie.

O Cron diário remove sessões, tokens e contadores expirados. A validade também é verificada em cada uso; não depende da execução do Cron.

## E-mails

- `MAIL_MODE=disabled`: login/troca funcionam; recuperação informa que não está configurada.
- `MAIL_MODE=log`: teste exclusivamente local, com link no terminal.
- `MAIL_MODE=resend`: envio real via HTTPS usando `RESEND_API_KEY` e `MAIL_FROM`.

A resposta da recuperação é genérica para e-mail existente/desconhecido e falhas do provedor. Um erro de envio invalida o token gerado e registra somente um código de erro. Não há envio SMTP/Nodemailer nesta versão.

## Validação

```sh
npm ci
npm test
npx playwright install chromium
npm run test:browser
npm run check
```

Integração executa o Worker real em Miniflare/workerd e D1 local, incluindo concorrência no uso único de tokens. O teste de navegador percorre login, alteração obrigatória, logout, recuperação e novo login, com verificação de largura de 320 a 1440 px. O envio externo é simulado nos testes; receber e-mail real requer configurar e testar seu provedor. `check` gera o pacote final com Wrangler em dry-run, sem publicar.

## Organização

- `src/worker.js`: entrada fetch/cron, rotas e sessões.
- `src/security.js`: WebCrypto, senhas, tokens e limites.
- `src/mail.js`: envio por API.
- `migrations/`: esquema D1 versionado.
- `views/`: templates EJS mantidos como fonte; compilados antes do deploy.
- `scripts/build.mjs`: transforma templates em JS estático e prepara assets. O Worker não usa eval nem lê templates em disco.
- `scripts/seed.mjs`: provisionamento do primeiro usuário via Wrangler, com arquivo temporário removido ao final.
- `public/`: estilos, interação progressiva e ícone.
- `tests/` e `e2e/`: testes de integração e navegador.

Esta migração substitui Express/SQLite em arquivo pela API Fetch/D1. Contas e senhas antigas não são importadas automaticamente. Como estamos na base inicial, o guia provisiona uma nova conta. Nenhum dado antigo é apagado pelos comandos locais.
