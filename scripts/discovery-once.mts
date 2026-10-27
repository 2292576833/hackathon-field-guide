import { createConnection } from "node:net";
import { loadConfig } from "../src/server/config.ts";
import { createDatabase } from "../src/server/database.ts";
import { createApplication } from "../src/server/application.ts";
import { DomainError } from "../src/shared/errors.ts";

// Operator-only first activation. Do not open persistent PGlite concurrently
// with the website. Automatic recurring work is owned by background.ts.
const config = await loadConfig();
if (!config.discovery) throw new Error("DISCOVERY_NOT_CONFIGURED");
if (config.localDatabasePath) {
  const listening = await new Promise<boolean>(resolve => {
    const socket = createConnection({ host: "127.0.0.1", port: 3000 });
    const done = (result: boolean) => { socket.destroy(); resolve(result); };
    socket.once("connect", () => done(true)); socket.once("error", () => done(false)); socket.setTimeout(1500, () => done(true));
  });
  if (listening) throw new Error("STOP_LOCAL_WEBSITE_BEFORE_PGLITE_OPERATOR_TASK");
}
const database = await createDatabase({ connectionString: config.databaseUrl, localPath: config.localDatabasePath });
try {
  const app = await createApplication(config, database);
  if (!app.dshBackend.discoveryWorker) throw new Error("DISCOVERY_WORKER_UNAVAILABLE");
  if (process.argv.includes("--activate-native")) {
    if (config.discovery.provider !== "dsh_native") throw new Error("NATIVE_DISCOVERY_NOT_CONFIGURED");
    await app.dshBackend.status(); // Initializes the scheduler through its owned ledger.
    await database.transaction(async tx => {
      const state = (await tx.query<{ paused: boolean; lease_expires_at: Date | null; next_eligible_at: Date | null }>("SELECT paused,lease_expires_at,next_eligible_at FROM operations_discovery_state WHERE id=$1 FOR UPDATE", ["event-discovery"])).rows[0]!;
      if (state.paused || (state.lease_expires_at && new Date(state.lease_expires_at).getTime() > Date.now())) throw new Error("DISCOVERY_PAUSED_OR_BUSY");
      const activated = await tx.query("INSERT INTO operations_discovery_activations(scheduler_id,activation_id,actor_id,previous_next_eligible_at,occurred_at) VALUES($1,$2,$3,$4,now()) ON CONFLICT DO NOTHING RETURNING activation_id", ["event-discovery", "field-dsh-native-search-v1", "local-operator:explicit-native-activation", state.next_eligible_at]);
      if (activated.rows.length) await tx.query("UPDATE operations_discovery_state SET revision=revision+1,next_eligible_at=now() WHERE id=$1", ["event-discovery"]);
      console.log(JSON.stringify({ phase: "activation", advancedSchedule: activated.rows.length === 1, preservedQuotasAndUnknownAttempts: true }));
    });
  }
  console.log(JSON.stringify({ phase: "started", provider: config.discovery.provider, queryCount: config.discovery.worker.queries.length, maxPages: config.discovery.worker.maxPagesPerCycle }));
  const report = await app.dshBackend.discoveryWorker.runOnce();
  const result = await app.discoveries.list(); const status = await app.dshBackend.status();
  console.log(JSON.stringify({ phase: "finished", report, cardCount: result.items.length,
    cards: result.items.map(item => ({ title: item.title, url: item.canonicalUrl, sourceKinds: item.sources.map(source => source.sourceKind ?? "page"), verificationStatus: item.verificationStatus, revision: item.revision })),
    state: { modelCalls: status.state.modelCalls, searchCalls: status.state.searchCalls, estimatedCostMicros: status.state.estimatedCostMicros, lastErrorCode: status.state.lastErrorCode, lastCompletedAt: status.state.lastCompletedAt, nextEligibleAt: status.state.nextEligibleAt } }));
  if (report.status === "failed") process.exitCode = 1;
} catch (error) {
  console.log(JSON.stringify({ phase: "failed", code: error instanceof DomainError ? error.code : "DISCOVERY_CHECK_FAILED" })); process.exitCode = 1;
} finally { await database.close(); }
