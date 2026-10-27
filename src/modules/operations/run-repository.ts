import type { ExecutionAudit, SourceConfig } from "./source-domain.ts";
import type { ExecutionKind, ExecutionRun } from "./run-domain.ts";

export interface OperationsExecutionTransaction {
  acquireLock(key: string): Promise<void>;
  getSource(id: string, lock?: boolean): Promise<SourceConfig | null>;
  insertSource(source: SourceConfig): Promise<void>;
  saveSource(source: SourceConfig, expectedRevision: number): Promise<void>;
  reserveSourceInterval(sourceId: string, nextEligibleAt: string): Promise<void>;
  recordSourceHealth(sourceId: string, success: boolean, at: string): Promise<void>;
  getRun(id: string, lock?: boolean): Promise<ExecutionRun | null>;
  findIdempotentRun(actorId: string, kind: ExecutionKind, key: string): Promise<{ run: ExecutionRun; fingerprint: string } | null>;
  bindIdempotencyRun(actorId: string, kind: ExecutionKind, key: string, fingerprint: string, runId: string): Promise<void>;
  findActiveCrawl(sourceConfigId: string): Promise<ExecutionRun | null>;
  findReusableAnalysis(sourceConfigId: string, fingerprint: string): Promise<ExecutionRun | null>;
  insertRun(run: ExecutionRun): Promise<void>;
  saveRun(run: ExecutionRun, expectedRevision: number): Promise<void>;
  appendAudit(event: ExecutionAudit): Promise<void>;
}
export interface OperationsExecutionRepository {
  transaction<T>(work: (tx: OperationsExecutionTransaction) => Promise<T>): Promise<T>;
  getSource(id: string): Promise<SourceConfig | null>;
  listSources(limit: number): Promise<readonly SourceConfig[]>;
  getRun(id: string): Promise<ExecutionRun | null>;
  listRuns(limit: number): Promise<readonly ExecutionRun[]>;
  findExpiredRuns(now: string, limit: number): Promise<readonly ExecutionRun[]>;
}
