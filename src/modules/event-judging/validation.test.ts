import assert from "node:assert/strict";
import test from "node:test";
import type { IntakeReceipt, JudgeAssignment, JudgingRound, ManualScore } from "./model.ts";
import { aggregate, config, csvCell, hash, materials, scoreValues } from "./validation.ts";

const criteria = [{ id: "product", label: "作品", weight: 60, min: 20, max: 100 }, { id: "demo", label: "展示", weight: 40, min: 0, max: 10 }];
const round: JudgingRound = { id: "round", eventId: "A", organizationId: "org", revision: 1, status: "open", snapshotIds: ["first", "second", "missing"],
  config: { title: "决赛", criteria, minJudges: 2, missingPolicy: "exclude_incomplete", tiePolicy: "shared_rank" }, createdAt: "2026-10-11T00:00:00Z", startedAt: null, lockedAt: null, lockedSummary: null, publishedResultId: null };
const receipts = round.snapshotIds.map(id => ({ id, teamId: id, materials: { title: id } } as IntakeReceipt));
const assignment = (id: string, snapshotId: string, status: JudgeAssignment["status"] = "active"): JudgeAssignment => ({ id, snapshotId, roundId: round.id, status, declaration: "clear" } as JudgeAssignment);
const score = (assignmentId: string, product: number, demo: number, state: ManualScore["state"] = "submitted"): ManualScore => ({ assignmentId, values: { product, demo }, state } as unknown as ManualScore);

test("weighted normalized scores average real judges; missing, draft and recused scores are not zero or counted", () => {
  const assignments = [assignment("a", "first"), assignment("b", "first"), assignment("c", "second"), assignment("d", "second"), assignment("e", "missing"), assignment("f", "missing", "recused"), assignment("g", "missing")];
  const scores = [score("a", 100, 0), score("b", 20, 10), score("c", 60, 5), score("d", 60, 5), score("e", 100, 10), score("f", 100, 10), score("g", 100, 10, "draft")];
  const summary = aggregate(round, receipts, assignments, scores);
  assert.equal(summary.complete, false); assert.equal(summary.hasTies, true);
  assert.deepEqual(summary.rows.map(row => [row.teamId, row.total, row.rank, row.missingJudges]), [["first", 50, 1, 0], ["second", 50, 1, 0], ["missing", null, null, 1]]);
  assert.equal(summary.rows[2]?.submittedJudgeCount, 1);
});
test("range, weight, minimum judge and prototype keys are rejected before freezing standards", () => {
  assert.equal(config(round.config).criteria.length, 2);
  for (const value of [{ ...round.config, criteria: [{ ...criteria[0]!, weight: 99 }] }, { ...round.config, minJudges: 0 }, { ...round.config, criteria: [{ ...criteria[0]!, min: 100, max: 100, weight: 100 }] }, { ...round.config, criteria: [{ ...criteria[0]!, id: "__proto__", weight: 100 }] }]) assert.throws(() => config(value));
  assert.throws(() => scoreValues({ product: 101, demo: 10 }, round));
  assert.throws(() => scoreValues({ product: 50, demo: 3.5 }, round));
  assert.throws(() => scoreValues({ product: 50, other: 3 }, round));
  const inherited = Object.assign(Object.create({ demo: 5 }), { product: 50, extra: 1 });
  assert.throws(() => scoreValues(inherited, round));
});
test("submission material snapshot bounds text and accepts only HTTPS metadata without executing or downloading", () => {
  const value = { title: "作品", description: "说明", links: [{ label: "演示", url: "https://example.org/demo" }], files: [] };
  assert.equal(materials(value).links[0]?.url, "https://example.org/demo");
  for (const url of ["javascript:alert(1)", "file:///C:/secret", "https://name:password@example.org/demo", "http://example.org"]) assert.throws(() => materials({ ...value, links: [{ label: "演示", url }] }));
  assert.throws(() => materials({ ...value, description: "字".repeat(12001) }));
  assert.throws(() => materials({ ...value, files: [{ name: "file", url: "https://example.org/file", sizeBytes: 0, sha256: "invalid", mediaType: "text/plain" }] }));
});
test("CSV text cannot run formulas, including leading spaces or controls, and quotes remain escaped", () => {
  for (const value of ["=1+1", " +cmd", "\t@SUM(1)", "\r\n-1"]) assert.ok(csvCell(value).startsWith('"\''));
  assert.equal(csvCell('正常"文字'), '"正常""文字"'); assert.equal(csvCell("plain"), '"plain"');
});
test("fingerprints survive JSONB object key reordering while retaining material array order", () => {
  assert.equal(hash({ b: { y: 2, x: 1 }, a: [1, 2] }), hash({ a: [1, 2], b: { x: 1, y: 2 } }));
  assert.notEqual(hash({ a: [1, 2] }), hash({ a: [2, 1] }));
});
