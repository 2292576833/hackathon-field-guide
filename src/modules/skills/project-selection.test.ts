import test from "node:test";
import assert from "node:assert/strict";
import type { Actor, ProjectMembershipAccess } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { Skill, TrackBundle } from "./domain.ts";
import { hash } from "./domain.ts";
import type { SkillsRepository, SkillsTransaction } from "./ports.ts";
import { INITIAL_BUNDLES, INITIAL_SKILLS } from "./seed.ts";
import { createProjectSkillSelectionHttpHandlers } from "./project-selection-http.ts";
import { assertTaskSkillLearningIncluded, createProjectSkillSelectionService, createReviewedSkillLookupPort, createSkillReuseSnapshot, parseTaskSkillReferences, validateSkillUseFeedback, validateTaskSkillReferences } from "./project-selection.ts";
import type { FixedSkillReference, ProjectSkillSelectionPort, ProjectSkillSelectionState, TaskSkillReference } from "./project-selection.ts";

const actor: Actor = { userId: "manager", platformRoles: ["user"] };
function fixture() {
  const skills = new Map<string, Skill>(INITIAL_SKILLS.map(item => [item.id, structuredClone(item)]));
  const bundles = new Map<string, TrackBundle>(INITIAL_BUNDLES.map(item => [item.id, structuredClone(item)]));
  let installationCalls = 0;
  const unexpected = async (): Promise<never> => { installationCalls++; throw new Error("Selection must not call installation storage"); };
  const skillTx: SkillsTransaction = {
    getSkill: async id => skills.get(id) ?? null, putSkill: async value => { skills.set(value.id, value); },
    getBundle: async id => bundles.get(id) ?? null, putBundle: async value => { bundles.set(value.id, value); },
    getPlan: unexpected, insertPlan: unexpected, savePlan: unexpected, getReceipt: unexpected, putReceipt: unexpected, appendAudit: unexpected,
  };
  const repository: SkillsRepository = { transaction: work => work(skillTx), listSkills: async () => [...skills.values()], listBundles: async () => [...bundles.values()], listPlans: unexpected, listReceipts: unexpected };
  const states = new Map<string, ProjectSkillSelectionState>();
  const projects = new Map(["source", "target", "other", "archived"].map(id => [id, { id, archived: id === "archived", readOnly: false }]));
  const memberships = new Map<string, ProjectMembershipAccess>(["source", "target", "archived"].map(projectId => [projectId, { projectId, userId: actor.userId, membershipId: `member-${projectId}`, role: "manager", status: "active" }]));
  let accessCalls = 0; let revokeAt = Infinity; let saves = 0;
  const selections: ProjectSkillSelectionPort = {
    async transaction(work) {
      const snapshot = structuredClone(states);
      try { return await work({
        getProject: async id => projects.get(id) ?? null,
        get: async id => states.get(id) ?? null,
        async save(state, expectedRevision) {
          if ((states.get(state.projectId)?.revision ?? 0) !== expectedRevision) throw new DomainError("VERSION_CONFLICT", "Conflict", { status: 409 });
          states.set(state.projectId, structuredClone(state)); saves++;
        },
      }); } catch (error) { states.clear(); for (const [id, state] of snapshot) states.set(id, state); throw error; }
    },
  };
  const reviewedSkills = createReviewedSkillLookupPort(repository);
  const service = createProjectSkillSelectionService({ selections, reviewedSkills, clock: { now: () => new Date("2026-10-10T01:00:00.000Z") }, projectAccess: { async getMembership(projectId, userId) { accessCalls++; if (accessCalls >= revokeAt) return null; const value = memberships.get(projectId); return value?.userId === userId ? value : null; } } });
  return { skills, bundles, states, projects, memberships, repository, reviewedSkills, service, revokeAfterAccess(count: number) { revokeAt = accessCalls + count; }, installationCalls: () => installationCalls, saveCalls: () => saves };
}
async function reference(f: ReturnType<typeof fixture>, id = "create-readme", kind: "skill" | "bundle" = "skill"): Promise<FixedSkillReference> { return (await f.reviewedSkills.list()).find(item => item.reference.id === id && item.reference.kind === kind)!.reference; }
function selection(ref: FixedSkillReference, learningMinutes = 30): TaskSkillReference { return { reference: ref, purpose: "编写作品启动与演示说明", learningMinutes, environment: { agentId: "codex" } }; }
function code(expected: string) { return (error: unknown): boolean => error instanceof DomainError && error.code === expected; }

test("optional old tasks remain valid and learning metadata uses the original estimate", async () => {
  let calls = 0; const lookup = { list: async () => [], get: async () => { calls++; throw new Error("No lookup for absent refs"); } };
  assert.equal(await validateTaskSkillReferences(lookup, undefined), undefined);
  assert.deepEqual(await validateTaskSkillReferences(lookup, []), []);
  assertTaskSkillLearningIncluded(undefined, 0); assertTaskSkillLearningIncluded([], 0); assert.equal(calls, 0);
  const f = fixture(); const refs = [selection(await reference(f), 45)];
  assertTaskSkillLearningIncluded(refs, 45);
  assert.throws(() => assertTaskSkillLearningIncluded(refs, 44), code("SKILL_LEARNING_NOT_IN_TASK_ESTIMATE"));
});
test("reviewed lookup locks exact skill and bundle versions; version2 does not replace version1", async () => {
  const f = fixture(); const legacy = await reference(f, "game-prototype", "bundle");
  const v2: TrackBundle & { bundleId: string; versionId: string } = { ...structuredClone(f.bundles.get("game-prototype")!), id: "game-prototype@2", bundleId: "game-prototype", versionId: "game-prototype@2", version: "2", name: "新版游戏准备包" };
  f.bundles.set(v2.id, v2);
  const current = await reference(f, v2.id, "bundle");
  assert.equal(legacy.version, "1"); assert.equal(current.versionId, "game-prototype@2"); assert.equal((await f.reviewedSkills.get(legacy)).reference.version, "1");
  assert.equal((await f.reviewedSkills.get(current)).requiredSkillVersions.length, 3);
  await assert.rejects(f.reviewedSkills.get({ ...current, version: "1" }), code("SKILL_REFERENCE_STALE"));
  const skill = await reference(f);
  await assert.rejects(f.reviewedSkills.get({ ...skill, contentHash: "a".repeat(64) }), code("SKILL_REFERENCE_STALE"));
  await assert.rejects(f.reviewedSkills.get({ ...skill, revision: 2 }), code("SKILL_REFERENCE_STALE"));
});
test("withdrawal and tampered manifests invalidate new references while original stored choices remain readable", async () => {
  const f = fixture(); const ref = await reference(f); const bundle = await reference(f, "agent-demo", "bundle");
  await f.service.save(actor, "source", { expectedRevision: 0, selections: [selection(ref)] });
  const skill = f.skills.get(ref.id)!; f.skills.set(ref.id, { ...skill, versions: skill.versions.map(item => ({ ...item, status: "withdrawn" })) });
  await assert.rejects(f.reviewedSkills.get(ref), code("SKILL_REFERENCE_UNAVAILABLE"));
  await assert.rejects(f.reviewedSkills.get(bundle), code("SKILL_REFERENCE_UNAVAILABLE"));
  const retained = await f.service.read(actor, "source"); assert.deepEqual(retained.selections[0].reference, ref); assert.equal(retained.availability[0].available, false);
  await assert.rejects(f.service.save(actor, "source", { expectedRevision: 1, selections: retained.selections }), code("SKILL_REFERENCE_UNAVAILABLE"));
  const cleared = await f.service.save(actor, "source", { expectedRevision: 1, selections: [] }); assert.equal(cleared.revision, 2); assert.deepEqual(cleared.selections, []);
  await assert.rejects(f.service.save(actor, "source", { expectedRevision: 0, selections: [] }), code("VERSION_CONFLICT"));
  const another = await reference(f, "frontend-design"); const document = f.skills.get(another.id)!;
  f.skills.set(another.id, { ...document, versions: document.versions.map(version => ({ ...version, files: version.files.map(file => file.relativePath === "SKILL.md" ? { ...file, sha256: "f".repeat(64) } : file) })) });
  await assert.rejects(f.reviewedSkills.get(another), code("INVALID_SKILL_CONTENT"));
  assert.equal((await f.reviewedSkills.list()).some(item => item.reference.id === another.id), false);
});
test("license unknown and fixed version identity mismatches cannot become legal task refs", async () => {
  const f = fixture(); const ref = await reference(f); const skill = f.skills.get(ref.id)!;
  f.skills.set(ref.id, { ...skill, versions: skill.versions.map(version => ({ ...version, license: { ...version.license, spdx: "UNKNOWN" as "MIT" } })) });
  await assert.rejects(validateTaskSkillReferences(f.reviewedSkills, [selection(ref)]), code("INVALID_SKILL_VERSION"));
  f.skills.set(ref.id, { ...skill, versions: skill.versions.map(version => ({ ...version, id: "forged-version" })) });
  await assert.rejects(f.reviewedSkills.get({ ...ref, versionId: "forged-version" }), code("INVALID_SKILL_REFERENCE"));
});
test("project permissions come from active membership; admin identity cannot bypass unrelated spaces", async () => {
  const f = fixture(); const item = selection(await reference(f));
  await assert.rejects(f.service.read({ userId: "other", platformRoles: ["admin"] }, "source"), code("PROJECT_SKILL_ACCESS_DENIED"));
  await assert.rejects(f.service.catalog(actor, "other"), code("PROJECT_SKILL_ACCESS_DENIED"));
  await assert.rejects(f.service.save(actor, "archived", { expectedRevision: 0, selections: [item] }), code("PROJECT_READ_ONLY"));
  f.memberships.set("source", { ...f.memberships.get("source")!, role: "member" });
  assert.equal((await f.service.read(actor, "source")).canManage, false);
  await assert.rejects(f.service.save(actor, "source", { expectedRevision: 0, selections: [item] }), code("PROJECT_SKILL_MANAGEMENT_REQUIRED"));
  f.memberships.set("source", { ...f.memberships.get("source")!, role: "manager", status: "removed" });
  await assert.rejects(f.service.read(actor, "source"), code("PROJECT_SKILL_ACCESS_DENIED"));
});
test("permission changes before returning reads and after writes are rechecked, with transactional rollback", async () => {
  const f = fixture(); const item = selection(await reference(f));
  f.revokeAfterAccess(3);
  await assert.rejects(f.service.save(actor, "source", { expectedRevision: 0, selections: [item] }), code("PROJECT_SKILL_ACCESS_DENIED"));
  assert.equal(f.saveCalls(), 1); assert.equal(f.states.has("source"), false);
  const reading = fixture(); reading.revokeAfterAccess(2);
  await assert.rejects(reading.service.read(actor, "source"), code("PROJECT_SKILL_ACCESS_DENIED"));
});
test("copy checks both projects, pins the old reference and never calls installation or receipt storage", async () => {
  const f = fixture(); const ref = await reference(f);
  await f.service.save(actor, "source", { expectedRevision: 0, selections: [selection(ref)] });
  f.memberships.delete("target");
  await assert.rejects(f.service.copy(actor, "source", "target", 0), code("PROJECT_SKILL_ACCESS_DENIED"));
  f.memberships.set("target", { projectId: "target", userId: actor.userId, membershipId: "target-member", role: "manager", status: "active" });
  const copied = await f.service.copy(actor, "source", "target", 0);
  assert.deepEqual(copied.selections[0].reference, ref); assert.equal(copied.projectId, "target"); assert.equal(f.installationCalls(), 0);
  const reused = await createSkillReuseSnapshot(f.reviewedSkills, copied.selections); assert.equal(reused.installationAction, "none"); assert.deepEqual(reused.skillRefs[0].reference, ref);
  await assert.rejects(f.service.copy(actor, "source", "target", 0), code("VERSION_CONFLICT"));
});
test("unknown environment remains unknown and user feedback never becomes compatibility proof", async () => {
  const f = fixture(); const ref = await reference(f);
  const refs = await validateTaskSkillReferences(f.reviewedSkills, [{ ...selection(ref), environment: {} }]); assert.deepEqual(refs![0].environment, {});
  assert.ok((await f.reviewedSkills.get(ref)).compatibility.every(item => item.level === "installer_declared"));
  const feedback = { ...selection(ref), outcome: "partial", note: "本人试用后仍需修改说明", evidenceSource: "user_reported" };
  const report = await validateSkillUseFeedback(f.reviewedSkills, feedback); assert.equal(report.evidenceSource, "user_reported"); assert.equal(report.outcome, "partial");
  await assert.rejects(validateSkillUseFeedback(f.reviewedSkills, { ...feedback, evidenceSource: "platform_test" }), code("INVALID_SKILL_REFERENCE"));
  assert.ok((await f.reviewedSkills.get(ref)).compatibility.every(item => item.level === "installer_declared"));
});
test("DTO schemas reject local paths, keys, arbitrary tools, duplicate versions, and installation instructions", async () => {
  const f = fixture(); const ref = await reference(f); const item = selection(ref);
  for (const invalid of [
    [{ ...item, environment: { agentId: "unknown" } }],
    [{ ...item, environment: { projectRoot: "F:\\private" } }],
    [{ ...item, purpose: "读取 F:\\private\\work" }],
    [{ ...item, purpose: "api_key=not-a-real-test-secret" }],
    [{ ...item, install: true }], [item, item], [{ ...item, reference: { ...ref, version: "latest" } }], null,
  ]) assert.throws(() => parseTaskSkillReferences(invalid), code("INVALID_SKILL_REFERENCE"));
  assert.throws(() => parseTaskSkillReferences(Array.from({ length: 13 }, () => item)), code("INVALID_SKILL_REFERENCE"));
});
test("bundle references detect required member content changes without upgrading stored choices", async () => {
  const f = fixture(); const ref = await reference(f, "game-prototype", "bundle"); const option = await f.reviewedSkills.get(ref);
  const child = f.skills.get(option.requiredSkillVersions[0].id)!;
  f.skills.set(child.id, { ...child, versions: child.versions.map(version => {
    const files = version.files.map((file, index) => index === 0 ? { ...file, sha256: "e".repeat(64) } : file);
    return { ...version, files, contentHash: hash(files) };
  }) });
  await assert.rejects(f.reviewedSkills.get(ref), code("SKILL_REFERENCE_STALE"));
});
test("HTTP factories enforce trusted identity, mutation policy, bounded JSON and fixed DTO fields", async () => {
  const f = fixture(); const item = selection(await reference(f)); let csrf = 0;
  const handlers = createProjectSkillSelectionHttpHandlers({ service: f.service, resolveActor: async () => actor, assertMutationAllowed: async () => { csrf++; }, requestId: () => "fixture-request" });
  const url = "https://website.test/api/v1/projects/source/skills";
  const request = (value: unknown) => new Request(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
  assert.equal((await handlers.save("source")(request({ expectedRevision: 0, selections: [item], userId: "forged" }))).status, 422);
  const result = await handlers.save("source")(request({ expectedRevision: 0, selections: [item] })); assert.equal(result.status, 200);
  assert.equal((await result.json()).data.updatedBy, actor.userId); assert.equal(csrf, 2);
  assert.equal((await handlers.save("source")(request({ selections: [], expectedRevision: 0 }))).status, 409);
  assert.equal((await handlers.read("source")(new Request(url))).headers.get("cache-control"), "no-store");
  const anonymous = createProjectSkillSelectionHttpHandlers({ service: f.service, resolveActor: async () => null, assertMutationAllowed: async () => {}, requestId: () => "fixture-request" });
  assert.equal((await anonymous.read("source")(new Request(url))).status, 401);
  assert.equal((await handlers.save("source")(request({ selections: [], expectedRevision: 1, padding: "x".repeat(50000) }))).status, 413);
  assert.equal(f.installationCalls(), 0);
});
