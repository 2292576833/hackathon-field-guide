import assert from "node:assert/strict";
import test from "node:test";
import type { Actor } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { FreshSessionGuard, PersonalAiPort, PersonalArtifact, PersonalGenerationRequest } from "../../shared/personal-ai.ts";
import type { SqlExecutor } from "../../shared/persistence.ts";
import { createPptService, parseStoredPptOutline } from "../ppt/index.ts";
import { createRoadshowService } from "./service.ts";
import { roadshowToMarkdown, validateRoadshowDocument } from "./validation.ts";
import { assertProjectPlansStayPlanned, presentationProjectIdentity, validatePresentationProjectSnapshot } from "./project-context.ts";
import type { PresentationProjectContextPort, PresentationProjectSnapshot } from "./project-context.ts";
import type { RoadshowInput } from "./types.ts";

const actor: Actor = { userId: "owner", platformRoles: ["user"] };
const sql: SqlExecutor = { async query() { return { rows: [], rowCount: 0 }; } };
const source: PresentationProjectSnapshot = {
  schemaVersion: 1, projectId: "project-1", revision: 3, projectName: "行动小助手", projectIdea: "把会议行动整理成可确认的清单",
  targetUsers: "会议参与者", problem: "负责人容易遗漏", completed: ["本地编辑界面"], planned: ["多人同步待实现"],
  evidence: ["本机手动检查记录；仍需复核"], capturedAt: "2026-10-09T00:00:00.000Z",
};
const roadInput: RoadshowInput = {
  projectIdea: source.projectIdea, targetUsers: source.targetUsers, problem: source.problem, completedCapabilities: source.completed.join("\n"),
  plannedCapabilities: source.planned.join("\n"), technicalApproach: "", differentiation: "", facts: source.evidence.join("\n"),
  assumptions: "参与者可能愿意维护清单", pendingValidation: "实际使用成本", durationSeconds: 180,
};
const pptInput = { templateId: "demo-3", durationMinutes: 3, projectName: source.projectName, projectIdea: source.projectIdea,
  targetUsers: source.targetUsers, completed: source.completed, planned: source.planned, evidence: source.evidence };
const chosen = { projectId: source.projectId, revision: source.revision };
const errorCode = (code: string) => (error: unknown) => error instanceof DomainError && error.code === code;

function fixture() {
  const state = { active: true, archived: false, session: true, revision: 3, source: structuredClone(source), paid: 0,
    afterRead: null as (() => void) | null, beforeSave: null as (() => void) | null };
  const rows = new Map<string, PersonalArtifact>();
  const requests: PersonalGenerationRequest<unknown>[] = [];
  const checks: string[] = [];
  const sessionGuard: FreshSessionGuard = async executor => {
    assert.equal(executor, sql); checks.push("session");
    if (!state.session) throw new DomainError("UNAUTHENTICATED", "会话已失效。", { status: 401 });
  };
  const access = (current: Actor) => {
    if (current.userId !== actor.userId || !state.active) throw new DomainError("PROJECT_ACCESS_DENIED", "无项目权限。", { status: 403 });
  };
  const writeAccess = (current: Actor) => {
    access(current);
    if (state.archived) throw new DomainError("PROJECT_ARCHIVED", "项目已归档。", { status: 409 });
  };
  const projectContext: PresentationProjectContextPort = {
    async readSnapshot(current, id, guard) {
      await guard?.(sql); access(current); assert.equal(id, source.projectId); checks.push("read");
      const read = { ...structuredClone(state.source), revision: state.revision };
      state.afterRead?.(); return read;
    },
    async assertCurrent(current, selection, executor) {
      assert.equal(executor, sql); checks.push("current"); writeAccess(current);
      if (selection.revision !== state.revision) throw new DomainError("PROJECT_CONTEXT_CHANGED", "项目资料已更新。", { status: 409, latestRevision: state.revision });
    },
    async assertCanGenerate(current, id, executor) {
      assert.equal(executor, sql); assert.equal(id, source.projectId); checks.push("historical"); writeAccess(current);
    },
  };
  const ai: PersonalAiPort = {
    async generate<T>(current: Actor, request: PersonalGenerationRequest<T>, guard?: FreshSessionGuard): Promise<PersonalArtifact<T>> {
      requests.push(request); await guard?.(sql); state.paid++;
      const data = request.validate(structuredClone(request.outputExample));
      state.beforeSave?.(); await guard?.(sql);
      const row: PersonalArtifact<T> = { id: `artifact-${requests.length}`, kind: request.kind, title: request.title, data: structuredClone(data),
        provider: "dsh", sessionId: "private-session", createdAt: "2026-10-09T00:00:01.000Z" };
      assert.equal(current.userId, actor.userId); rows.set(row.id, row); return structuredClone(row);
    },
    async get(current, id, guard) {
      await guard?.(sql);
      const row = current.userId === actor.userId ? rows.get(id) : undefined;
      if (!row) throw new DomainError("ARTIFACT_NOT_FOUND", "记录不存在。", { status: 404 });
      return structuredClone(row);
    },
    async list(current, kind, guard) { await guard?.(sql); return current.userId === actor.userId ? [...rows.values()].filter(row => row.kind === kind).map(row => structuredClone(row)) : []; },
  };
  return { state, ai, rows, requests, checks, projectContext, sessionGuard };
}

test("project snapshots are strict, bounded and detached; browser snapshots are never accepted", async () => {
  const parsed = validatePresentationProjectSnapshot(source);
  parsed.completed.push("私有编辑"); assert.deepEqual(source.completed, ["本地编辑界面"]);
  for (const bad of [{ ...source, ownerId: "other" }, { ...source, revision: 0 }, { ...source, projectId: "../other" },
    { ...source, completed: Array(13).fill("成果") }, { ...source, planned: ["字".repeat(601)] }, { ...source, capturedAt: "2026-02-31T00:00:00.000Z" }]) {
    assert.throws(() => validatePresentationProjectSnapshot(bad), errorCode("PROJECT_CONTEXT_INVALID"));
  }
  const f = fixture();
  await assert.rejects(createRoadshowService(f).generate(actor, { ...roadInput, sourceProject: source }, f.sessionGuard), errorCode("INVALID_INPUT"));
  await assert.rejects(createPptService(f).generate(actor, { ...pptInput, sourceProject: source }, f.sessionGuard), errorCode("PPT_INPUT_INVALID"));
  assert.equal(f.state.paid, 0);
});

test("explicit project selection resolves a server snapshot and preserves separate private edits", async () => {
  const f = fixture(); const edited = { ...roadInput, projectIdea: "本人确认并修改的私人表达" };
  const result = await createRoadshowService(f).generate(actor, { ...edited, projectSource: chosen }, f.sessionGuard);
  assert.deepEqual(result.data.sourceProject, source);
  assert.equal(result.data.input.projectIdea, edited.projectIdea);
  assert.equal(result.data.sourceProject!.projectIdea, source.projectIdea);
  assert.deepEqual((f.requests[0]!.input as { sourceProject: unknown }).sourceProject, source);
  assert.deepEqual(f.checks, ["session", "read", "session", "current", "session", "current"]);
  f.state.source.projectIdea = "后续更新"; f.state.revision = 4;
  const old = await createRoadshowService(f).get(actor, result.id, f.sessionGuard);
  assert.deepEqual(old.data.sourceProject, source); assert.equal(old.data.input.projectIdea, edited.projectIdea);
  assert.match(roadshowToMarkdown(old.data), /来源项目/);
});

test("missing adapters, other members and stale selections fail before a paid request", async () => {
  const f = fixture();
  await assert.rejects(createRoadshowService({ ai: f.ai }).generate(actor, { ...roadInput, projectSource: chosen }), errorCode("PROJECT_CONTEXT_UNAVAILABLE"));
  await assert.rejects(createPptService({ ai: f.ai }).generate(actor, { ...pptInput, projectSource: chosen }), errorCode("PROJECT_CONTEXT_UNAVAILABLE"));
  await assert.rejects(createRoadshowService(f).generate({ ...actor, userId: "other" }, { ...roadInput, projectSource: chosen }, f.sessionGuard), errorCode("PROJECT_ACCESS_DENIED"));
  await assert.rejects(createPptService(f).generate(actor, { ...pptInput, projectSource: { ...chosen, revision: 2 } }, f.sessionGuard), errorCode("PROJECT_CONTEXT_CHANGED"));
  f.state.afterRead = () => { f.state.revision = 4; };
  await assert.rejects(createRoadshowService(f).generate(actor, { ...roadInput, projectSource: chosen }, f.sessionGuard), errorCode("PROJECT_CONTEXT_CHANGED"));
  assert.equal(f.state.paid, 0); assert.equal(f.rows.size, 0);
});

test("session expiry, leaving and archiving during generation block saving in the transaction guard", async () => {
  for (const kind of ["roadshow", "ppt"] as const) for (const change of ["left", "archive", "session", "revision"] as const) {
    const f = fixture();
    f.state.beforeSave = () => { if (change === "left") f.state.active = false; if (change === "archive") f.state.archived = true;
      if (change === "session") f.state.session = false; if (change === "revision") f.state.revision++; };
    const service = kind === "roadshow" ? createRoadshowService(f) : createPptService(f);
    await assert.rejects(service.generate(actor, { ...(kind === "roadshow" ? roadInput : pptInput), projectSource: chosen }, f.sessionGuard),
      errorCode({ left: "PROJECT_ACCESS_DENIED", archive: "PROJECT_ARCHIVED", session: "UNAUTHENTICATED", revision: "PROJECT_CONTEXT_CHANGED" }[change]));
    assert.equal(f.state.paid, 1); assert.equal(f.rows.size, 0); assert.equal(f.requests.length, 1);
  }
});

test("a project plan cannot be copied into completed scope; old roadshow documents remain readable", async () => {
  assert.throws(() => assertProjectPlansStayPlanned(source.planned, source), errorCode("PROJECT_COMPLETION_NEEDS_REVIEW"));
  const f = fixture();
  await assert.rejects(createRoadshowService(f).generate(actor, { ...roadInput, completedCapabilities: source.planned[0], projectSource: chosen }, f.sessionGuard), errorCode("PROJECT_COMPLETION_NEEDS_REVIEW"));
  await assert.rejects(createPptService(f).generate(actor, { ...pptInput, completed: source.planned, projectSource: chosen }, f.sessionGuard), errorCode("PROJECT_COMPLETION_NEEDS_REVIEW"));
  assert.equal(f.state.paid, 0);
  const result = await createRoadshowService(f).generate(actor, roadInput, f.sessionGuard);
  const { plannedCapabilities: _planned, ...legacyInput } = result.data.input;
  assert.equal(validateRoadshowDocument({ input: legacyInput, script: result.data.script }).input.plannedCapabilities, "");
});

test("PPT inherits both completion and explicit plans from the actual private roadshow snapshot", async () => {
  const f = fixture(); const roadshow = await createRoadshowService(f).generate(actor, { ...roadInput, projectSource: chosen }, f.sessionGuard);
  f.state.revision = 4; f.state.source.planned = ["另一个新计划"];
  const result = await createPptService(f).generate(actor, { templateId: "demo-3", durationMinutes: 3, artifactId: roadshow.id }, f.sessionGuard);
  assert.deepEqual(result.data.sourceProject, source); assert.deepEqual(result.data.inputSnapshot.planned, source.planned);
  assert.deepEqual(result.data.inputSnapshot.completed, source.completed);
  assert.equal(result.data.inputSnapshot.projectName, source.projectName);
  assert.deepEqual(parseStoredPptOutline(result.data).sourceProject, source);
  assert.equal(f.checks.filter(check => check === "historical").length, 2);
  await assert.rejects(createPptService(f).generate(actor, { ...pptInput, artifactId: roadshow.id, projectSource: chosen }, f.sessionGuard), errorCode("PPT_SOURCE_CONFLICT"));
  f.state.archived = true;
  await assert.rejects(createPptService(f).generate(actor, { templateId: "demo-3", durationMinutes: 3, artifactId: roadshow.id }, f.sessionGuard), errorCode("PROJECT_ARCHIVED"));
  assert.equal(f.state.paid, 2);
  const retained = await createPptService(f).get(actor, result.id, f.sessionGuard);
  assert.deepEqual(retained.data.sourceProject, source);
});

test("adding an optional blank plan field does not change the legacy semantic request identity", async () => {
  const f = fixture(); const { plannedCapabilities: _planned, ...legacy } = roadInput;
  await createRoadshowService(f).generate(actor, legacy, f.sessionGuard);
  const identity = f.requests[0]!.requestIdentity as { project: unknown; participantContext: unknown };
  assert.deepEqual(identity, { project: legacy, participantContext: null });
});

test("re-reading the same source facts keeps request identity stable so timestamps cannot bypass holds", async () => {
  assert.deepEqual(presentationProjectIdentity(source), presentationProjectIdentity({ ...source, capturedAt: "2026-10-09T01:00:00.000Z" }));
  for (const kind of ["roadshow", "ppt"] as const) {
    const f = fixture(); const service = kind === "roadshow" ? createRoadshowService(f) : createPptService(f);
    const payload = { ...(kind === "roadshow" ? roadInput : pptInput), projectSource: chosen };
    await service.generate(actor, payload, f.sessionGuard);
    f.state.source.capturedAt = "2026-10-09T01:00:00.000Z";
    await service.generate(actor, payload, f.sessionGuard);
    assert.deepEqual(f.requests[0]!.requestIdentity, f.requests[1]!.requestIdentity);
    assert.notDeepEqual((f.requests[0]!.input as { sourceProject: unknown }).sourceProject, (f.requests[1]!.input as { sourceProject: unknown }).sourceProject);
  }
});
