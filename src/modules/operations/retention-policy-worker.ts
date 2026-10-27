import { DomainError } from "../../shared/errors.ts";
import type { RetentionCleanupReport, RetentionCleanupRequest, RetentionPreview,
  RetentionPreviewQuery, RetentionService } from "./retention-policy-service.ts";

export interface RetentionWorkerDependencies {
  readonly service: RetentionService;
  /** Root service-auth integration; never take a website request's identity/credential. */
  readonly getServiceCredential: () => Promise<string>;
}
export interface RetentionWorker {
  dryRunOnce(query?: RetentionPreviewQuery): Promise<RetentionPreview>;
  /** Explicit call required. This worker does not turn a dry-run into a deletion automatically. */
  cleanupOnce(request: RetentionCleanupRequest): Promise<RetentionCleanupReport>;
}
/** Bounded single-page worker. Root chooses schedule/enablement; no timers, crawler or paid calls. */
export function createRetentionWorker(deps: RetentionWorkerDependencies): RetentionWorker {
  let running = false;
  async function once<T>(work: (credential: string) => Promise<T>): Promise<T> {
    if (running) throw new DomainError("RETENTION_WORKER_BUSY", "临时内容维护正在运行。", { status: 409 });
    running = true;
    try { return await work(await deps.getServiceCredential()); }
    finally { running = false; }
  }
  return {
    dryRunOnce: (query = {}) => once(credential => deps.service.preview(credential, query)),
    cleanupOnce: request => once(credential => deps.service.cleanup(credential, request)),
  };
}
