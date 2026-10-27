import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "../../shared/errors.ts";
import { manager, member, setup } from "../planning/testing/fixtures.ts";
import { buildHandoffProgress, emptyHandoffDraft, HANDOFF_FIELDS, HANDOFF_LIMITS, handoffSuggestions, hasHandoffInput, readHandoffProgress, type HandoffDraft } from "./handoff.ts";

const handoff: HandoffDraft = { location: "共享资料/路演.pptx", version: "第3版", openMethod: "用 PowerPoint 打开\n播放第2–5页", checkMethod: "按任务条件核对图文和链接" };

test("四项交接写入原说明及成果依据，非代码文件也适用", () => {
  const saved = buildHandoffProgress({ handoff, note: "请关注第4页的图", evidenceRefs: ["截图/第4页.png"] });
  assert.deepEqual(saved.evidenceRefs, [handoff.location, "截图/第4页.png"]);
  assert.deepEqual(readHandoffProgress(saved.note), { kind: "structured", handoff, note: "请关注第4页的图" });
  for (const label of HANDOFF_FIELDS.map(field => field.label)) assert.ok(saved.note.includes(label));
  assert.ok(!("status" in saved) && !("completed" in saved));
});

test("新交接需要四项，部分输入不能通过旧记录兼容被忽略", () => {
  for (const field of HANDOFF_FIELDS) assert.throws(() => buildHandoffProgress({ handoff: { ...handoff, [field.key]: "  " }, note: "", evidenceRefs: [] }), new RegExp(field.label));
  assert.equal(hasHandoffInput(emptyHandoffDraft()), false);
  assert.equal(hasHandoffInput({ ...emptyHandoffDraft(), version: " " }), true);
  assert.throws(() => buildHandoffProgress({ handoff: { ...emptyHandoffDraft(), version: "第2版" }, note: "旧交接", evidenceRefs: [], allowLegacy: true }), /成果在哪里/);
});

test("旧说明和依据逐字保留，但新交接不能只靠旧式自由说明", () => {
  const note = "旧交接\n请到共享文件夹打开演示稿，空格  保留";
  const saved = buildHandoffProgress({ handoff: emptyHandoffDraft(), note, evidenceRefs: ["legacy:file"], allowLegacy: true });
  assert.deepEqual(saved, { note, evidenceRefs: ["legacy:file"] });
  assert.deepEqual(readHandoffProgress(note), { kind: "legacy", handoff: emptyHandoffDraft(), note });
  assert.throws(() => buildHandoffProgress({ handoff: emptyHandoffDraft(), note, evidenceRefs: [] }), /成果在哪里/);
  assert.throws(() => buildHandoffProgress({ handoff: emptyHandoffDraft(), note: "", evidenceRefs: [], allowLegacy: true }), /成果说明/);
});

test("多行、Unicode、空行及类似标题的用户文字不会串到另一项", () => {
  const draft = { ...handoff, openMethod: "第一步\n哪个版本：\n  这里也是说明\n\n最后一步 😀", checkMethod: "检查\n补充说明：\n  内容" };
  const saved = buildHandoffProgress({ handoff: draft, note: "成果在哪里：\n这是补充文字\n", evidenceRefs: [] });
  const parsed = readHandoffProgress(saved.note);
  assert.equal(parsed.kind, "structured"); assert.deepEqual(parsed.handoff, draft); assert.equal(parsed.note, "成果在哪里：\n这是补充文字\n");
  assert.deepEqual(readHandoffProgress(saved.note.replace(/\n/g, "\r\n")), parsed);
});

test("不完整、乱序或不认识的格式保留全文作为旧记录", () => {
  const saved = buildHandoffProgress({ handoff, note: "", evidenceRefs: [] }).note;
  for (const note of ["成果交接\n旧记录", saved.replace("哪个版本：", "其他字段："), saved + "\n外部附加文字", saved.replace("  第3版", "第3版")]) {
    const parsed = readHandoffProgress(note); assert.equal(parsed.kind, "legacy"); assert.equal(parsed.note, note);
  }
});

test("生成后的说明恰好4000字可保存，多一字不能截断", () => {
  const overhead = buildHandoffProgress({ handoff, note: "", evidenceRefs: [] }).note.length;
  const note = "中".repeat(HANDOFF_LIMITS.note - overhead);
  assert.equal(buildHandoffProgress({ handoff, note, evidenceRefs: [] }).note.length, 4000);
  assert.throws(() => buildHandoffProgress({ handoff, note: note + "中", evidenceRefs: [] }), /4000/);
  assert.throws(() => buildHandoffProgress({ handoff, note: "\n".repeat(1400), evidenceRefs: [] }), /4000/);
});

test("依据最多50条，成果位置已存在时不重复添加，旧依据不被删改", () => {
  const extras = Array.from({ length: 49 }, (_, index) => `文件-${index}`);
  assert.equal(buildHandoffProgress({ handoff, note: "", evidenceRefs: extras }).evidenceRefs.length, 50);
  const refs = [handoff.location, ...extras];
  assert.deepEqual(buildHandoffProgress({ handoff, note: "", evidenceRefs: refs }).evidenceRefs, refs);
  assert.throws(() => buildHandoffProgress({ handoff, note: "", evidenceRefs: [...extras, "文件-50"] }), /50/);
});

test("位置与依据按服务实际UTF16长度限制，不裁切长地址或emoji", () => {
  const location = "中".repeat(2000);
  assert.equal(buildHandoffProgress({ handoff: { ...handoff, location }, note: "", evidenceRefs: [] }).evidenceRefs[0], location);
  for (const value of [location + "中", "😀".repeat(1001)]) assert.throws(() => buildHandoffProgress({ handoff: { ...handoff, location: value }, note: "", evidenceRefs: [] }), /2000/);
  assert.throws(() => buildHandoffProgress({ handoff, note: "", evidenceRefs: ["中".repeat(2001)] }), /2000/);
});

test("兼容路径仍校验说明、引用数量和空引用，不绕开服务约束", () => {
  for (const input of [{ note: "x".repeat(4001), evidenceRefs: [] }, { note: "旧交接", evidenceRefs: [" "] }, { note: "旧交接", evidenceRefs: Array.from({ length: 51 }, () => "依据") }]) {
    assert.throws(() => buildHandoffProgress({ handoff: emptyHandoffDraft(), allowLegacy: true, ...input }));
  }
});

test("生成与读取不改变输入或已有依据数组", () => {
  const input = { handoff: structuredClone(handoff), note: "备注", evidenceRefs: ["old:1", "old:1"] }, before = structuredClone(input);
  readHandoffProgress(buildHandoffProgress(input).note); assert.deepEqual(input, before);
});

test("实际PlanningService隔离夹具保存四项；重复同次请求不追加，过期版本冲突", async () => {
  const context = setup(), plan = await context.service.createDraft(manager, "p1", context.draft());
  await context.service.apply(manager, "p1", plan.id, { expectedRevision: 0, acknowledgedIssueCodes: plan.validation?.issues.map(issue => issue.code) ?? [], idempotencyKey: "apply-handoff" });
  const overhead = buildHandoffProgress({ handoff, note: "", evidenceRefs: [] }).note.length;
  const saved = buildHandoffProgress({ handoff, note: "中".repeat(4000 - overhead), evidenceRefs: [] });
  const command = { expectedRevision: 0, status: "review" as const, remainingEstimate: null, blocker: null, ...saved, idempotencyKey: "handoff-once" };
  const update = await context.service.updateProgress(member, "p1", "t1", command);
  assert.deepEqual(readHandoffProgress(update.note).handoff, handoff); assert.deepEqual(update.evidenceRefs, saved.evidenceRefs);
  assert.equal(update.note.length, 4000);
  assert.equal(update.acceptance, null); assert.equal(context.repository.state!.tasks.find(task => task.id === "t1")!.status, "review");
  assert.deepEqual(await context.service.updateProgress(member, "p1", "t1", command), update);
  assert.equal(context.repository.state!.progressUpdates.length, 1);
  await assert.rejects(context.service.updateProgress(member, "p1", "t1", { ...command, idempotencyKey: "stale-new-request" }), error => error instanceof DomainError && error.code === "VERSION_CONFLICT");
  await assert.rejects(context.service.updateProgress(member, "p1", "t1", { ...command, expectedRevision: 1, status: "done", idempotencyKey: "owner-cannot-accept" }), error => error instanceof DomainError && error.code === "FORBIDDEN");
  await assert.rejects(context.service.updateProgress(member, "p1", "t1", { ...command, expectedRevision: 1, note: saved.note + "中", idempotencyKey: "too-long" }), error => error instanceof DomainError && error.code === "INVALID_INPUT");
  assert.equal(context.repository.state!.progressUpdates.length, 1);
});

test("交接候选只从既有事实派生，并注明来源（不替成员编造交接内容）", () => {
  const both = handoffSuggestions({ title: "准备路演", deliverable: "共享资料里的 路演.pptx", acceptanceCriteria: ["能播放", "图文一致"] });
  assert.deepEqual(both.map(item => item.key), ["location", "checkMethod"]);
  assert.equal(both[0]!.value, "共享资料里的 路演.pptx");
  assert.equal(both[1]!.value, "能播放；图文一致", "检查条件直接来自任务，用分号连接");
  for (const item of both) assert.ok(item.source.trim().length > 0, "每个候选都必须注明来源");
});

test("交接候选：没有依据的字段不产生候选，宁缺勿造", () => {
  const noDeliverable = handoffSuggestions({ title: "T", deliverable: "   ", acceptanceCriteria: ["能播放"] });
  assert.deepEqual(noDeliverable.map(item => item.key), ["checkMethod"], "交付物为空时不产生位置候选");
  const nothing = handoffSuggestions({ title: "T", acceptanceCriteria: [] });
  assert.deepEqual(nothing, [], "完全没有依据时不给任何候选");
  const blankCriteria = handoffSuggestions({ title: "T", deliverable: "成品链接", acceptanceCriteria: ["  ", ""] });
  assert.deepEqual(blankCriteria.map(item => item.key), ["location"], "空白检查条件不算依据");
});

test("交接候选只覆盖位置与检查方法，不猜测版本与打开方式", () => {
  const items = handoffSuggestions({ title: "T", deliverable: "成品链接", acceptanceCriteria: ["能运行"] });
  assert.ok(items.every(item => item.key === "location" || item.key === "checkMethod"));
  assert.ok(!items.some(item => item.key === "version"), "版本必须由本人填写：系统不知道他保存了哪一版");
  assert.ok(!items.some(item => item.key === "openMethod"), "打开方式因人而异，不猜");
});
