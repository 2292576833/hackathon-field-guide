import { setTimeout as delay } from "node:timers/promises";
import { createApplication } from "../src/server/application.ts";
import { loadConfig } from "../src/server/config.ts";
import type { createAiWorker } from "../src/server/ai-jobs.ts";

try { process.loadEnvFile(".env.local"); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("AI_WORKER_ENV_INVALID"); }
const once = process.argv.includes("--once");
const localExclusive = process.argv.includes("--local-exclusive");
const pollMs = Number(process.env.AI_WORKER_POLL_MS ?? 2000);
if (!Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > 60_000) throw new Error("AI_WORKER_POLL_INVALID");
// Normal local preview uses its in-process worker. PGlite cannot be opened safely
// by this separate process while the website holds the same local data directory.
// --local-exclusive is only for maintenance with the local website fully stopped.
if (!process.env.DATABASE_URL && !localExclusive) throw new Error("AI_WORKER_REQUIRES_DATABASE_URL_OR_EXCLUSIVE_LOCAL_MODE");
let stop = false;
const onStop = () => { stop = true; };
process.once("SIGINT", onStop); process.once("SIGTERM", onStop);
const app = await createApplication(await loadConfig());
try {
  // Root composition supplies real module adapters plus the durable worker.
  const worker = (app as typeof app & { aiWorker?: ReturnType<typeof createAiWorker> }).aiWorker;
  if (!worker) throw new Error("AI_WORKER_NOT_CONFIGURED");
  do {
    const result = await worker.runOnce();
    // Execution IDs and safe outcome codes only; no prompts, answers, credentials or provider body.
    if (result.processed) process.stdout.write(`${JSON.stringify({ executionId: result.executionId, status: result.status, errorCode: result.errorCode })}\n`);
    if (!once && !stop && !result.processed) await delay(pollMs);
  } while (!once && !stop);
} catch (error) {
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : "AI_WORKER_FAILED";
  process.stderr.write(`${code}\n`); process.exitCode = 1;
} finally { await app.database.close(); process.removeListener("SIGINT", onStop); process.removeListener("SIGTERM", onStop); }
