import { config } from './config/index.js';
import { pool } from './db/pool.js';
import { runMigrations } from './db/migrate.js';
import { buildApp } from './app.js';
import { startCallbackWorker, stopCallbackWorker } from './callbacks/worker.js';
import { startExpiryJob, stopExpiryJob } from './jobs/expiry.js';
import { startRefundJob, stopRefundJob } from './jobs/refunds.js';

await runMigrations();
const server = buildApp().listen(config.port, () => console.log(`payment service on :${config.port}`));


await startCallbackWorker();
startExpiryJob();
startRefundJob();

async function shutdown() {
  stopCallbackWorker(); stopExpiryJob(); stopRefundJob();
  server.close(() => pool.end().finally(() => process.exit(0)));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);