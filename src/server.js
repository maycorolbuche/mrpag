import { createServer } from 'node:http';
import { createApp } from './app.js';

const port = Number(process.env.PORT || 3000);
let app;
let server;
try {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT deve ser um número inteiro entre 0 e 65535.');
  app = await createApp();
  server = createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => { server.removeListener('error', reject); resolve(); });
  });
  console.log(`MR Pag disponível em ${process.env.APP_URL || `http://localhost:${server.address().port}`}`);
} catch (error) {
  if (error.code === 'EADDRINUSE') console.error(`Não foi possível iniciar o MR Pag: a porta ${port} já está em uso. Feche o processo que a utiliza ou altere PORT e APP_URL no arquivo .env.`);
  else if (error.code === 'EACCES') console.error(`Não foi possível iniciar o MR Pag: sem permissão para escutar na porta ${port}. Escolha outra porta no arquivo .env.`);
  else console.error('Não foi possível iniciar o MR Pag:', error.message);
  app?.locals.db.close();
  process.exitCode = 1;
}

if (server?.listening) {
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    console.log(`Encerrando MR Pag (${signal}).`);
    server.close(() => { app.locals.db.close(); process.exitCode = 0; });
  });
}
