import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { DraftProtection, type DraftProtectionTransport } from "./protection.ts";
import { documentDraftKey, emptyDocumentDraft, type DocumentDraft, type DocumentDraftCollection, type DraftPublication, type DraftPublicationOutcome } from "./model.ts";

function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const error = (status: number, code: string) => Object.assign(new Error(code), { status, code });
function fixture(t: TestContext) {
  const records = new Map<string, DocumentDraft>(); let saves = 0, publishes = 0, inflight = 0, maximum = 0;
  let initial: Promise<DocumentDraftCollection> | null = null, saveHook: (() => Promise<void>) | null = null, publishHook: (() => Promise<DraftPublicationOutcome>) | null = null;
  let saveFailure: unknown = null, receipt: DraftPublication | null = null;
  const get = (id: string | null) => records.get(documentDraftKey(id)) ?? emptyDocumentDraft("a", "p", id);
  const transport: DraftProtectionTransport = {
    async list() { return initial ?? { ownerId: "a", projectId: "p", items: [...records.values()] }; },
    async get(id) { return get(id); },
    async save(id, input) {
      saves++; inflight++; maximum = Math.max(maximum, inflight);
      try {
        await saveHook?.(); if (saveFailure) throw saveFailure;
        const current = get(id); if (current.revision !== input.expectedRevision) throw error(409, "VERSION_CONFLICT");
        const saved = { ...current, revision: current.revision + 1, contentRevision: current.contentRevision + 1, body: input.body,
          baseDocumentRevision: input.baseDocumentRevision, deletedAt: null, updatedAt: "2026-10-12T10:00:00Z" };
        records.set(documentDraftKey(id), saved); return saved;
      } finally { inflight--; }
    },
    async remove(id, expected) { const current = get(id); if (current.revision !== expected) throw error(409, "VERSION_CONFLICT");
      const removed = { ...current, revision: current.revision + 1, body: null, deletedAt: "2026-10-12T10:00:00Z" };
      records.set(documentDraftKey(id), removed); return removed; },
    async publish(id, input) {
      publishes++; if (publishHook) return publishHook();
      const current = get(id);
      if (current.revision !== input.expectedRevision) throw error(409, "VERSION_CONFLICT");
      receipt = { attemptId: input.attemptId, documentId: id, targetDocumentId: id, sourceDraftRevision: current.revision,
        contentRevision: current.contentRevision, body: current.body!, baseDocumentRevision: current.baseDocumentRevision,
        status: "succeeded", startedAt: "2026-10-12T10:00:00Z", updatedAt: "2026-10-12T10:00:00Z", finishedAt: "2026-10-12T10:00:00Z",
        result: { documentId: id ?? "created", documentRevision: 1 }, cleared: true, errorCode: null, errorMessage: null };
      const draft = { ...current, body: null, revision: current.revision + 2, publication: receipt };
      records.set(documentDraftKey(id), draft); return { receipt, draft };
    },
    async receipt() { return receipt; },
  };
  const controller = new DraftProtection({ ownerId: "a", projectId: "p", transport, debounceMs: 60_000, attemptId: () => "stable-attempt-0001" });
  t.after(() => controller.dispose());
  return { controller, records, transport, get, entry: (id: string | null = null) => controller.snapshot().entries.find(entry => entry.documentId === id)!,
    saves: () => saves, publishes: () => publishes, maximum: () => maximum,
    initial: (promise: Promise<DocumentDraftCollection>) => { initial = promise; }, onSave: (hook: () => Promise<void>) => { saveHook = hook; },
    saveFailure: (reason: unknown) => { saveFailure = reason; }, onPublish: (hook: () => Promise<DraftPublicationOutcome>) => { publishHook = hook; },
    setReceipt: (saved: DraftPublication) => { receipt = saved; },
  };
}
const saved = (body: string, revision = 3): DocumentDraft => ({ ...emptyDocumentDraft("a", "p", null), revision, contentRevision: revision, body, updatedAt: "2026-10-12T10:00:00Z" });

test("an archive rejection immediately stops editing and publication while preserving both private inputs", async t => {
  const f = fixture(t); await f.controller.load();
  f.controller.change(null,"新文档尚未保护的正文");
  f.controller.edit("existing","旧文档的私人编辑",1);
  f.controller.change("existing","需要保留的编辑内容");
  f.saveFailure(error(409,"PROJECT_ARCHIVED"));
  await f.controller.flush("existing");
  assert.equal(f.controller.snapshot().readOnly,true);
  assert.equal(f.entry().body,"新文档尚未保护的正文");
  assert.equal(f.entry("existing").body,"需要保留的编辑内容");
  assert.equal(await f.controller.publish("existing"),null); assert.equal(f.publishes(),0);
  f.controller.change(null,"归档后不能继续改变输入");
  assert.equal(f.entry().body,"新文档尚未保护的正文");
});

test("异步初始GET不覆盖已开始输入，旧私稿需明确恢复或覆盖", async t => {
  const f = fixture(t), pending = deferred<DocumentDraftCollection>(); f.initial(pending.promise);
  const load = f.controller.load(); f.controller.change(null, "GET期间的新输入");
  const old = saved("旧私人草稿"); f.records.set("new", old);
  pending.resolve({ ownerId: "a", projectId: "p", items: [old] }); await load;
  assert.equal(f.entry().body, "GET期间的新输入"); assert.equal(f.entry().status, "conflict"); assert.equal(f.saves(), 0);
  await f.controller.resolve(null, "restore"); assert.equal(f.entry().body, "旧私人草稿"); assert.equal(f.entry().dirty, false);
});

test("输入去抖合并，保护严格串行，旧保护回执不会清掉较新输入", async t => {
  const f = fixture(t); await f.controller.load();
  const gate = deferred<void>(); let calls = 0; f.onSave(async () => { if (++calls === 1) await gate.promise; });
  f.controller.change(null, "初稿"); const flush = f.controller.flush(null);
  await new Promise<void>(resolve => setImmediate(resolve));
  f.controller.change(null, "第二稿"); f.controller.change(null, "第三稿");
  gate.resolve(); await flush;
  assert.equal(f.get(null).body, "第三稿"); assert.equal(f.entry().body, "第三稿"); assert.equal(f.entry().dirty, false);
  assert.equal(f.saves(), 2); assert.equal(f.maximum(), 1); assert.equal(f.publishes(), 0);
});

test("真实CAS拒绝保持屏幕输入，未明确选择前不覆盖另一窗口", async t => {
  const f = fixture(t); await f.controller.load();
  f.controller.change(null, "本页正文"); f.records.set("new", saved("另一窗口", 1));
  assert.equal(await f.controller.flush(null), false);
  assert.equal(f.entry().body, "本页正文"); assert.equal(f.entry().status, "conflict"); assert.equal(f.get(null).body, "另一窗口");
  const before = f.saves(); await f.controller.flush(null); assert.equal(f.saves(), before);
  await f.controller.resolve(null, "keep"); assert.equal(f.get(null).body, "本页正文"); assert.equal(f.get(null).revision, 2);
});

test("保护失败不伪造成功、保留输入并提示离开风险，重读确认后可显式重试", async t => {
  const f = fixture(t); await f.controller.load(); f.saveFailure(new Error("transport failed"));
  f.controller.change(null, "失败也保留正文"); assert.equal(await f.controller.flush(null), false);
  assert.equal(f.entry().body, "失败也保留正文"); assert.equal(f.entry().status, "error"); assert.equal(f.controller.needsLeaveWarning(), true);
  f.saveFailure(null); await f.controller.resolve(null, "keep"); assert.equal(f.entry().status, "protected");
  assert.equal(f.controller.needsLeaveWarning(), false);
});

test("刷新新实例恢复私人正文，尚未发布，归档能复制不能保护/发布", async t => {
  const f = fixture(t); f.records.set("new", saved("恢复的完整正文\n尾行")); await f.controller.load();
  assert.equal(f.entry().body, "恢复的完整正文\n尾行"); assert.equal(f.entry().status, "protected"); assert.equal(f.publishes(), 0);
  f.controller.setWritable(false); f.controller.change(null, "归档不改"); assert.equal(f.entry().body, "恢复的完整正文\n尾行");
  assert.equal(await f.controller.publish(null), null); assert.equal(f.publishes(), 0);
});

test("当前身份失败立即隐藏所有输入，旧异步回执和身份不匹配的GET均不泄露", async t => {
  const f = fixture(t); await f.controller.load(); const gate = deferred<void>(); f.onSave(() => gate.promise);
  f.controller.change(null, "旧账号私稿"); const flush = f.controller.flush(null);
  await new Promise<void>(resolve => setImmediate(resolve)); f.controller.block(); gate.resolve(); await flush;
  assert.equal(f.controller.snapshot().phase, "blocked"); assert.deepEqual(f.controller.snapshot().entries, []);
  const other = fixture(t); other.initial(Promise.resolve({ ownerId: "other", projectId: "p", items: [{ ...saved("别人正文"), ownerId: "other" }] }));
  other.controller.change(null, "旧输入"); await other.controller.load();
  assert.equal(other.controller.snapshot().phase, "blocked"); assert.deepEqual(other.controller.snapshot().entries, []);
});

test("私稿保护成功不算发布，手动保存等待保护后使用其指定版本", async t => {
  const f = fixture(t); await f.controller.load(); f.controller.change(null, "需要明确保存的正文");
  await f.controller.flush(null); assert.equal(f.publishes(), 0); assert.equal(f.entry().body, "需要明确保存的正文");
  const result = await f.controller.publish(null); assert.equal(result?.receipt.status, "succeeded");
  assert.equal(f.publishes(), 1); assert.equal(f.entry().body, ""); assert.equal(f.entry().editing, false);
});

test("发布网络结果未知只用稳定key查询，不重复新建或删除私稿", async t => {
  const f = fixture(t); await f.controller.load(); f.controller.change(null, "原发布正文"); await f.controller.flush(null);
  f.onPublish(async () => { throw new Error("reply lost"); }); await f.controller.publish(null);
  assert.equal(f.entry().server.publication?.attemptId, "stable-attempt-0001");
  assert.equal(f.entry().server.publication?.status, "unknown"); assert.equal(f.entry().body, "原发布正文");
  assert.equal(await f.controller.publish(null), null); assert.equal(await f.controller.remove(null), false);
  await f.controller.checkPublication(null); assert.equal(f.publishes(), 1); assert.match(f.entry().error, /暂未查到/);
});

test("保护接口403立即清屏，401/403不是可以向另一身份恢复的草稿", async t => {
  const f = fixture(t); await f.controller.load(); f.controller.change(null, "离队前私稿"); f.saveFailure(error(403, "FORBIDDEN"));
  await f.controller.flush(null); assert.deepEqual(f.controller.snapshot().entries, []); assert.equal(f.controller.snapshot().phase, "blocked");
});

test("发布前已知CAS拒绝不生成虚假unknown回执，本页输入可明确恢复", async t => {
  const f = fixture(t); await f.controller.load(); f.controller.change(null, "本页原输入"); await f.controller.flush(null);
  f.onPublish(async () => { f.records.set("new", saved("另一个窗口的新正文", 2)); throw error(409, "VERSION_CONFLICT"); });
  await f.controller.publish(null); assert.equal(f.entry().body, "本页原输入"); assert.equal(f.entry().status, "conflict");
  assert.equal(f.entry().server.publication, null); assert.equal(f.get(null).body, "另一个窗口的新正文");
});

test("明确恢复私稿时晚到GET也不能覆盖恢复期间的新输入", async t => {
  const f = fixture(t); await f.controller.load(); f.controller.change(null, "原本页输入");
  const gate = deferred<DocumentDraft>(); f.transport.get = () => gate.promise;
  const restoring = f.controller.resolve(null, "restore"); f.controller.change(null, "读取期间新输入");
  gate.resolve(saved("远端私稿")); await restoring;
  assert.equal(f.entry().body, "读取期间新输入"); assert.equal(f.entry().status, "conflict"); assert.equal(f.saves(), 0);
});

test("删除私稿期间继续输入，不因晚到删除回执清掉新正文", async t => {
  const f = fixture(t); await f.controller.load(); f.controller.change(null, "原正文"); await f.controller.flush(null);
  const gate = deferred<DocumentDraft>(); f.transport.remove = () => gate.promise;
  const removing = f.controller.remove(null); await new Promise<void>(resolve => setImmediate(resolve)); f.controller.change(null, "删除期间继续输入");
  gate.resolve({ ...saved("", 2), body: null }); await removing;
  assert.equal(f.entry().body, "删除期间继续输入"); assert.equal(f.entry().dirty, true); assert.equal(f.entry().server.revision, 2);
});
