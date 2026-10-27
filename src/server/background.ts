import { randomUUID } from "node:crypto";
import type { DatabasePort } from "../shared/persistence.ts";
import type { Application } from "./application.ts";
import { aiServiceSettings } from "./config.ts";
import type { DiscoveryCycleReport } from "../modules/operations/discovery-types.ts";

const safeCode = (error: unknown) => error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : "WORKER_FAILED";
/** Run in the local web process, or a separate Postgres worker. Never open PGlite twice. */
export function startBackgroundWorkers(app: Pick<Application, "database" | "config" | "aiWorker" | "dshBackend"> & Partial<Pick<Application, "inspirationWorker" | "githubMaintenance" | "planningNotifications" | "retentionMaintenance" | "resourceLinkMaintenance" | "organizerNotifications">>, options: { onDiscoveryCycle?: (report: DiscoveryCycleReport) => void; onInspirationCycle?: (report: DiscoveryCycleReport) => void } = {}) {
  const controller = new AbortController(); const instanceId = randomUUID();
  // A progress heartbeat already in flight must finish before idle/stopped is
  // saved. This also keeps slow database writes from reversing worker state.
  const heartbeatWrites = new Map<string, Promise<void>>();
  const heartbeat = (kind: string, status: string, completed = false, errorCode: string | null = null) => {
    const write = (heartbeatWrites.get(kind) ?? Promise.resolve()).catch(() => {}).then(async () => {
      await app.database.query(`INSERT INTO backend_worker_heartbeats(worker_id,kind,status,last_seen_at,last_completed_at,error_code)
      VALUES($1,$2,$3,now(),CASE WHEN $4 THEN now() ELSE NULL END,$5)
      ON CONFLICT(worker_id) DO UPDATE SET status=$3,last_seen_at=now(),last_completed_at=CASE WHEN $4 THEN now() ELSE backend_worker_heartbeats.last_completed_at END,error_code=$5`, [`${instanceId}:${kind}`, kind, status, completed, errorCode]);
    });
    heartbeatWrites.set(kind, write);
    return write;
  };
  const wait = (ms: number) => new Promise<void>(resolve => {
    const stop = () => { clearTimeout(timer); controller.signal.removeEventListener("abort", stop); resolve(); };
    const timer = setTimeout(stop, ms); timer.unref(); controller.signal.addEventListener("abort", stop, { once: true });
    if (controller.signal.aborted) stop();
  });
  const loop = async (kind: string, interval: number, work: () => Promise<unknown>) => {
    while (!controller.signal.aborted) {
      let ticker: ReturnType<typeof setInterval> | undefined;
      let restingStatus = "idle", restingError: string | null = null;
      const stopTicker = () => { if (ticker) clearInterval(ticker); ticker = undefined; };
      try {
        await heartbeat(kind, "running");
        // stop() may arrive while the initial heartbeat is waiting on SQL.
        if (controller.signal.aborted) break;
        ticker = setInterval(() => { if (!controller.signal.aborted) void heartbeat(kind, "running").catch(() => {}); }, 15_000); ticker.unref();
        controller.signal.addEventListener("abort", stopTicker, { once: true });
        const result = await work();
        stopTicker();
        // A worker returning after cancellation cannot claim a fresh completion.
        if (controller.signal.aborted) break;
        if (["discovery", "inspiration"].includes(kind) && result && typeof result === "object" && "status" in result) {
          const report = result as { status: string; reason?: string; errors?: { code: string }[] };
          if (["failed", "cancelled"].includes(report.status)) { restingStatus = "failed"; restingError = safeCode({ code: report.reason ?? report.errors?.[0]?.code ?? "DISCOVERY_FAILED" }); await heartbeat(kind, restingStatus, false, restingError); }
          else await heartbeat(kind, "idle", report.status === "completed");
        } else if (result && typeof result === "object" && "errors" in result && Array.isArray(result.errors) && result.errors.length) {
          restingStatus = "failed"; restingError = safeCode(result.errors[0]); await heartbeat(kind, restingStatus, false, restingError);
        } else await heartbeat(kind, "idle", true);
      } catch (error) { stopTicker(); restingStatus = "failed"; restingError = safeCode(error); if (!controller.signal.aborted) await heartbeat(kind, restingStatus, false, restingError).catch(() => {}); }
      finally { stopTicker(); controller.signal.removeEventListener("abort", stopTicker); }
      // Keep a healthy, infrequent maintenance worker visible between cycles.
      let remaining = interval;
      while (!controller.signal.aborted && remaining > 0) {
        const slice = Math.min(60_000, remaining);
        await wait(slice); remaining -= slice;
        if (!controller.signal.aborted && remaining > 0) await heartbeat(kind, restingStatus, false, restingError).catch(() => {});
      }
    }
    await heartbeat(kind, "stopped").catch(() => {});
  };
  const running: Promise<void>[] = [];
  if (app.githubMaintenance) running.push(loop("github-maintenance", 300_000, () => app.githubMaintenance!.run()));
  if (app.retentionMaintenance) running.push(loop("retention-maintenance", 300_000, () => app.retentionMaintenance!.run()));
  if (app.resourceLinkMaintenance) running.push(loop("resource-links", 60_000, () => app.resourceLinkMaintenance!.runOnce({signal:controller.signal})));
  if (app.planningNotifications) running.push(loop("planning-notifications", 30_000, () => app.planningNotifications!.worker.runOnce({ signal: controller.signal })));
  if (app.organizerNotifications) running.push(loop("organizer-notifications", 10_000, () => app.organizerNotifications!.drain({ batchSize: 1 })));
  if (app.aiWorker) running.push(loop("ai", aiServiceSettings(app.config)?.workerPollMs ?? 2000, () => app.aiWorker!.runOnce()));
  if (app.dshBackend.sourceQueue) running.push(loop("source", 5000, async () => { await app.dshBackend.recoverSources(); if (controller.signal.aborted) return; return app.dshBackend.sourceQueue!.runOnce({ signal: controller.signal }); }));
  // This is only a scheduler check. The persistent discovery ledger decides
  // whether a paid search is due and whether its daily allowance permits it.
  if (app.dshBackend.discoveryWorker) running.push(loop("discovery", 10_000, async () => {
    const report = await app.dshBackend.discoveryWorker!.runOnce({ signal: controller.signal });
    // Reporting cannot change accounting or turn a completed cycle into a failure.
    try { options.onDiscoveryCycle?.(report); } catch { /* Isolated observer. */ }
    return report;
  }));
  if (app.inspirationWorker) running.push(loop("inspiration", 10_000, async () => {
    const report = await app.inspirationWorker!.runOnce({ signal: controller.signal });
    try { options.onInspirationCycle?.(report); } catch { /* Isolated observer. */ }
    return report;
  }));
  return { async stop() { controller.abort(); await Promise.allSettled(running); }, signal: controller.signal };
}
export async function readBackgroundStatus(database: DatabasePort) {
  const result = await database.query<{ kind: string; status: string; last_seen_at: string | Date; last_completed_at: string | Date | null; error_code: string | null }>(
    "SELECT DISTINCT ON(kind) kind,status,last_seen_at,last_completed_at,error_code FROM backend_worker_heartbeats ORDER BY kind,(status<>'stopped' AND last_seen_at>now()-interval '120 seconds') DESC,last_seen_at DESC");
  return result.rows.map(row => ({ kind: row.kind, status: Date.now() - new Date(row.last_seen_at).getTime() > 120_000 && row.status !== "stopped" ? "stale" : row.status,
    lastSeenAt: new Date(row.last_seen_at).toISOString(), lastCompletedAt: row.last_completed_at ? new Date(row.last_completed_at).toISOString() : null, errorCode: row.error_code }));
}
