export interface SupervisionTask {
  id: string; title: string; status: "todo" | "in_progress" | "blocked" | "review" | "done" | "cancelled";
  ownerMembershipId: string | null; reviewerMembershipId: string | null;
  dependencyTaskIds: readonly string[]; accepted: boolean; blocker: string | null;
  deadlineAt: string | null; scheduledFinishAt: string | null;
}
/** Root-owned projection of current authorized facts. No client summaries. */
export interface SupervisionFacts {
  projectId: string; projectName: string; archived: boolean;
  membershipId: string; userId: string; membershipStatus: "active" | "left" | "removed";
  responsibility: { confirmed: boolean; version: string; summary: string };
  plan: { id: string | null; version: string; status: "active" | "missing" | "draft" | "stale" };
  /** Semantic version of goal/scope/rules/members/assignments/current task checks. Exclude read timestamps. */
  version: string; tasks: readonly SupervisionTask[];
}
export interface SupervisionHint { id: string; kind: "blocked" | "review" | "ready" | "time_risk"; taskId: string; title: string; detail: string }
export type SupervisionReason = "disabled" | "membership_changed" | "archived" | "responsibility_unconfirmed" | "plan_unavailable" | "plan_stale" | "idle" | "unchanged" | "cooldown" | "daily_limit" | "running" | "hold" | "assistant_busy" | "not_configured" | "failed" | "suggested";
export interface SupervisionReport { requestId: string; messageId: string; content: string; provider: "dsh"; factsFingerprint: string; createdAt: string; stale: boolean }
export interface SupervisionState {
  projectId: string; revision: number; enabled: boolean; reason: SupervisionReason;
  membershipId: string; factsFingerprint: string; hints: readonly SupervisionHint[];
  report: SupervisionReport | null; holdRequestId: string | null;
  dailyUsed: number; dailyLimit: 24; nextAllowedAt: string | null;
}
export interface SupervisionSettingsInput { enabled: boolean; expectedRevision: number }
