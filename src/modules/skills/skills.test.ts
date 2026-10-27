import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, mkdir, writeFile, rm, lstat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute, sep } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { request as rawHttpRequest } from "node:http";
import { PGlite } from "@electric-sql/pglite";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import type { Actor } from "../../shared/contracts.ts";
import { createPostgresSkillsRepository } from "./postgres.ts";
import { SkillsService } from "./service.ts";
import { INITIAL_SKILLS, seedInitialSkills } from "./seed.ts";
import { createSkillsHttpHandlers } from "./http.ts";
import { createSkillsBridge } from "./bridge.ts";
import { AGENT_ADAPTERS } from "./adapters.ts";
import { hash } from "./domain.ts";
import type { InstallationManifest, InstallationReceipt, SkillFile } from "./domain.ts";
const user: Actor = { userId: "user-a", platformRoles: ["user"] };
let time = new Date("2026-10-08T10:00:00Z");
async function database() {
  const pg = new PGlite(); await pg.exec(await readFile(new URL("schema.sql", import.meta.url), "utf8"));
  const executor = (target: { query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; affectedRows?: number }> }): SqlExecutor => ({ async query<Row>(sql: string, parameters?: readonly unknown[]) { const value = await target.query(sql, parameters ? [...parameters] : undefined); return { rows: value.rows as Row[], rowCount: value.affectedRows ?? value.rows.length }; } });
  const db: DatabasePort = { ...executor(pg), transaction: work => pg.transaction(tx => work(executor(tx))) };
  const repository = createPostgresSkillsRepository(db); await seedInitialSkills(repository);
  let sequence = 0; const service = new SkillsService({ repository, clock: { now: () => time }, ids: { next: () => `plan-${++sequence}` }, randomToken: () => "c".repeat(64) });
  return { pg, repository, service };
}
async function temporary() { const parent = resolve(tmpdir()); const path = await mkdtemp(join(parent, "hackathon-skills-test-")); return { path, async cleanup() { const rel = relative(parent, path); assert.ok(!isAbsolute(rel) && !rel.startsWith(`..${sep}`) && rel.startsWith("hackathon-skills-test-")); await rm(path, { recursive: true, force: true }); } }; }
function fixture(agentId: InstallationManifest["agentId"] = "codex") {
  const bodies = { "SKILL.md": Buffer.from("---\nname: fixture-skill\ndescription: Isolated harmless test fixture\n---\nTest only.\n"), "LICENSE.txt": Buffer.from("MIT License\nFixture test only.\n"), "reference/check.md": Buffer.from("Fixture reference.\n") };
  const files: SkillFile[] = Object.entries(bodies).map(([relativePath, bytes]) => ({ relativePath, repositoryPath: `skills/fixture-skill/${relativePath}`, downloadUrl: `https://raw.githubusercontent.com/fixture/repository/${"a".repeat(40)}/skills/fixture-skill/${relativePath}`, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }));
  const manifest: InstallationManifest = { schemaVersion: "1", adapterVersion: "1", planId: "fixture-plan", agentId, scope: "project", bundleId: null, bundleVersion: null, expiresAt: "2099-01-01T00:00:00Z", items: [{ skillId: "fixture-skill", skillVersionId: "fixture-skill@" + "a".repeat(40), name: "fixture-skill", targetDirectory: `${AGENT_ADAPTERS.find(value => value.id === agentId)!.projectDirectory}/fixture-skill`, repository: "fixture/repository", commit: "a".repeat(40), files, license: { spdx: "MIT", sourceUrl: files[1].downloadUrl, filePath: "LICENSE.txt", sha256: files[1].sha256, redistribution: "allowed_with_notices" } }] };
  return { manifest, request: { planId: manifest.planId, manifestHash: hash(manifest), bridgeToken: "fixture-server-token" }, async fetchBytes(file: SkillFile) { return bodies[file.relativePath as keyof typeof bodies]; } };
}
test("real fixed catalog, licenses, Chinese tutorials, bundles and honest eight-tool evidence persist", async () => {
  const { pg, service } = await database(); try { const catalog = await service.list(); assert.equal(catalog.items.length, 8); assert.equal((await service.bundles()).items.length, 3); assert.equal(service.agents().items.length, 8); assert.ok(catalog.items.every(skill => skill.tutorial.steps.length === 3 && skill.versions[0].files.some(file => file.relativePath === skill.versions[0].license.filePath))); assert.ok(catalog.items.every(skill => skill.recommendation.taskEvaluation === "not_tested" && skill.recommendation.popularity === null)); assert.ok((await service.list({ track: "film" })).items.some(skill => skill.id === "create-specification")); assert.equal((await service.list({ search: "作品 README" })).items.length, 1); } finally { await pg.close(); }
});
test("plans bind owner, hash, expiry and fixed publication; seeding never revives withdrawn version", async () => {
  const { pg, service, repository } = await database(); try {
    time = new Date("2026-10-08T10:00:00Z"); const plan = await service.createPlan(user, { agentId: "codex", bundleId: "agent-demo", scope: "project", acknowledgeUnverifiedCompatibility: true });
    await assert.rejects(service.getPlan({ ...user, userId: "other" }, plan.planId), /不存在/);
    await assert.rejects(service.confirm(user, plan.planId, { manifestHash: "wrong", confirm: true }), /精确清单/);
    const confirmed = await service.confirm(user, plan.planId, { manifestHash: plan.manifestHash, confirm: true }); assert.equal(confirmed.plan.status, "confirmed");
    const credentials = { planId: plan.planId, manifestHash: plan.manifestHash, bridgeToken: confirmed.bridgeToken }; assert.equal((await service.authorizeBridge(credentials)).manifest.items.length, 3);
    await service.withdraw({ ...user, platformRoles: ["reviewer"] }, "mcp-builder", INITIAL_SKILLS.find(value => value.id === "mcp-builder")!.versions[0].id, "Fixture withdrawal");
    await seedInitialSkills(repository); await assert.rejects(service.authorizeBridge(credentials), /撤回/);
    time = new Date("2026-10-08T10:16:00Z"); await assert.rejects(service.authorizeBridge(credentials), /过期/);
  } finally { await pg.close(); }
});
test("tool choice filters exact versions and missing declarations prevent new or pending installs", async () => {
  const { pg, service, repository } = await database();
  try {
    time = new Date("2026-10-08T10:00:00Z");
    const original = INITIAL_SKILLS.find(skill => skill.id === "create-readme")!;
    const plan = await service.createPlan(user, { agentId: "cursor", skillVersionIds: [original.versions[0].id], scope: "project", acknowledgeUnverifiedCompatibility: true });
    await repository.transaction(tx => tx.putSkill({ ...original, versions: original.versions.map(version => ({ ...version, compatibility: version.compatibility.filter(value => value.agentId === "codex") })) }));
    assert.equal((await service.list({ agentId: "cursor", search: "作品 README" })).items.length, 0);
    assert.equal((await service.list({ agentId: "codex", search: "作品 README" })).items.length, 1);
    await assert.rejects(service.createPlan(user, { agentId: "cursor", skillVersionIds: [original.versions[0].id], scope: "project", acknowledgeUnverifiedCompatibility: true }), /路径与格式依据/);
    await assert.rejects(service.confirm(user, plan.planId, { manifestHash: plan.manifestHash, confirm: true }), /路径与格式依据/);
    assert.equal((await service.getPlan(user, plan.planId)).status, "preview");
  } finally { await pg.close(); }
});
test("private HTTP uses trusted actor and CSRF; copied/downloaded plan is not installed", async () => {
  const { pg, service } = await database(); try { time = new Date("2026-10-08T10:00:00Z"); let csrf = 0;
    const handlers = createSkillsHttpHandlers({ service, resolveActor: async () => user, assertMutationAllowed: async () => { csrf++; }, requestId: () => "request" });
    const response = await handlers.createPlan(new Request("https://website.test/api/v1/me/skill-installation-plans", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agentId: "claude-code", bundleId: "film-production", scope: "project", acknowledgeUnverifiedCompatibility: true, userId: "forged" }) })); assert.equal(response.status, 200); const { data } = await response.json(); assert.equal(data.userId, user.userId); assert.equal(data.status, "preview"); assert.equal(csrf, 1);
    const anonymous = createSkillsHttpHandlers({ service, resolveActor: async () => null, assertMutationAllowed: async () => {}, requestId: () => "request" }); assert.equal((await anonymous.plan(data.planId)(new Request("https://website.test"))).status, 401);
  } finally { await pg.close(); }
});
test("receipt rejects forged files; file write and user-reported loading are separate persistent facts", async () => {
  const { pg, service } = await database(); try { time = new Date("2026-10-08T10:00:00Z"); const plan = await service.createPlan(user, { agentId: "codex", skillVersionIds: [INITIAL_SKILLS.find(value => value.id === "create-readme")!.versions[0].id], scope: "project", acknowledgeUnverifiedCompatibility: true }); const confirmed = await service.confirm(user, plan.planId, { manifestHash: plan.manifestHash, confirm: true });
    const receipt: InstallationReceipt = { id: "receipt-fixture", planId: plan.planId, manifestHash: plan.manifestHash, agentId: plan.agentId, status: "installed", fileStatus: "written", loadStatus: "not_verified", taskStatus: "not_verified", evidenceSource: "local_bridge_reported", items: plan.items.map(item => ({ skillVersionId: item.skillVersionId, files: item.files.map(file => ({ path: `${item.targetDirectory}/${file.relativePath}`, sha256: file.sha256, bytes: file.bytes })) })), createdAt: time.toISOString(), note: null };
    const input = { planId: plan.planId, manifestHash: plan.manifestHash, bridgeToken: confirmed.bridgeToken, receipt };
    await assert.rejects(service.recordBridgeReceipt({ ...input, receipt: { ...receipt, items: [] } }), /精确清单/); await service.recordBridgeReceipt(input);
    const result = await service.installations(user); assert.equal(result.plans[0].status, "installed"); assert.equal(result.receipts[0].loadStatus, "not_verified"); await service.recordBridgeReceipt({ ...input, receipt: { ...receipt, loadStatus: "user_reported_loaded", note: "I checked my client." } }); assert.equal((await service.installations(user)).receipts[0].loadStatus, "user_reported_loaded");
  } finally { await pg.close(); }
});
for (const agent of AGENT_ADAPTERS) test(`bridge ${agent.id}: real isolated file write, byte verification, own-file revoke and replay`, async () => {
  const temp = await temporary(); const sample = fixture(agent.id); const bridge = await createSkillsBridge({ projectRoot: temp.path, origin: "https://website.test", serverOrigin: "https://website.test", authorize: async () => ({ manifest: sample.manifest, manifestHash: sample.request.manifestHash }), fetchBytes: sample.fetchBytes, report: async () => {} });
  try { const result = await bridge.install(sample.request); assert.equal(result.receipt.fileStatus, "written"); assert.equal(result.receipt.loadStatus, "not_verified"); assert.equal(result.receipt.taskStatus, "not_verified"); const target = join(temp.path, ...sample.manifest.items[0].targetDirectory.split("/")); assert.match(await readFile(join(target, "SKILL.md"), "utf8"), /harmless/); await writeFile(join(temp.path, "unrelated.txt"), "Preserve"); assert.equal((await bridge.install(sample.request)).receipt.id, result.receipt.id); const revoked = await bridge.revoke(result.receipt.id); assert.equal(revoked.receipt.fileStatus, "removed"); assert.equal(await readFile(join(temp.path, "unrelated.txt"), "utf8"), "Preserve"); assert.equal((await bridge.revoke(result.receipt.id)).receipt.status, "revoked"); } finally { await bridge.close(); await temp.cleanup(); }
});
test("bridge rejects changed user files, tampered hash, traversal, and withdrawal during download", async () => {
  const temp = await temporary(); const sample = fixture(); let authorizeCount = 0; const bridge = await createSkillsBridge({ projectRoot: temp.path, origin: "https://website.test", serverOrigin: "https://website.test", authorize: async () => { authorizeCount++; if (authorizeCount === 2) throw new Error("Withdrawn after download"); return { manifest: sample.manifest, manifestHash: sample.request.manifestHash }; }, fetchBytes: sample.fetchBytes });
  try { await assert.rejects(bridge.install(sample.request), /Withdrawn/); await assert.rejects(lstat(join(temp.path, ".agents/skills/fixture-skill")), /ENOENT/); } finally { await bridge.close(); await temp.cleanup(); }
  const second = await temporary(); const tampered = fixture(); (tampered.manifest.items[0].files as SkillFile[])[0] = { ...tampered.manifest.items[0].files[0], relativePath: "../escape" };
  const bridge2 = await createSkillsBridge({ projectRoot: second.path, origin: "https://website.test", serverOrigin: "https://website.test", authorize: async () => ({ manifest: tampered.manifest, manifestHash: hash(tampered.manifest) }), fetchBytes: tampered.fetchBytes });
  try { await assert.rejects(bridge2.install({ ...tampered.request, manifestHash: hash(tampered.manifest) }), /路径/); } finally { await bridge2.close(); await second.cleanup(); }
  const third = await temporary(); const clean = fixture(); const bridge3 = await createSkillsBridge({ projectRoot: third.path, origin: "https://website.test", serverOrigin: "https://website.test", authorize: async () => ({ manifest: clean.manifest, manifestHash: clean.request.manifestHash }), fetchBytes: clean.fetchBytes, report: async () => {} });
  try { const result = await bridge3.install(clean.request); await writeFile(join(third.path, ".agents/skills/fixture-skill/SKILL.md"), "User change"); await assert.rejects(bridge3.revoke(result.receipt.id), /已改变/); assert.equal(await readFile(join(third.path, ".agents/skills/fixture-skill/SKILL.md"), "utf8"), "User change"); } finally { await bridge3.close(); await third.cleanup(); }
});
test("loopback HTTP requires exact Origin, Host and pair token and does not accept arbitrary commands", async () => {
  const temp = await temporary(); const sample = fixture(); const bridge = await createSkillsBridge({ projectRoot: temp.path, origin: "https://website.test", serverOrigin: "https://website.test", authorize: async () => ({ manifest: sample.manifest, manifestHash: sample.request.manifestHash }), fetchBytes: sample.fetchBytes, report: async () => {} });
  try { const address = await bridge.listen(); assert.equal((await fetch(`${address.url}/status`, { headers: { Origin: "https://evil.test", Authorization: `Bearer ${address.pairToken}` } })).status, 403); assert.equal((await fetch(`${address.url}/status`, { headers: { Origin: "https://website.test" } })).status, 403); const headers = { Origin: "https://website.test", Authorization: `Bearer ${address.pairToken}`, "Content-Type": "application/json" }; assert.equal((await fetch(`${address.url}/status`, { headers })).status, 200); assert.equal((await fetch(`${address.url}/execute`, { method: "POST", headers, body: JSON.stringify({ command: "never execute" }) })).status, 405); const response = await fetch(`${address.url}/install`, { method: "POST", headers, body: JSON.stringify(sample.request) }); assert.equal(response.status, 200); assert.equal((await response.json()).receipt.status, "installed"); } finally { await bridge.close(); await temp.cleanup(); }
});
test("junction outside project is refused before download or writes", async () => {
  const temp = await temporary(); const outside = await temporary(); const sample = fixture(); await symlink(outside.path, join(temp.path, ".agents"), process.platform === "win32" ? "junction" : "dir"); const bridge = await createSkillsBridge({ projectRoot: temp.path, origin: "https://website.test", serverOrigin: "https://website.test", authorize: async () => ({ manifest: sample.manifest, manifestHash: sample.request.manifestHash }), fetchBytes: sample.fetchBytes });
  try { await assert.rejects(bridge.install(sample.request), /符号链接|junction/); } finally { await bridge.close(); await temp.cleanup(); await outside.cleanup(); }
});
test("partial file failure rolls back only owned writes and retains existing project files", async () => {
  const temp = await temporary(); const sample = fixture(); await writeFile(join(temp.path, "keep.txt"), "existing"); let count = 0;
  const bridge = await createSkillsBridge({ projectRoot: temp.path, origin: "https://website.test", serverOrigin: "https://website.test", authorize: async () => ({ manifest: sample.manifest, manifestHash: sample.request.manifestHash }), fetchBytes: sample.fetchBytes, report: async () => {}, onFileWritten: async () => { if (++count === 2) throw new Error("Injected disk failure"); } });
  try { const result = await bridge.install(sample.request); assert.equal(result.receipt.status, "failed"); assert.equal(result.receipt.fileStatus, "rolled_back"); await assert.rejects(lstat(join(temp.path, ".agents/skills/fixture-skill")), /ENOENT/); assert.equal(await readFile(join(temp.path, "keep.txt"), "utf8"), "existing"); } finally { await bridge.close(); await temp.cleanup(); }
});
test("edited local receipt cannot authorize deletion of existing unrelated files", async () => {
  const temp = await temporary(); const sample = fixture(); const bridge = await createSkillsBridge({ projectRoot: temp.path, origin: "https://website.test", serverOrigin: "https://website.test", authorize: async () => ({ manifest: sample.manifest, manifestHash: sample.request.manifestHash }), fetchBytes: sample.fetchBytes, report: async () => {} });
  try { const result = await bridge.install(sample.request); const journalPath = join(temp.path, ".hackathon-skills", `${result.receipt.id}.json`); const journal = JSON.parse(await readFile(journalPath, "utf8")); journal.receipt.items[0].files[0].path = "unrelated.txt"; await writeFile(journalPath, JSON.stringify(journal)); await writeFile(join(temp.path, "unrelated.txt"), "Preserve"); await assert.rejects(bridge.revoke(result.receipt.id), /回执被改动/); assert.equal(await readFile(join(temp.path, "unrelated.txt"), "utf8"), "Preserve"); } finally { await bridge.close(); await temp.cleanup(); }
});
test("downloadable standalone helper actually starts without repo files or dependencies", async () => {
  const temp = await temporary(); const { pg, service } = await database();
  try { const handlers = createSkillsHttpHandlers({ service, resolveActor: async () => null, assertMutationAllowed: async () => {}, requestId: () => "request" }); const response = await handlers.downloadBridge(new Request("https://website.test/api/v1/skill-bridge/download")); assert.equal(response.status, 200); assert.match(response.headers.get("content-disposition")!, /\.mjs/); const path = join(temp.path, "hackathon-skills-bridge.mjs"); await writeFile(path, await response.text()); const result = spawnSync(process.execPath, [path, "--help"], { cwd: temp.path, encoding: "utf8" }); assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /明确授权的项目目录/); } finally { await pg.close(); await temp.cleanup(); }
});
test("download SHA mismatch never creates a target skill directory", async () => {
  const temp = await temporary(); const sample = fixture(); const bridge = await createSkillsBridge({ projectRoot: temp.path, origin: "https://website.test", serverOrigin: "https://website.test", authorize: async () => ({ manifest: sample.manifest, manifestHash: sample.request.manifestHash }), fetchBytes: async () => Buffer.from("Tampered response") });
  try { await assert.rejects(bridge.install(sample.request), /SHA256/); await assert.rejects(lstat(join(temp.path, ".agents/skills/fixture-skill")), /ENOENT/); } finally { await bridge.close(); await temp.cleanup(); }
});
test("loopback pairing expires and unexpected Host is refused", async () => {
  const temp = await temporary(); let clock = new Date("2026-10-08T10:00:00Z"); const bridge = await createSkillsBridge({ projectRoot: temp.path, origin: "https://website.test", serverOrigin: "https://website.test", now: () => clock });
  try { const address = await bridge.listen(); const headers = { Origin: "https://website.test", Authorization: `Bearer ${address.pairToken}` }; const forgedHostStatus = await new Promise<number>((done, reject) => { const request = rawHttpRequest(`${address.url}/status`, { headers: { ...headers, Host: "evil.test" } }, response => { response.resume(); done(response.statusCode!); }); request.on("error", reject); request.end(); }); assert.equal(forgedHostStatus, 403); clock = new Date("2026-10-08T10:31:00Z"); assert.equal((await fetch(`${address.url}/status`, { headers })).status, 403); } finally { await bridge.close(); await temp.cleanup(); }
});
test("pre-existing same-name skill is preserved even if its bytes match", async () => {
  const temp = await temporary(); const sample = fixture(); const path = join(temp.path, ".agents/skills/fixture-skill"); await mkdir(path, { recursive: true }); await writeFile(join(path, "SKILL.md"), "Existing user skill"); const bridge = await createSkillsBridge({ projectRoot: temp.path, origin: "https://website.test", serverOrigin: "https://website.test", authorize: async () => ({ manifest: sample.manifest, manifestHash: sample.request.manifestHash }), fetchBytes: sample.fetchBytes });
  try { await assert.rejects(bridge.install(sample.request), /同名技能/); assert.equal(await readFile(join(path, "SKILL.md"), "utf8"), "Existing user skill"); } finally { await bridge.close(); await temp.cleanup(); }
});
