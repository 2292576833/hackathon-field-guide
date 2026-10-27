import type { ProjectAccessPort, ProjectMembershipAccess } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import { normalizeAvailabilityWindows, validateAvailabilityWindows } from "./rules.ts";
import type { AvailabilityWindow, MemberAvailabilityInput } from "./types.ts";

/** Structural integration types; no imports of M02 private implementation. */
export interface ProjectAvailabilityWindowInput { id: string; startsAt: string; endsAt: string; effectiveMinutes: number }
export interface ProjectAvailabilityCollection {
  projectId: string;
  userId: string;
  timezone: string;
  windows: (ProjectAvailabilityWindowInput & { revision: number })[];
  confirmedAt: string;
  revision: number;
  membershipRevision: number;
}
function childWindow(projectId: string, membershipId: string, timezone: string, version: number, window: ProjectAvailabilityWindowInput): AvailabilityWindow {
  const actualMinutes = (Date.parse(window.endsAt) - Date.parse(window.startsAt)) / 60_000;
  if (!Number.isFinite(actualMinutes) || actualMinutes <= 0 || window.effectiveMinutes !== actualMinutes) throw new DomainError("AVAILABILITY_NEEDS_EXACT_WINDOWS", "请用实际可工作窗口排除休息和其他安排；有效分钟数须与窗口长度一致。", { recoveryAction: "split_work_windows" });
  return { id: window.id, projectId, membershipId, sourceTimeZone: timezone, version, startsAt: window.startsAt, endsAt: window.endsAt, purpose: "work" };
}

/** Matches M02 AvailabilityValidationPort and stores nothing in planning. */
export function createMemberAvailabilityValidator(access: ProjectAccessPort) {
  return {
    async validate(input: { projectId: string; userId: string; timezone: string; windows: readonly ProjectAvailabilityWindowInput[]; nextRevision: number; previous: unknown }) {
      const membership = await access.getMembership(input.projectId, input.userId);
      if (!membership || membership.status !== "active") throw new DomainError("NOT_FOUND", "未找到可访问的项目。", { status: 404 });
      if (!Number.isSafeInteger(input.nextRevision) || input.nextRevision < 1) throw new DomainError("INVALID_REVISION", "可用时间版本不合法。");
      const windows = input.windows.map(window => childWindow(input.projectId, membership.membershipId, input.timezone, input.nextRevision, window));
      const issues = validateAvailabilityWindows(input.projectId, membership.membershipId, windows);
      if (issues.some(issue => issue.severity === "error" || issue.severity === "unknown")) throw new DomainError("INVALID_AVAILABILITY", issues[0]?.message ?? "可用窗口不合法。", { recoveryAction: "confirm_window_time" });
      // No clipping by current time when saving declarations: reads clip at evaluation time.
      const earliest = windows.length ? Math.min(...windows.map(window => Date.parse(window.startsAt))) : 0;
      const normalized = normalizeAvailabilityWindows(input.projectId, membership.membershipId, windows, new Date(earliest).toISOString());
      return { windows: input.windows.map(window => ({ ...window, revision: input.nextRevision })), effectiveMinutes: normalized.capacityMinutes };
    },
  };
}

/** Convert the sole M02 fact to an immutable planning input snapshot. Never add effectiveMinutes again. */
export function availabilityFromProjectCollection(collection: ProjectAvailabilityCollection, membership: ProjectMembershipAccess & { revision: number }): MemberAvailabilityInput {
  if (collection.projectId !== membership.projectId || collection.userId !== membership.userId) throw new DomainError("PROJECT_MISMATCH", "可用时间与项目成员不匹配。");
  const current = membership.status === "active" && membership.revision === collection.membershipRevision;
  return { membershipId: membership.membershipId, version: collection.revision, confirmedAt: current ? collection.confirmedAt : null,
    windows: current ? collection.windows.map(window => {
      if (window.revision !== collection.revision) throw new DomainError("VERSION_CONFLICT", "窗口与可用时间集合版本不一致。", { status: 409 });
      return childWindow(collection.projectId, membership.membershipId, collection.timezone, collection.revision, window);
    }) : [] };
}
