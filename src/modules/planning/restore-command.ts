import { DomainError } from "../../shared/errors.ts";
import { parseDraftCommand } from "./parse.ts";
import type { DraftCommand } from "./service.ts";

export type RestorePlanCommand = Omit<DraftCommand, "tasks" | "buffers">;

/** Restore copies a server-read version; callers cannot supply tasks, buffers or identity. */
export function parseRestorePlanCommand(value: unknown): RestorePlanCommand {
  const allowed = ["reason", "expectedTasksRevision", "basePlanVersionId", "idempotencyKey"];
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) {
    throw new DomainError("INVALID_INPUT", "恢复草案只能填写理由和当前计划基线。", { status: 400 });
  }
  const { tasks: _tasks, buffers: _buffers, ...command } = parseDraftCommand({ ...value, tasks: [], buffers: [] });
  return command;
}
