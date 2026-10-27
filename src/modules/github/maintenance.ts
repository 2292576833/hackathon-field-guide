import type { Clock } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { AuthorizationStorePort } from "./authorization-types.ts";
import type { DraftStorePort } from "./types.ts";

/** Suggested root background cadence; this factory owns no timer or database connection. */
export const GITHUB_MAINTENANCE_INTERVAL_MS = 5 * 60_000;

export interface GitHubMaintenanceDependencies {
  drafts: Pick<DraftStorePort, "purgeExpired">;
  authorization: Pick<AuthorizationStorePort, "purgeExpiredStates">;
  clock: Clock;
}
export interface GitHubMaintenanceResult {
  checkedAt: string;
  expiredDraftsRemoved: number;
  expiredStatesRemoved: number;
}
export interface GitHubMaintenance {
  run(): Promise<GitHubMaintenanceResult>;
}

/** Trusted server maintenance only. Expired state cleanup never touches tokens, epochs or unknown holds. */
export function createGitHubMaintenance(dependencies: GitHubMaintenanceDependencies): GitHubMaintenance {
  let inFlight: Promise<GitHubMaintenanceResult> | null = null;
  return {
    run() {
      if (inFlight) return inFlight;
      inFlight = (async () => {
        const instant = dependencies.clock.now();
        if (!Number.isFinite(instant.getTime())) throw new DomainError("GITHUB_MAINTENANCE_TIME_INVALID", "清理时间不符合要求。");
        const checkedAt = instant.toISOString();
        // Both independent purges still run if one fails. Repeated purges are idempotent, and failures
        // contain no SQL, draft contents or credential details for the root background logger.
        const results = await Promise.allSettled([
          Promise.resolve().then(() => dependencies.drafts.purgeExpired(checkedAt)),
          Promise.resolve().then(() => dependencies.authorization.purgeExpiredStates(checkedAt)),
        ]);
        const drafts = results[0], states = results[1];
        if (drafts.status !== "fulfilled" || states.status !== "fulfilled") {
          throw new DomainError("GITHUB_MAINTENANCE_FAILED", "GitHub 过期资料清理未全部完成，请稍后重试。", { status: 503, recoveryAction: "retry_later" });
        }
        return { checkedAt, expiredDraftsRemoved: drafts.value, expiredStatesRemoved: states.value };
      })().finally(() => { inFlight = null; });
      return inFlight;
    },
  };
}
