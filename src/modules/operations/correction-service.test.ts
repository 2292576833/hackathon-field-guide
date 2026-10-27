import test from "node:test";
import assert from "node:assert/strict";
import type { Actor } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { Correction, CorrectionRepository, CorrectionTransaction, CorrectionTransition } from "./correction-types.ts";
import { CorrectionService } from "./correction-service.ts";

const owner: Actor = { userId: "owner", platformRoles: ["user"] };
const stranger: Actor = { userId: "stranger", platformRoles: ["user"] };
const admin: Actor = { userId: "admin", platformRoles: ["admin"] };
const target = { kind: "resource" as const, entityId: "r1", version: 1 };
function fixture() {
  let id = 0;
  const store = { records: new Map<string, Correction>(), history: [] as CorrectionTransition[], failHistory: false, targetCalls: 0 };
  let tail = Promise.resolve();
  const repository: CorrectionRepository = {
    async transaction<T>(work: (tx: CorrectionTransaction) => Promise<T>): Promise<T> {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>(resolve => { release = resolve; });
      await previous;
      const records = structuredClone(store.records); const history = structuredClone(store.history);
      const tx: CorrectionTransaction = { query: async () => ({ rows: [], rowCount: 0 }),
        getCorrection: async correctionId => records.get(correctionId) ?? null,
        insertCorrection: async record => { records.set(record.id, record); },
        saveCorrection: async (record, expected) => {
          if (records.get(record.id)?.revision !== expected) throw new DomainError("VERSION_CONFLICT", "冲突");
          records.set(record.id, record);
        },
        appendTransition: async transition => { if (store.failHistory) throw new Error("history failure"); history.push(transition); },
      };
      try { const result = await work(tx); store.records = records; store.history = history; return result; } finally { release(); }
    },
    listOwn: async userId => [...store.records.values()].filter(r => r.submittedBy === userId),
    listQueue: async status => [...store.records.values()].filter(r => !status || r.status === status),
  };
  const service = new CorrectionService({ repository, clock: { now: () => new Date("2026-10-08T08:00:00Z") }, ids: { next: () => `id-${++id}` },
    targets: { isPublicVersion: async (_tx, reference) => { store.targetCalls++; return reference.entityId === "r1" && reference.version <= 2; } } });
  async function submit() { return service.submit(owner, { target, field: "费用", message: "免费档已调整", evidenceUrls: ["https://tools.example/pricing"] }); }
  return { store, service, submit };
}
function code(expected: string) { return (error: unknown) => error instanceof DomainError && error.code === expected; }

test("users submit and view own station status; another user cannot infer request existence", async () => {
  const { service, submit } = fixture();
  const created = await submit();
  assert.equal(created.status, "received");
  assert.equal((await service.getOwn(owner, created.id)).original.message, "免费档已调整");
  assert.equal((await service.listOwn(stranger)).length, 0);
  await assert.rejects(service.getOwn(stranger, created.id), code("NOT_FOUND"));
  await assert.rejects(service.getOwn(admin, created.id), code("NOT_FOUND"));
  assert.equal((await service.getForReview(admin, created.id)).id, created.id);
});
test("public-version-only reference port and field validation reject private/unknown targets", async () => {
  const { service, store } = fixture();
  await assert.rejects(service.submit(owner, { target: { ...target, entityId: "private-project" }, field: "日期", message: "错误" }), code("NOT_FOUND"));
  await assert.rejects(service.submit(owner, { target: { ...target, kind: "project" as "resource" }, field: "日期", message: "错误" }), code("INVALID_INPUT"));
  await assert.rejects(service.submit(owner, { target, field: "日期", message: "错误", evidenceUrls: ["https://user:password@tools.example/"] }), code("INVALID_INPUT"));
  assert.equal(store.records.size, 0); assert.equal(store.targetCalls, 1);
});
test("review permissions and required reason are enforced in service", async () => {
  const { service, submit } = fixture();
  const created = await submit();
  await assert.rejects(service.listQueue(owner), code("OPERATIONS_FORBIDDEN"));
  await assert.rejects(service.process(owner, created.id, { expectedRevision: 1, status: "triaging", reason: "核查" }, "req"), code("OPERATIONS_FORBIDDEN"));
  await assert.rejects(service.process(admin, created.id, { expectedRevision: 1, status: "triaging", reason: " " }, "req"), code("INVALID_INPUT"));
  await assert.rejects(service.process(admin, created.id, { expectedRevision: 1, status: "resolved", reason: "完成" }, "req"), code("INVALID_CORRECTION_STATE"));
});
test("confirmed correction resolves only with a newer version of the same public content", async () => {
  const { store, service, submit } = fixture();
  const created = await submit();
  await service.process(admin, created.id, { expectedRevision: 1, status: "triaging", reason: "核对官方费用页" }, "req");
  await service.process(admin, created.id, { expectedRevision: 2, status: "confirmed", reason: "费用说明确有变更" }, "req");
  await assert.rejects(service.process(admin, created.id, { expectedRevision: 3, status: "resolved", reason: "修正" }, "req"), code("RESOLUTION_VERSION_REQUIRED"));
  await assert.rejects(service.process(admin, created.id, { expectedRevision: 3, status: "resolved", reason: "修正", relatedVersion: target }, "req"), code("RESOLUTION_VERSION_REQUIRED"));
  await assert.rejects(service.process(admin, created.id, { expectedRevision: 3, status: "resolved", reason: "修正", relatedVersion: { ...target, entityId: "other" } }, "req"), code("INVALID_RELATED_VERSION"));
  const resolved = await service.process(admin, created.id, { expectedRevision: 3, status: "resolved", reason: "费用说明已修正", relatedVersion: { ...target, version: 2 } }, "req");
  assert.equal(resolved.status, "resolved"); assert.equal(resolved.relatedVersion?.version, 2);
  assert.deepEqual(resolved.original, created.original); assert.equal(store.history.length, 3);
  assert.equal((await service.getOwn(owner, created.id)).response, "费用说明已修正");
});
test("needs-more-info can return to triage; dismissed response can be closed without inventing a corrected version", async () => {
  const { service, submit } = fixture();
  const created = await submit();
  await service.process(admin, created.id, { expectedRevision: 1, status: "triaging", reason: "开始核查" }, "req");
  await service.process(admin, created.id, { expectedRevision: 2, status: "needs_more_info", reason: "请提供具体价格与日期" }, "req");
  await service.process(admin, created.id, { expectedRevision: 3, status: "triaging", reason: "已补充官方依据，继续核查" }, "req");
  await service.process(admin, created.id, { expectedRevision: 4, status: "dismissed", reason: "该版本已准确区分免费档与付费档" }, "req");
  const resolved = await service.process(admin, created.id, { expectedRevision: 5, status: "resolved", reason: "核查结束，原内容保留" }, "req");
  assert.equal(resolved.relatedVersion, null);
  await assert.rejects(service.process(admin, created.id, { expectedRevision: 6, status: "triaging", reason: "重开" }, "req"), code("INVALID_CORRECTION_STATE"));
});
test("concurrent stale reviewer process rejects; history failure rolls state back", async () => {
  const { store, service, submit } = fixture();
  const created = await submit();
  store.failHistory = true;
  await assert.rejects(service.process(admin, created.id, { expectedRevision: 1, status: "triaging", reason: "核查" }, "req"), /history failure/);
  assert.equal(store.records.get(created.id)?.status, "received");
  store.failHistory = false;
  const calls = await Promise.allSettled([
    service.process(admin, created.id, { expectedRevision: 1, status: "triaging", reason: "核查一" }, "req"),
    service.process(admin, created.id, { expectedRevision: 1, status: "triaging", reason: "核查二" }, "req"),
  ]);
  assert.equal(calls.filter(r => r.status === "fulfilled").length, 1);
  const rejected = calls.find(r => r.status === "rejected");
  assert.equal(rejected?.status === "rejected" && rejected.reason.code, "VERSION_CONFLICT");
  assert.equal(store.history.length, 1);
});
