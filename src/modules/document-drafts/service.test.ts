import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { Actor } from "../../shared/contracts.ts";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import { DomainError } from "../../shared/errors.ts";
import { createDocumentDrafts } from "./service.ts";
import type { DocumentDraftDependencies, DocumentDraftSessionGuard } from "./ports.ts";

const owner: Actor = { userId: "owner", platformRoles: ["user"] }, member: Actor = { userId: "member", platformRoles: ["user"] };
const guard: DocumentDraftSessionGuard = async () => {};
async function fixture(t: TestContext) {
  const engine = new PGlite(); await engine.waitReady; t.after(() => engine.close());
  await engine.exec(await readFile(new URL("./schema.sql", import.meta.url), "utf8"));
  // The root writer Port uses real SQL against a separate fixture table. No
  // production or another module's storage is read by the drafts service.
  await engine.exec("CREATE TABLE fixture_documents(id text PRIMARY KEY,title text NOT NULL,body text NOT NULL,revision integer NOT NULL)");
  const executor = (source: Pick<PGlite, "query">): SqlExecutor => ({ async query<Row>(statement: string, parameters: readonly unknown[] = []) {
    const result = await source.query<Row>(statement, [...parameters]); return { rows: result.rows, rowCount: result.rows.length || result.affectedRows || 0 };
  } });
  const sql = executor(engine);
  let beforeTransaction: (() => Promise<void>) | null = null;
  let loseCommitAck = false;
  const database: DatabasePort = { query: sql.query, async transaction(work) {
    const hook = beforeTransaction; beforeTransaction = null; await hook?.();
    const result = await engine.transaction(tx => work(executor(tx)));
    if (loseCommitAck && result && typeof result === "object" && "receipt" in result
      && (result as { receipt: { status: string } }).receipt.status === "succeeded") {
      loseCommitAck = false; throw new Error("commit acknowledged only by later receipt query");
    }
    return result;
  } };
  let archived = false, active = true, session = true, writerCalls = 0, failure: unknown = null, zeroRows = false, revokeAfterWriter = false;
  const members = new Set(["owner", "member"]);
  const dependencies: DocumentDraftDependencies = { database, clock: { now: () => new Date("2026-10-12T10:00:00Z") },
    async authorize(transaction, actor, projectId, write, requestGuard) {
      await requestGuard(transaction);
      if (!active || !session || !members.has(actor.userId) || projectId !== "p") throw new DomainError("FORBIDDEN", "当前权限已失效", { status: 403 });
      if (archived && write) throw new DomainError("PROJECT_ARCHIVED", "空间已归档", { status: 409 });
    }, writer: { async write(transaction, actor, projectId, input) {
      writerCalls++;
      if (failure) throw failure;
      const id = input.documentId ?? `published-${writerCalls}`;
      if (input.documentId === null) await transaction.query("INSERT INTO fixture_documents VALUES($1,$2,$3,1)", [id, input.title, input.body]);
      else {
        const saved = await transaction.query<{ revision: number }>("UPDATE fixture_documents SET body=$2,revision=revision+1 WHERE id=$1 AND revision=$3 RETURNING revision", [id, input.body, input.expectedRevision]);
        if (saved.rowCount !== 1) throw new DomainError("VERSION_CONFLICT", "团队正文有新版本", { status: 409 });
      }
      if (revokeAfterWriter) session = false;
      if (zeroRows) {
        const original = transaction.query;
        transaction.query = async <Row>(statement: string, parameters?: readonly unknown[]) => statement.startsWith("UPDATE document_drafts SET revision=revision+1,content_revision=content_revision+$4")
          ? { rows: [], rowCount: 0 } : original<Row>(statement, parameters);
      }
      const row = await transaction.query<{ revision: number }>("SELECT revision FROM fixture_documents WHERE id=$1", [id]);
      return { id, revision: row.rows[0]!.revision };
    } } };
  const service = createDocumentDrafts(dependencies);
  const save = (body = "\n第一行\n正文\n") => service.save(owner, "p", null, { expectedRevision: 0, body, baseDocumentRevision: null }, guard);
  return { engine, service, save, database, newService: () => createDocumentDrafts(dependencies), loseCommitAck: () => { loseCommitAck = true; },
    calls: () => writerCalls, fail: (reason: unknown) => { failure = reason; }, archive: () => { archived = true; },
    revoke: () => { members.delete("owner"); }, suspend: () => { active = false; }, expire: () => { session = false; },
    zeroRows: () => { zeroRows = true; }, revokeAfterWriter: () => { revokeAfterWriter = true; },
    beforeNextTransaction: (hook: () => Promise<void>) => { beforeTransaction = hook; },
  };
}

test("GET空记录不初始化；按账号/空间/文档隔离私人正文与真实CAS", async t => {
  const f = await fixture(t);
  assert.equal((await f.service.get(owner, "p", null, guard)).revision, 0);
  assert.deepEqual((await f.service.list(owner, "p", guard)).items, []);
  assert.equal((await f.engine.query<{ n: number }>("SELECT count(*)::int n FROM document_drafts")).rows[0]!.n, 0);
  const saved = await f.save(); assert.equal(saved.body, "\n第一行\n正文\n"); assert.equal(saved.revision, 1);
  assert.equal((await f.service.get(member, "p", null, guard)).body, null);
  assert.deepEqual((await f.service.list(member, "p", guard)).items, []);
  const edited = await f.service.save(owner, "p", "existing", { expectedRevision: 0, body: "另一个文档", baseDocumentRevision: 7 }, guard);
  assert.equal(edited.baseDocumentRevision, 7);
  await assert.rejects(f.service.save(owner, "p", null, { expectedRevision: 0, body: "旧窗口", baseDocumentRevision: null }, guard), { code: "VERSION_CONFLICT" });
  assert.deepEqual(await f.service.get(owner, "p", null, guard), saved);
});

test("删除保留revision墓碑，旧窗口不复活；空字符串与墓碑分开", async t => {
  const f = await fixture(t), first = await f.save("");
  assert.equal(first.body, "");
  const removed = await f.service.remove(owner, "p", null, { expectedRevision: 1 }, guard);
  assert.equal(removed.body, null); assert.equal(removed.revision, 2);
  await assert.rejects(f.service.save(owner, "p", null, { expectedRevision: 0, body: "旧值", baseDocumentRevision: null }, guard), { code: "VERSION_CONFLICT" });
  const fresh = await f.service.save(owner, "p", null, { expectedRevision: 2, body: "新草稿", baseDocumentRevision: null }, guard);
  assert.equal(fresh.revision, 3);
});

test("授权/guard当前复核；归档可恢复读取不能保存/发布，离队与失效账号不泄露输入", async t => {
  for (const mode of ["archive", "revoke", "suspend", "expire"] as const) {
    const f = await fixture(t); await f.save(); f[mode]();
    const code = mode === "archive" ? "PROJECT_ARCHIVED" : "FORBIDDEN";
    if (mode === "archive") assert.equal((await f.service.get(owner, "p", null, guard)).body, "\n第一行\n正文\n");
    else await assert.rejects(f.service.list(owner, "p", guard), { code });
    await assert.rejects(f.service.save(owner, "p", null, { expectedRevision: 1, body: "新值", baseDocumentRevision: null }, guard), { code });
    await assert.rejects(f.service.publish(owner, "p", null, { expectedRevision: 1, attemptId: "attempt-scope-0001" }, guard), { code });
    assert.equal(f.calls(), 0);
  }
});

test("同事务复核失败回滚草稿，不省略请求guard", async t => {
  const f = await fixture(t); let calls = 0;
  const changing: DocumentDraftSessionGuard = async sql => { assert.ok(sql.query); if (++calls === 2) throw new DomainError("AUTH_SESSION_REVOKED", "当前会话撤销", { status: 401 }); };
  await assert.rejects(f.service.save(owner, "p", null, { expectedRevision: 0, body: "不应存入", baseDocumentRevision: null }, changing), { code: "AUTH_SESSION_REVOKED" });
  assert.equal((await f.service.get(owner, "p", null, guard)).revision, 0);
  await assert.rejects(f.service.get(owner, "p", null, undefined as unknown as DocumentDraftSessionGuard), { code: "AUTH_SESSION_REQUIRED" });
});

test("发布正文只来自已保护私稿，真实写入/回执/鲜稿清理一起提交，同key重放只读回执", async t => {
  const f = await fixture(t), first = await f.save();
  const input = { expectedRevision: first.revision, attemptId: "attempt-publish-0001" };
  const published = await f.service.publish(owner, "p", null, input, guard);
  assert.equal(published.receipt.status, "succeeded"); assert.equal(published.receipt.cleared, true);
  assert.equal(published.draft.body, null); assert.equal(published.draft.revision, 3);
  const docs = (await f.engine.query<{ title: string; body: string }>("SELECT * FROM fixture_documents")).rows;
  assert.equal(docs.length, 1); assert.equal(docs[0]!.title, "第一行"); assert.equal(docs[0]!.body, first.body);
  assert.deepEqual((await f.service.publish(owner, "p", null, input, guard)).receipt, published.receipt);
  assert.deepEqual(await f.service.getPublication(owner, "p", input.attemptId, guard), published.receipt);
  assert.equal(await f.service.getPublication(member, "p", input.attemptId, guard), null);
  assert.equal(f.calls(), 1);
  await assert.rejects(f.service.publish(owner, "p", null, { ...input, body: "客户端伪造", documentId: "伪造回执" }, guard), { code: "INVALID_INPUT" });
});

test("鲜稿清理零行不伪造发布成功，根文档写入同事务回滚", async t => {
  const f = await fixture(t); await f.save(); f.zeroRows();
  const result = await f.service.publish(owner, "p", null, { expectedRevision: 1, attemptId: "attempt-zero-0001" }, guard);
  assert.equal(result.receipt.status, "failed"); assert.equal(result.draft.body, "\n第一行\n正文\n");
  assert.deepEqual((await f.engine.query("SELECT * FROM fixture_documents")).rows, []);
});

test("已知失败保留私稿，显式同key重试；不会以重复请求自动重建", async t => {
  const f = await fixture(t); await f.save(); f.fail(new DomainError("WRITER_REJECTED", "已知失败", { status: 409 }));
  const input = { expectedRevision: 1, attemptId: "attempt-retry-0001" };
  assert.equal((await f.service.publish(owner, "p", null, input, guard)).receipt.status, "failed");
  f.fail(null);
  assert.equal((await f.service.publish(owner, "p", null, input, guard)).receipt.status, "failed"); assert.equal(f.calls(), 1);
  assert.equal((await f.service.publish(owner, "p", null, { ...input, retryFailed: true }, guard)).receipt.status, "succeeded"); assert.equal(f.calls(), 2);
});

test("未知结果持久hold，跨实例、同/换key、删除均不重放，GET不写", async t => {
  const f = await fixture(t); await f.save(); f.fail(new Error("uncertain commit, never expose"));
  const input = { expectedRevision: 1, attemptId: "attempt-unknown-0001" };
  const result = await f.service.publish(owner, "p", null, input, guard);
  assert.equal(result.receipt.status, "unknown"); assert.ok(!result.receipt.errorMessage!.includes("uncertain commit"));
  const current = await f.service.get(owner, "p", null, guard);
  assert.equal(current.publication?.status, "unknown");
  assert.equal((await f.service.publish(owner, "p", null, input, guard)).receipt.status, "unknown");
  assert.equal((await f.newService().publish(owner, "p", null, input, guard)).receipt.status, "unknown");
  await assert.rejects(f.service.publish(owner, "p", null, { expectedRevision: current.revision, attemptId: "attempt-other-0001" }, guard), { code: "DRAFT_PUBLICATION_PENDING" });
  await assert.rejects(f.service.remove(owner, "p", null, { expectedRevision: current.revision }, guard), { code: "DRAFT_PUBLICATION_PENDING" });
  assert.equal(f.calls(), 1);
  const protectedAgain = await f.service.save(owner, "p", null, { expectedRevision: current.revision, body: "继续私人保护", baseDocumentRevision: null }, guard);
  assert.equal(protectedAgain.publication?.attemptId, input.attemptId);
  assert.equal(protectedAgain.body, "继续私人保护");
});

test("同旧私稿版本并发发布最多创建一份；另一key不能覆盖", async t => {
  const f = await fixture(t); await f.save();
  const results = await Promise.allSettled([
    f.service.publish(owner, "p", null, { expectedRevision: 1, attemptId: "attempt-parallel-001" }, guard),
    f.service.publish(owner, "p", null, { expectedRevision: 1, attemptId: "attempt-parallel-002" }, guard),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal((await f.engine.query("SELECT * FROM fixture_documents")).rows.length, 1);
});

test("团队旧版本拒绝，私稿仍可恢复，没有伪造更新成功", async t => {
  const f = await fixture(t);
  await f.engine.query("INSERT INTO fixture_documents VALUES('existing','内部标题','最新正文',2)");
  await f.service.save(owner, "p", "existing", { expectedRevision: 0, body: "旧版编辑草稿", baseDocumentRevision: 1 }, guard);
  const result = await f.service.publish(owner, "p", "existing", { expectedRevision: 1, attemptId: "attempt-conflict-001" }, guard);
  assert.equal(result.receipt.errorCode, "VERSION_CONFLICT"); assert.equal(result.draft.body, "旧版编辑草稿");
  assert.equal((await f.engine.query<{ body: string }>("SELECT body FROM fixture_documents")).rows[0]!.body, "最新正文");
});

test("冻结后较新私稿没有被清理，新槽后续写同一文档而非重复新建", async t => {
  const f = await fixture(t); await f.save("明确发布的旧正文"); let checks = 0;
  const delayed: DocumentDraftSessionGuard = async () => {
    if (++checks === 2) f.beforeNextTransaction(async () => {
      const current = await f.service.get(owner, "p", null, guard);
      await f.service.save(owner, "p", null, { expectedRevision: current.revision, body: "另一窗口保护的新正文", baseDocumentRevision: null }, guard);
    });
  };
  const result = await f.service.publish(owner, "p", null, { expectedRevision: 1, attemptId: "attempt-newer-0001" }, delayed);
  assert.equal(result.receipt.status, "succeeded"); assert.equal(result.receipt.cleared, false);
  assert.equal(result.draft.body, "另一窗口保护的新正文"); assert.equal(result.draft.publishedDocumentId, result.receipt.result!.documentId);
  const next = await f.service.publish(owner, "p", null, { expectedRevision: result.draft.revision, attemptId: "attempt-newer-0002" }, guard);
  assert.equal(next.receipt.status, "succeeded"); assert.equal(next.receipt.result!.documentId, result.receipt.result!.documentId);
  const documents = (await f.engine.query<{ body: string }>("SELECT body FROM fixture_documents")).rows;
  assert.equal(documents.length, 1); assert.equal(documents[0]!.body, "另一窗口保护的新正文");
});

test("鲜稿已清但本页有较新输入，只能以本人的原可信回执继续编辑，不伪造目标", async t => {
  const f = await fixture(t); await f.save("原发布正文");
  const first = await f.service.publish(owner, "p", null, { expectedRevision: 1, attemptId: "attempt-continue-001" }, guard);
  await assert.rejects(f.service.save(owner, "p", null, { expectedRevision: first.draft.revision, body: "输入", baseDocumentRevision: 1, continuePublicationAttemptId: "attempt-forged-0001" }, guard), { code: "INVALID_INPUT" });
  const newer = await f.service.save(owner, "p", null, { expectedRevision: first.draft.revision, body: "原文档的后续输入", baseDocumentRevision: 1, continuePublicationAttemptId: first.receipt.attemptId }, guard);
  assert.equal(newer.publishedDocumentId, first.receipt.result!.documentId);
  const next = await f.service.publish(owner, "p", null, { expectedRevision: newer.revision, attemptId: "attempt-continue-002" }, guard);
  assert.equal(next.receipt.result!.documentId, first.receipt.result!.documentId);
  assert.equal((await f.engine.query("SELECT * FROM fixture_documents")).rows.length, 1);
});

test("已知失败后删除私稿，旧窗口不能借原尝试重试复活正文", async t => {
  const f = await fixture(t); await f.save(); f.fail(new DomainError("KNOWN_FAILED", "已回滚", { status: 409 }));
  const input = { expectedRevision: 1, attemptId: "attempt-deleted-001" };
  const failed = await f.service.publish(owner, "p", null, input, guard);
  await f.service.remove(owner, "p", null, { expectedRevision: failed.draft.revision }, guard); f.fail(null);
  await assert.rejects(f.service.publish(owner, "p", null, { ...input, retryFailed: true }, guard), { code: "VERSION_CONFLICT" });
  assert.equal(f.calls(), 1); assert.deepEqual((await f.engine.query("SELECT * FROM fixture_documents")).rows, []);
});

test("提交应答未知时用同事务回执核实成功，不重复创建也不伪造成功", async t => {
  const f = await fixture(t); await f.save("同事务真实保存"); f.loseCommitAck();
  const input = { expectedRevision: 1, attemptId: "attempt-commit-0001" };
  const result = await f.service.publish(owner, "p", null, input, guard);
  assert.equal(result.receipt.status, "succeeded"); assert.equal(result.draft.body, null);
  assert.equal((await f.newService().publish(owner, "p", null, input, guard)).receipt.status, "succeeded");
  assert.equal(f.calls(), 1); assert.equal((await f.engine.query("SELECT * FROM fixture_documents")).rows.length, 1);
});

test("正文写入后当前session撤销则原正文回滚，接受的尝试保留待核对", async t => {
  const f = await fixture(t); await f.save(); f.revokeAfterWriter();
  await assert.rejects(f.service.publish(owner, "p", null, { expectedRevision: 1, attemptId: "attempt-session-001" }, guard), { code: "FORBIDDEN" });
  assert.deepEqual((await f.engine.query("SELECT * FROM fixture_documents")).rows, []);
  assert.equal((await f.engine.query<{ status: string }>("SELECT status FROM document_draft_publications")).rows[0]!.status, "pending");
});

test("拒绝非法对象、伪造身份、额外字段、错误版本及正文控制字符", async t => {
  const f = await fixture(t);
  for (const input of [null, [], { expectedRevision: 0, body: "正文", baseDocumentRevision: null, ownerId: "member" },
    { expectedRevision: "0", body: "正文", baseDocumentRevision: null }, { expectedRevision: 0, body: "\u0000", baseDocumentRevision: null },
    { expectedRevision: 0, body: "x".repeat(20001), baseDocumentRevision: null }]) {
    await assert.rejects(f.service.save(owner, "p", null, input, guard), { code: "INVALID_INPUT" });
  }
  assert.deepEqual((await f.service.list(owner, "p", guard)).items, []);
  await assert.rejects(f.service.save(member, "p", null, { expectedRevision: 0, body: "旧账号输入不应转到新账号", baseDocumentRevision: null, expectedOwnerId: owner.userId }, guard), { code: "DRAFT_OWNER_CHANGED" });
  assert.deepEqual((await f.service.list(member, "p", guard)).items, []);
});
