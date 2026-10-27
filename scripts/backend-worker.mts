import { setTimeout as delay } from "node:timers/promises";
import { loadConfig } from "../src/server/config.ts";
import { createApplication } from "../src/server/application.ts";
import { startBackgroundWorkers } from "../src/server/background.ts";

try { process.loadEnvFile(".env.local"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("WORKER_ENV_INVALID"); }
const config = await loadConfig();
if (!config.databaseUrl) throw new Error("BACKEND_WORKER_REQUIRES_POSTGRES_DATABASE_URL");
const app = await createApplication(config);
if (!app.aiWorker && !app.dshBackend.sourceQueue && !app.dshBackend.discoveryWorker) throw new Error("BACKEND_WORKER_NOT_CONFIGURED");
const workers = startBackgroundWorkers(app);
let stopping = false;
const onStop = () => { stopping = true; };
process.once("SIGINT", onStop); process.once("SIGTERM", onStop);
try { while (!stopping) await delay(1000); }
finally { await workers.stop(); await app.database.close(); process.removeListener("SIGINT", onStop); process.removeListener("SIGTERM", onStop); }
