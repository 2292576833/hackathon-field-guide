import { AsyncLocalStorage } from "node:async_hooks";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import { PostgresDiscoveryLedger } from "./discovery-postgres.ts";
import type { ContinuousDiscoveryConfig, DiscoveryCandidateInput, DiscoveryModelPort } from "./discovery-types.ts";
import { createContinuousDiscoveryWorker } from "./discovery-worker.ts";

/** Real ephemeral PostgreSQL WASM engine, only a test fixture; never an app backend. */
export async function discoveryDatabaseFixture(directory?: string) {
  const engine = new PGlite(directory); await engine.waitReady;
  await engine.exec(await readFile(new URL("./sql/discovery.sql", import.meta.url), "utf8"));
  await engine.exec(`CREATE TABLE IF NOT EXISTS operations_discovery_search_attempts (
    scheduler_id text NOT NULL REFERENCES operations_discovery_state(id), request_hash text NOT NULL,
    last_attempt_at timestamptz NOT NULL, cycle_token text NOT NULL, last_error_code text,
    PRIMARY KEY(scheduler_id,request_hash))`);
  await engine.exec("CREATE TABLE IF NOT EXISTS fixture_discovery_cards(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,canonical_url text UNIQUE NOT NULL,revision integer NOT NULL DEFAULT 1,payload jsonb NOT NULL)");
  const context = new AsyncLocalStorage<SqlExecutor>();
  const executor = (connection: Pick<PGlite, "query">): SqlExecutor => ({ async query<Row>(statement: string, parameters: readonly unknown[] = []) {
    const result = await connection.query(statement, [...parameters]);
    return { rows: result.rows as Row[], rowCount: result.rows.length || result.affectedRows || 0 };
  } });
  const direct = executor(engine);
  const database: DatabasePort = {
    query: (statement, parameters) => (context.getStore() ?? direct).query(statement, parameters),
    async transaction(work) {
      const current = context.getStore(); if (current) return work(current);
      return engine.transaction(tx => { const unit = executor(tx); return context.run(unit, () => work(unit)); });
    },
  };
  return { engine, database };
}
export const discoveryTestConfig: ContinuousDiscoveryConfig = {
  workerId: "fixture-worker", userAgent: "HackathonIntelBot/1.0", queries: ["AI hackathon 2026"],
  minimumIntervalMs: 60_000, recrawlAfterMs: 60_000, maxResultsPerQuery: 5, maxPagesPerCycle: 2,
  maxCycleDurationMs: 5000, fetchTimeoutMs: 1000, maxPageBytes: 65_536,
  searchCostMicrosPerCall: 1, modelCostReservationMicrosPerCall: 100,
  limits: { maxSearchCallsPerDay: 10, maxModelCallsPerDay: 20, maxEstimatedCostMicrosPerDay: 1000, currency: "USD" },
};
export const eventRegistrationEvidence = "Registration closes 2026-10-30T18:00:00+08:00.";
export const eventPageText = `2026 AI Hackathon welcomes all developers. Build a useful project and submit your demo. ${eventRegistrationEvidence} Prizes are not specified.`;
export const eventModelData = { isEvent: true, title: "2026 AI Hackathon", summary: "欢迎开发者提交作品的 AI 黑客松。",
  analysis: { fit: ["适合想完成小型作品的新人"], risks: ["日期尚未确认"], preparation: ["准备演示"], unknowns: ["费用和奖项未知"] },
  evidence: ["2026 AI Hackathon welcomes all developers."], registrationWindow: { status: "open" as const, closesAt: "2026-10-30T18:00:00+08:00", closesOn: null, evidence: [eventRegistrationEvidence] } };
let sequence = 0;
export function discoveryWorkerFixture(database: DatabasePort, overrides: Partial<ContinuousDiscoveryConfig> = {}, schedulerId = `fixture-${++sequence}`) {
  let milliseconds = Date.parse("2026-10-08T08:00:00Z"); const clock = { now: () => new Date(milliseconds) };
  const ledger = new PostgresDiscoveryLedger({ database, clock, id: schedulerId });
  const saved: DiscoveryCandidateInput[] = []; const fetches: string[] = [];
  const counters = { search: 0, model: 0, dns: 0 };
  const searchResults = [{ url: "https://events.hackathon.dev/event?utm_source=search", title: "2026 AI Hackathon", description: "An upcoming hackathon" }];
  const model: DiscoveryModelPort = { async request() { counters.model++; return { data: structuredClone(eventModelData), usage: { inputTokens: 100, outputTokens: 100, estimatedCostMicros: 10, currency: "USD" } }; } };
  const dependencies = { clock, config: { ...discoveryTestConfig, ...overrides }, ledger,
    search: { async search() { counters.search++; return searchResults; } }, model,
    candidates: { async save(input: DiscoveryCandidateInput) {
      saved.push(structuredClone(input));
      return database.transaction(async tx => {
        const result = await tx.query<{ id: string | number; revision: number }>(`INSERT INTO fixture_discovery_cards(canonical_url,payload) VALUES($1,$2::jsonb)
          ON CONFLICT(canonical_url) DO UPDATE SET revision=fixture_discovery_cards.revision+1,payload=EXCLUDED.payload RETURNING id,revision`, [input.canonicalUrl, JSON.stringify(input)]);
        return { id: String(result.rows[0]!.id), revision: result.rows[0]!.revision };
      });
    } },
    dns: { async resolve() { counters.dns++; return ["93.184.216.34"]; } },
    transport: { async request(input: { url: string }) {
      fetches.push(input.url);
      return { status: 200, connectedAddress: "93.184.216.34", contentType: "text/plain", body: new URL(input.url).pathname === "/robots.txt" ? "User-agent: *\nAllow: /" : eventPageText };
    } },
  };
  const worker = createContinuousDiscoveryWorker(dependencies);
  return { worker, dependencies, ledger, saved, fetches, counters, searchResults, clock, schedulerId,
    advance: (amount: number) => { milliseconds += amount; } };
}
