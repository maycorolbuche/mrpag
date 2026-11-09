# MR Pag

Base de autenticação com Node.js 24, Express 5, SQLite e Bootstrap 5.3.8 servido localmente. Interface em português e responsiva; sem cadastro público.

## Executar

```sh
npm ci
cp .env.example .env
npm start
```

Abra http://localhost:3000. No Windows, use `copy .env.example .env`.

Primeiro acesso local:

- E-mail: `admin@mrpag.local`
- Senha: `MrPag@2026!Inicial`

A senha deve ser trocada antes de acessar a página inicial. A conta é criada apenas se o banco não tiver usuários; reiniciar não redefine credenciais. Personalize `ADMIN_EMAIL` e `ADMIN_PASSWORD` antes da primeira execução para usar um e-mail real. Não há rota de cadastro.

## Funcionalidades

- Login por e-mail e senha, mostrar/ocultar senha e opção lembrar por 30 dias (normal: 2 horas).
- Logout por POST, regeneração da sessão no login e após mudanças de senha.
- Alterar senha validando senha atual, confirmação e tamanho de 12 a 128 caracteres.
- Recuperação por e-mail, link com validade de 30 minutos e uso único; apenas o hash do token fica no banco.
- Mudanças de senha encerram as demais sessões e invalidam links de recuperação pendentes.
- Senhas com scrypt e salt aleatório, CSRF, cookies HttpOnly/SameSite, CSP e consultas parametrizadas.
- Limites persistentes por IP/conta para login, recuperação e alteração. Recuperação sempre responde de forma genérica, inclusive diante de falha do SMTP.

## Recuperação de senha local

Sem `SMTP_HOST` em desenvolvimento, os e-mails são gravados em `data/mail/*.json`, fora da pasta pública. Abra o arquivo mais recente e copie o link do campo `text`. O link usa `APP_URL`. A resposta da tela nunca revela o link. O endereço inicial `admin@mrpag.local` é apenas para testes locais.

## Produção e SMTP

1. Use Node.js 24 ou superior com suporte a `node:sqlite`. O servidor requer processo Node persistente; não roda como PHP nem hospedagem estática.
2. Configure `NODE_ENV=production`, `APP_URL=https://seu-dominio`, `SESSION_SECRET` aleatório (mínimo 32 caracteres) e, para banco vazio, `ADMIN_EMAIL` real e `ADMIN_PASSWORD` próprios.
3. Configure `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` e `MAIL_FROM` com remetente autorizado. Porta 587 usa STARTTLS obrigatório; porta 465 requer `SMTP_SECURE=true` (TLS direto). Certificados são verificados.
4. Termine HTTPS em proxy confiável. Configure `TRUST_PROXY_HOPS` somente conforme o número de proxies da sua instalação (por exemplo, `1` para um proxy). O serviço Node deve ficar acessível apenas pelo proxy. Cookies são Secure em produção.
5. Mantenha `DATABASE_PATH` em volume persistente privado com permissão restrita. O SQLite guarda usuários, sessões, tokens e limites. Faça backup consistente usando a API de backup do SQLite; não copie apenas o arquivo principal enquanto o banco estiver ativo em WAL. Esta base usa uma instância do app; planeje armazenamento compartilhado para escalar.
6. Configure SMTP e teste o recebimento com seu provedor antes de disponibilizar a recuperação. Falhas registram `password_reset_delivery_failed` sem expor o token. Não existe fallback de e-mail em arquivo em produção.

Gere o segredo: `node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))"`.

## Testes

```sh
npm test
npx playwright install chromium
npm run test:browser
```

Testes de integração com banco isolado em memória cobrem autenticação, sessão, CSRF, troca inicial, recuperação, validade/uso único, revogação de sessões e limites. O teste de navegador exercita login, troca obrigatória, logout, recuperação, novo login e ausência de rolagem horizontal em cinco larguras (320 a 1440 px). GitHub Actions executa ambos em Node 24. O envio SMTP real depende das credenciais do ambiente e não é exercitado por estes testes.

## Estrutura

- `src/app.js`: rotas e políticas de autenticação.
- `src/database.js`: criação idempotente de tabelas e store de sessões SQLite.
- `src/security.js`: senhas, tokens e limites.
- `src/mail.js`: SMTP e caixa de saída local.
- `views/`: páginas renderizadas no servidor.
- `public/`: estilos e interação progressiva (formulários funcionam sem JavaScript).
- `tests/`: testes automatizados.

A página inicial é uma base para os próximos módulos, sem dados financeiros fictícios.
