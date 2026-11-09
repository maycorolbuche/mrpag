import { createApp } from './app.js';
const app = await createApp();
const server = app.listen(Number(process.env.PORT || 3000), () => console.log(`MR Pag disponível em ${process.env.APP_URL || 'http://localhost:3000'}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => { app.locals.db.close(); process.exit(0); }));
