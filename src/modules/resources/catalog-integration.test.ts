import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { Transaction } from "@electric-sql/pglite";
import type { Actor } from "../../shared/contracts.ts";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import { PostgresResourceReviewRepository, ResourceReviewService } from "../operations/index.ts";
import type { ResourceReview, ResourceReviewAudit } from "../operations/index.ts";
import { createResourceCatalogCli } from "./catalog-cli.ts";
import { createResourceCatalogCheckpointPort } from "./catalog-postgres.ts";
import type { ResourceCatalogCheckpoint, ResourceCatalogEntry } from "./catalog-types.ts";
import type { Resource } from "./domain.ts";
import { createOperationsResourcePublicationAdapter } from "./integration.ts";
import { createPostgresResourceRepository } from "./postgres.ts";
import { ResourceService } from "./service.ts";

const NOW = "2026-10-08T15:00:00.000Z";
const actor: Actor = {userId: "isolated-sql-reviewer", platformRoles: ["reviewer"]};
const candidate: ResourceCatalogEntry = {
  candidateKey: "isolated-sql-fixture", catalogVersion: "test-v1", verificationDate: "2026-10-08", reviewStatus: "candidate",
  input: {name: "Isolated SQL fixture", officialUrl: "https://sql-fixture.example.invalid/docs", type: "practical_tool",
    stageTags: ["delivery"], useTags: ["presentation"], stackTags: ["stack_agnostic"], prerequisites: ["browse"],
    summary: "仅用于隔离数据库集成验证", suitableFor: "本地测试", notSuitableFor: "不作为真实公开条目或链接可达证明", quickStart: ["仅在隔离实例运行"],
    costType: "unknown", costNote: "测试条目费用未知", costSourceUrl: null, costVerifiedAt: null,
    licenseStatus: "unknown", licenseNote: "测试条目许可未知", licenseSourceUrl: null, licenseVerifiedAt: null,
    verifiedAt: null, linkStatus: "unknown", displayOrder: 1},
  evidence: [{field: "purpose", url: "https://sql-fixture.example.invalid/docs", checkedAt: "2026-10-08T14:00:00.000Z", note: "仅为测试输入，无网络查阅"}],
  remainingChecks: ["测试不会验证网络、实际运营身份或应用连接池"],
};
const reviewArgs = ["--import", "--review", "--review-reason", "隔离测试操作者显式确认，费用与许可保留未知", "--confirm-links", "--ack-unknown"];

interface Counts {
  resources: number;
  history: number;
  checkpoints: number;
  reviews: number;
  audit: number;
  operations: number;
  notifications: number;
}
async function counts(database: PGlite): Promise<Counts> {
  const result = await database.query<Counts>(`SELECT
    (SELECT count(*)::integer FROM resource_records) AS resources,
    (SELECT count(*)::integer FROM resource_revisions) AS history,
    (SELECT count(*)::integer FROM resource_catalog_imports) AS checkpoints,
    (SELECT count(*)::integer FROM operations_resource_reviews) AS reviews,
    (SELECT count(*)::integer FROM operations_resource_review_audit) AS audit,
    (SELECT count(*)::integer FROM resource_publication_operations) AS operations,
    (SELECT count(*)::integer FROM resource_notifications) AS notifications`);
  return result.rows[0]!;
}

/** Executes real adapter SQL in isolated PGlite; no application DB, network or pool is used. */
test("PGlite SQL：目录导入经真实 M08 注册批准发布；失败原子回滚，恢复和重复运行不新增事实", {timeout: 30000}, async t => {
  const database = new PGlite();
  t.after(async () => { await database.close(); });
  const migrations = await Promise.all([
    readFile(new URL("./migrations/001-resources.sql", import.meta.url), "utf8"),
    readFile(new URL("./migrations/002-resource-catalog-imports.sql", import.meta.url), "utf8"),
    readFile(new URL("../operations/sql/resource-reviews.sql", import.meta.url), "utf8"),
  ]);
  for (const sql of migrations) await database.exec(sql);

  let idSequence = 0;
  const ids = {next: () => `integration-${String(++idSequence).padStart(6, "0")}`};
  const clock = {now: () => new Date(NOW)};
  let failAfterPublicationAudit = false;
  let stageTransactions = 0;
  let nestedCommitAttempts = 0;
  let m08PublicationCalls = 0;
  function executor(transaction: Transaction): SqlExecutor {
    return {
      async query<Row>(statement: string, parameters: readonly unknown[] = []) {
        const result = await transaction.query<Row>(statement, [...parameters]);
        if (failAfterPublicationAudit && statement.startsWith("INSERT INTO operations_resource_review_audit")
          && JSON.parse(parameters[6] as string).action === "resource_published") {
          failAfterPublicationAudit = false;
          throw new Error("Injected failure after real publication audit SQL");
        }
        return {rows: result.rows, rowCount: result.rows.length > 0 ? result.rows.length : result.affectedRows ?? 0};
      },
    };
  }
  const cli = createResourceCatalogCli({entries: [candidate], loadTrustedActor: async () => actor, clock, requestIds: ids,
    async runEach(work) {
      stageTransactions += 1;
      return database.transaction(async transaction => {
        const sql = executor(transaction);
        // All service-internal transaction requests reuse this executor and cannot commit separately.
        const port: DatabasePort = {query: (statement, parameters) => sql.query(statement, parameters),
          transaction: async callback => { nestedCommitAttempts += 1; return callback(sql); }};
        const resources = new ResourceService({repository: createPostgresResourceRepository(port), reviews: {getApprovedReview: async () => null}, clock, ids});
        const publication = createOperationsResourcePublicationAdapter({clock, ids,
          readReview: (tx, id) => new PostgresResourceReviewRepository({
            query: (statement, parameters) => tx.query(statement, parameters),
            transaction: callback => callback(tx),
          }).transaction(unit => unit.getReview(id)),
        });
        const reviews = new ResourceReviewService({repository: new PostgresResourceReviewRepository(port), resources: publication, clock, ids});
        const reviewPort = {register: reviews.register.bind(reviews), decide: reviews.decide.bind(reviews), getDetail: reviews.getDetail.bind(reviews),
          async publish(...args: Parameters<ResourceReviewService["publish"]>) { m08PublicationCalls += 1; return reviews.publish(...args); }};
        return work({resources, reviews: reviewPort, checkpoints: createResourceCatalogCheckpointPort(sql)});
      });
    },
  });

  const imported = await cli.run(["--import"]);
  const resourceId = imported.items[0]!.resourceId!;
  assert.equal(imported.items[0]?.stage, "imported");
  assert.deepEqual(await counts(database), {resources: 1, history: 1, checkpoints: 1, reviews: 0, audit: 0, operations: 0, notifications: 0});
  const draft = (await database.query<{working_document: Resource; public_document: Resource | null}>("SELECT working_document, public_document FROM resource_records WHERE id = $1", [resourceId])).rows[0]!;
  assert.equal(draft.working_document.publicationStatus, "draft");
  assert.equal(draft.working_document.linkStatus, "unknown");
  assert.equal(draft.working_document.verifiedAt, null);
  assert.equal(draft.public_document, null);

  const approved = await cli.run(reviewArgs);
  assert.equal(approved.items[0]?.stage, "approved");
  const approvedCounts = await counts(database);
  assert.deepEqual(approvedCounts, {resources: 1, history: 3, checkpoints: 1, reviews: 1, audit: 2, operations: 0, notifications: 0});
  const approvedCheckpoint = (await database.query<{document: ResourceCatalogCheckpoint}>("SELECT document FROM resource_catalog_imports WHERE candidate_key = $1", [candidate.candidateKey])).rows[0]!.document;
  const approvedReview = (await database.query<{payload: ResourceReview}>("SELECT payload FROM operations_resource_reviews WHERE id = $1", [approvedCheckpoint.reviewId])).rows[0]!.payload;
  assert.equal(approvedReview.status, "approved");
  assert.equal(approvedReview.reviewedBy, actor.userId);
  assert.equal(approvedReview.reviewedAt, NOW);
  assert.deepEqual(approvedReview.verification?.fees, {status: "unknown", sourceUrl: null});
  assert.deepEqual(approvedReview.verification?.license, {status: "unknown", sourceUrl: null});

  failAfterPublicationAudit = true;
  await assert.rejects(cli.run([...reviewArgs, "--publish"]), /Injected failure after real publication audit SQL/);
  assert.deepEqual(await counts(database), approvedCounts, "Publication, revision history, M08 audit, outbox and operation record must roll back together");
  const rolledBackResource = (await database.query<{working_document: Resource; public_document: Resource | null}>("SELECT working_document, public_document FROM resource_records WHERE id = $1", [resourceId])).rows[0]!;
  assert.equal(rolledBackResource.working_document.publicationStatus, "in_review");
  assert.equal(rolledBackResource.public_document, null);
  assert.deepEqual((await database.query<{document: ResourceCatalogCheckpoint}>("SELECT document FROM resource_catalog_imports WHERE candidate_key = $1", [candidate.candidateKey])).rows[0]!.document, approvedCheckpoint);
  assert.equal((await database.query<{payload: ResourceReview}>("SELECT payload FROM operations_resource_reviews WHERE id = $1", [approvedCheckpoint.reviewId])).rows[0]!.payload.status, "approved");

  const published = await cli.run([...reviewArgs, "--publish"]);
  assert.equal(published.items[0]?.stage, "published");
  assert.equal(published.items[0]?.resourceId, resourceId);
  const publishedCounts = await counts(database);
  assert.deepEqual(publishedCounts, {resources: 1, history: 4, checkpoints: 1, reviews: 1, audit: 3, operations: 1, notifications: 1});
  const publicResource = (await database.query<{public_document: Resource}>("SELECT public_document FROM resource_records WHERE id = $1", [resourceId])).rows[0]!.public_document;
  assert.equal(publicResource.publicationStatus, "published");
  assert.equal(publicResource.reviewId, approvedReview.id);
  assert.equal(publicResource.verifiedAt, NOW);
  const audits = (await database.query<{payload: ResourceReviewAudit}>("SELECT payload FROM operations_resource_review_audit ORDER BY id")).rows.map(row => row.payload);
  assert.deepEqual(audits.map(audit => audit.action), ["resource_registered", "resource_approved", "resource_published"]);
  assert.ok(audits.every(audit => audit.actorId === actor.userId && audit.resourceId === resourceId && audit.reviewId === approvedReview.id));

  const callsBeforeReplay = m08PublicationCalls;
  const replayed = await cli.run([...reviewArgs, "--publish"]);
  assert.equal(replayed.items[0]?.reused, true);
  assert.equal(replayed.items[0]?.stage, "published");
  assert.equal(m08PublicationCalls, callsBeforeReplay);
  assert.deepEqual(await counts(database), publishedCounts, "Replays do not append resources, reviews, history, publication events or audit");
  assert.ok(stageTransactions >= 8, "Import, approval and publication execute as distinct caller-owned stages");
  assert.ok(nestedCommitAttempts > 0, "Actual M09 and M08 services request transactions through the shared executor");
});
