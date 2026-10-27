import type { Actor } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { FreshSessionGuard } from "../../shared/personal-ai.ts";
import type { SqlExecutor } from "../../shared/persistence.ts";

/** The browser selects an ID and revision; it never supplies the snapshot. */
export interface PresentationProjectSelection { projectId: string; revision: number }

/** A bounded, server-owned summary. No private profile, script or full code/rules. */
export interface PresentationProjectSnapshot extends PresentationProjectSelection {
  schemaVersion: 1;
  projectName: string;
  projectIdea: string;
  targetUsers: string;
  problem: string;
  completed: string[];
  planned: string[];
  evidence: string[];
  capturedAt: string;
}

/** Root composes the actual project/plan/delivery sources in its transaction. */
export interface PresentationProjectContextPort {
  readSnapshot(actor: Actor, projectId: string, guard?: FreshSessionGuard): Promise<PresentationProjectSnapshot>;
  /** Active membership, current session, non-archived project and exact fact revision. */
  assertCurrent(actor: Actor, selection: PresentationProjectSelection, sql: SqlExecutor): Promise<void>;
  /** Explicitly inherited private history retains its revision; current write access still applies. */
  assertCanGenerate(actor: Actor, projectId: string, sql: SqlExecutor): Promise<void>;
}

function invalid(output: boolean): never {
  throw new DomainError(output ? "PROJECT_CONTEXT_INVALID" : "PROJECT_SOURCE_INVALID", output
    ? "项目资料格式不完整，暂时无法安全带入展示材料。"
    : "请选择有效的项目和资料版本。", { status: output ? 502 : 422 });
}
function record(value: unknown, keys: readonly string[], output: boolean): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(output);
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some(key => !keys.includes(key))) invalid(output);
  return raw;
}
function text(value: unknown, maximum: number, output: boolean, empty = false): string {
  if (typeof value !== "string" || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) invalid(output);
  const result = value.trim();
  if (!empty && !result) invalid(output);
  return result;
}
function selection(raw: Record<string, unknown>, output: boolean): PresentationProjectSelection {
  const projectId = text(raw.projectId, 128, output);
  if (!/^[A-Za-z0-9_-]+$/.test(projectId) || !Number.isSafeInteger(raw.revision) || (raw.revision as number) < 1) invalid(output);
  return { projectId, revision: raw.revision as number };
}
export function validatePresentationProjectSelection(value: unknown): PresentationProjectSelection {
  return selection(record(value, ["projectId", "revision"], false), false);
}
export function validatePresentationProjectSnapshot(value: unknown): PresentationProjectSnapshot {
  const raw = record(value, ["schemaVersion", "projectId", "revision", "projectName", "projectIdea", "targetUsers", "problem", "completed", "planned", "evidence", "capturedAt"], true);
  if (raw.schemaVersion !== 1) invalid(true);
  const list = (value: unknown): string[] => {
    if (!Array.isArray(value) || value.length > 12) invalid(true);
    return value.map(item => text(item, 600, true));
  };
  const capturedAt = text(raw.capturedAt, 32, true);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(capturedAt) || !Number.isFinite(Date.parse(capturedAt))
    || new Date(capturedAt).toISOString() !== capturedAt) invalid(true);
  const result: PresentationProjectSnapshot = { schemaVersion: 1, ...selection(raw, true),
    projectName: text(raw.projectName, 120, true), projectIdea: text(raw.projectIdea, 2000, true, true),
    targetUsers: text(raw.targetUsers, 1000, true, true), problem: text(raw.problem, 2000, true, true),
    completed: list(raw.completed), planned: list(raw.planned), evidence: list(raw.evidence), capturedAt };
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 90_000) invalid(true);
  return result;
}
export async function resolvePresentationProjectSnapshot(port: PresentationProjectContextPort | undefined, actor: Actor,
  value: unknown, guard?: FreshSessionGuard): Promise<PresentationProjectSnapshot> {
  const chosen = validatePresentationProjectSelection(value);
  if (!port) throw new DomainError("PROJECT_CONTEXT_UNAVAILABLE", "项目资料带入尚未接入，请先取消项目引用并手动填写。", { status: 503 });
  const snapshot = validatePresentationProjectSnapshot(await port.readSnapshot(actor, chosen.projectId, guard));
  if (snapshot.projectId !== chosen.projectId) invalid(true);
  if (snapshot.revision !== chosen.revision) throw new DomainError("PROJECT_CONTEXT_CHANGED", "项目资料已更新，请重新读取并确认本次使用的内容。", { status: 409, latestRevision: snapshot.revision });
  return snapshot;
}
export function createPresentationProjectGuard(port: PresentationProjectContextPort, actor: Actor,
  snapshot: PresentationProjectSnapshot, guard?: FreshSessionGuard, historical = false): FreshSessionGuard {
  const chosen = { projectId: snapshot.projectId, revision: snapshot.revision };
  return async sql => {
    await guard?.(sql);
    if (historical) await port.assertCanGenerate(actor, chosen.projectId, sql);
    else await port.assertCurrent(actor, chosen, sql);
  };
}

/** Re-reading the same facts must not evade an unknown paid-request hold. */
export function presentationProjectIdentity(snapshot: PresentationProjectSnapshot): Omit<PresentationProjectSnapshot, "capturedAt"> {
  const { capturedAt: _readTime, ...facts } = snapshot;
  return structuredClone(facts);
}

/** A conservative exact-text check; free-form user statements remain unverified. */
export function assertProjectPlansStayPlanned(completed: string | readonly string[], source: PresentationProjectSnapshot): void {
  const normalize = (value: string) => value.replace(/[\s，,。；;：:、]/gu, "");
  const finished = normalize(typeof completed === "string" ? completed : completed.join("\n"));
  if (source.planned.some(item => normalize(item).length > 0 && finished.includes(normalize(item)))) {
    throw new DomainError("PROJECT_COMPLETION_NEEDS_REVIEW", "项目中的待完成内容不能直接标为已完成，请核对成果或重新读取项目资料。", { status: 422 });
  }
}
