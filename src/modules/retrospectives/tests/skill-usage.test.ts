import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "../../../shared/errors.ts";
import { parseFixedSkillReference } from "../../skills/index.ts";
import type { FixedSkillReference } from "../../skills/index.ts";
import { parseSkillUsage } from "../skill-usage.ts";

function reference(overrides: Partial<FixedSkillReference> = {}): FixedSkillReference {
  return { kind: "skill", id: "prepare-demo", version: "1.0.0", versionId: "prepare-demo@1.0.0", contentHash: "a1".repeat(32), revision: 3, ...overrides };
}
function usage(ref: FixedSkillReference = reference()) {
  return { reference: ref, purpose: "整理演示视频与讲解提纲", feedback: "节省了整理时间，但仍需本人试讲", limitations: "本次使用条件不代表其他客户端兼容" };
}
function invalid(error: unknown): boolean { assert.ok(error instanceof DomainError); return true; }

test("absent skill history remains compatible and an explicitly empty list carries no new status", () => {
  assert.equal(parseSkillUsage(undefined), undefined);
  assert.equal(parseSkillUsage(undefined, { allowIncomplete: true }), undefined);
  assert.deepEqual(parseSkillUsage([]), []);
  for (const value of [null, "prepare-demo", {}, { skillUsage: [] }]) assert.throws(() => parseSkillUsage(value), invalid);
});

test("skill and bundle histories retain exact fixed references without requiring current catalog or installation records", () => {
  const records = [
    usage(reference({ version: "0.9.1-retired", versionId: "prepare-demo@0.9.1-retired", revision: 1 })),
    usage(reference({ kind: "bundle", id: "prior-event-starter", version: "2.1.0", versionId: "prior-event-starter@2.1.0", contentHash: "b2".repeat(32), revision: 5 })),
  ];
  const parsed = parseSkillUsage(records)!;
  assert.deepEqual(parsed, records);
  assert.deepEqual(parsed.map(item => Object.keys(item).sort()), Array(2).fill(["feedback", "limitations", "purpose", "reference"]));
  assert.deepEqual(parsed.map(item => item.reference), records.map(item => parseFixedSkillReference(item.reference)));
});

test("manual history accepts twelve distinct uses but rejects excessive or invented outcome fields", () => {
  const twelve = Array.from({ length: 12 }, (_, index) => usage(reference({ id: `recorded-skill-${index}`, versionId: `recorded-skill-${index}@1.0.0` })));
  assert.equal(parseSkillUsage(twelve)?.length, 12);
  assert.throws(() => parseSkillUsage([...twelve, usage(reference({ id: "thirteenth" }))]), invalid);
  for (const invented of [
    { installationStatus: "installed" }, { compatibilityStatus: "verified" }, { compatibilityEvidence: [] },
    { success: true }, { completed: true }, { submissionStatus: "verified" }, { ownerId: "another-account" },
  ]) assert.throws(() => parseSkillUsage([{ ...usage(), ...invented }]), invalid);
  assert.throws(() => parseSkillUsage([usage({ ...reference(), installed: true } as FixedSkillReference)]), invalid);
});

test("formal skill history trims human feedback and rejects blank, missing, oversized or control-character text", () => {
  const record = { ...usage(), purpose: "  整理演示  ", feedback: "\n已试讲，仍需压缩时间\n", limitations: "  只在本机验证  " };
  assert.deepEqual(parseSkillUsage([record])![0], { ...record, purpose: "整理演示", feedback: "已试讲，仍需压缩时间", limitations: "只在本机验证" });
  for (const field of ["purpose", "feedback", "limitations"] as const) {
    assert.equal(parseSkillUsage([{ ...usage(), [field]: "字".repeat(2000) }])![0][field].length, 2000);
    for (const text of ["", "  \n\t", "字".repeat(2001), "文本\u0000正文", undefined, 7]) {
      assert.throws(() => parseSkillUsage([{ ...usage(), [field]: text }]), invalid);
    }
  }
});

test("autosave allows incomplete answers and preserves whitespace while retaining size and field protections", () => {
  const record = { ...usage(), purpose: "", feedback: "  \n", limitations: "  待确认\n下一行  " };
  assert.deepEqual(parseSkillUsage([record], { allowIncomplete: true }), [record]);
  for (const field of ["purpose", "feedback", "limitations"] as const) {
    for (const value of [undefined, 4, "字".repeat(2001), "\u0000"]) assert.throws(() => parseSkillUsage([{ ...record, [field]: value }], { allowIncomplete: true }), invalid);
  }
  assert.throws(() => parseSkillUsage([{ ...record, success: true }], { allowIncomplete: true }), invalid);
  assert.throws(() => parseSkillUsage([{ ...record, reference: reference({ version: "latest" }) }], { allowIncomplete: true }), invalid);
});

test("parsing never mutates original feedback or shares the fixed reference object", () => {
  const records = [{ ...usage(), purpose: "  先留原文  ", feedback: "  再人工确认  " }], before = structuredClone(records);
  const parsed = parseSkillUsage(records)!;
  assert.deepEqual(records, before);
  assert.notEqual(parsed, records); assert.notEqual(parsed[0], records[0]); assert.notEqual(parsed[0].reference, records[0].reference);
  parsed[0].reference.id = "changed-only-in-result";
  assert.deepEqual(records, before);
  const draft = parseSkillUsage(records, { allowIncomplete: true })!;
  assert.equal(draft[0].purpose, before[0].purpose); assert.deepEqual(records, before);
});

test("retrospective reference validation stays aligned with the M10 public fixed-reference contract", () => {
  const samples: unknown[] = [
    reference(), reference({ kind: "bundle" }),
    reference({ id: "a".repeat(240), versionId: "b".repeat(240), version: "1.0.0-beta.1+build.7", revision: Number.MAX_SAFE_INTEGER }),
    reference({ id: "  prepare-demo  ", version: "  1.0.0  " }),
    reference({ version: "latest" }), reference({ version: " latest " }), reference({ id: "latest" }),
    reference({ id: "a".repeat(241) }), reference({ versionId: "C:\\Users\\alice\\skill" }), reference({ id: "/home/alice/private" }),
    reference({ id: "sk-abcdefghijk12345" }), reference({ id: "ghp_abcdefghijk12345" }), reference({ id: "github_pat_abcdefghijk12345" }),
    reference({ contentHash: "A".repeat(64) }), reference({ contentHash: "a".repeat(63) }),
    reference({ revision: 0 }), reference({ revision: 1.5 }), reference({ revision: Number.MAX_SAFE_INTEGER + 1 }),
    { ...reference(), compatibility: "verified" }, { ...reference(), kind: "installation" },
  ];
  for (const sample of samples) {
    let canonical: FixedSkillReference | undefined, canonicalRejected = false;
    try { canonical = parseFixedSkillReference(sample); } catch (error) { invalid(error); canonicalRejected = true; }
    const entry = { ...usage(), reference: sample };
    if (canonicalRejected) assert.throws(() => parseSkillUsage([entry]), invalid);
    else assert.deepEqual(parseSkillUsage([entry])![0].reference, canonical);
  }
});
