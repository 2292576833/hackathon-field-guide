import assert from "node:assert/strict";
import test from "node:test";
import { RESOURCE_CATALOG, RESOURCE_CATALOG_CHECKED_AT, RESOURCE_CATALOG_VERIFICATION_DATE, RESOURCE_CATALOG_VERSION } from "./catalog.ts";
import { normalizeResourceInput, RESOURCE_STAGES, RESOURCE_TYPES, resourceUrl } from "./domain.ts";
import { createResourceCatalogCheckpointPort } from "./catalog-postgres.ts";
import type { ResourceCatalogCheckpoint } from "./catalog-types.ts";
import type { SqlExecutor } from "../../shared/persistence.ts";
import { DomainError } from "../../shared/errors.ts";

test("真实候选覆盖四种类型和全部参赛阶段，固定批次日期且不自动发布", () => {
  assert.equal(RESOURCE_CATALOG.length, 13);
  assert.equal(new Set(RESOURCE_CATALOG.map(entry => entry.candidateKey)).size, RESOURCE_CATALOG.length);
  assert.deepEqual([...new Set(RESOURCE_CATALOG.map(entry => entry.input.type))].sort(), [...RESOURCE_TYPES].sort());
  assert.deepEqual([...new Set(RESOURCE_CATALOG.flatMap(entry => entry.input.stageTags))].sort(), [...RESOURCE_STAGES].sort());
  for (const entry of RESOURCE_CATALOG) {
    assert.equal(entry.catalogVersion, RESOURCE_CATALOG_VERSION);
    assert.equal(entry.verificationDate, RESOURCE_CATALOG_VERIFICATION_DATE);
    assert.equal(entry.reviewStatus, "candidate");
    assert.equal(entry.input.linkStatus, "unknown");
    assert.equal(entry.input.verifiedAt, null);
    assert.ok(entry.remainingChecks.length);
    normalizeResourceInput(entry.input, new Date("2026-10-09T00:00:00Z"));
  }
});
test("已确认费用与许可各有对应官方来源，未知不带已核验时刻", () => {
  for (const entry of RESOURCE_CATALOG) {
    const input = entry.input;
    if (input.costType !== "unknown") {
      assert.equal(input.costVerifiedAt, RESOURCE_CATALOG_CHECKED_AT);
      assert.ok(entry.evidence.some(item => item.field === "cost" && item.url === input.costSourceUrl));
    } else assert.equal(input.costVerifiedAt, null);
    if (input.licenseStatus !== "unknown") {
      assert.equal(input.licenseVerifiedAt, RESOURCE_CATALOG_CHECKED_AT);
      assert.ok(entry.evidence.some(item => item.field === "license" && item.url === input.licenseSourceUrl));
    } else assert.equal(input.licenseVerifiedAt, null);
    for (const source of entry.evidence) {
      resourceUrl(source.url);
      assert.equal(source.checkedAt, RESOURCE_CATALOG_CHECKED_AT);
      assert.ok(source.note);
    }
  }
  assert.equal(RESOURCE_CATALOG.find(entry => entry.candidateKey === "awwwards")?.input.costType, "unknown");
  assert.equal(RESOURCE_CATALOG.find(entry => entry.candidateKey === "v0")?.input.licenseStatus, "unknown");
});
test("导入 checkpoint 使用调用方事务、缺失键锁和参数化 CAS", async () => {
  const statements: {sql: string; parameters: readonly unknown[]}[] = [];
  const transaction: SqlExecutor = {async query<Row>(sql: string, parameters: readonly unknown[] = []) {
    statements.push({sql, parameters});
    return {rows: [] as Row[], rowCount: sql.startsWith("UPDATE") ? 1 : 0};
  }};
  const port = createResourceCatalogCheckpointPort(transaction);
  assert.equal(await port.lock("seed'; DROP TABLE resource_records;--"), null);
  assert.ok(statements[0].sql.includes("pg_advisory_xact_lock"));
  assert.ok(statements[1].sql.endsWith("FOR UPDATE"));
  assert.equal(statements[1].sql.includes("DROP TABLE"), false);
  const checkpoint: ResourceCatalogCheckpoint = {candidateKey: "lucide", catalogVersion: RESOURCE_CATALOG_VERSION, contentHash: "hash", resourceId: "r-1", resourceRevision: 1,
    reviewId: null, reviewRevision: null, stage: "imported", importedBy: "reviewer", importedAt: RESOURCE_CATALOG_CHECKED_AT, updatedAt: RESOURCE_CATALOG_CHECKED_AT, revision: 1};
  await port.insert(checkpoint);
  await port.save({...checkpoint, revision: 2}, 1);
  assert.equal(statements[2].parameters[3], JSON.stringify(checkpoint));
  assert.equal(statements[3].parameters[3], 1);
  const conflicting = createResourceCatalogCheckpointPort({async query<Row>() { return {rows: [] as Row[], rowCount: 0}; }});
  await assert.rejects(conflicting.save({...checkpoint, revision: 2}, 1), (error: unknown) => error instanceof DomainError && error.code === "CATALOG_CHECKPOINT_CONFLICT");
});
