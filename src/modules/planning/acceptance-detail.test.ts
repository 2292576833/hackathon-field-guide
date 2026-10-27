import test from "node:test";
import assert from "node:assert/strict";
import {
  ACCEPTANCE_DETAIL_MAX_CRITERIA,
  ACCEPTANCE_DETAIL_MAX_PROPOSALS,
  ACCEPTANCE_DETAIL_MAX_TEXT_LENGTH,
  ACCEPTANCE_DETAIL_MIN_VOID_REASON_LENGTH,
  detailAcceptance,
  type AcceptanceDetailInput,
  type AcceptanceDetailProposal,
  type AcceptanceDetailReasonCode,
} from "./acceptance-detail.ts";

const ME = "user-owner";
const OTHER = "user-manager";
const T1 = "2026-10-12T03:00:00.000Z";
const T2 = "2026-10-12T04:30:00.000Z";
const VOID_REASON = "负责人细化后这条过于笼统，改用下面三条具体条件";

function call(overrides: Partial<AcceptanceDetailInput> = {}) {
  return detailAcceptance({ existing: [], proposed: [], actorUserId: ME, actorMayRefine: true, ...overrides });
}
function add(text: string, overrides: Partial<AcceptanceDetailProposal> = {}): AcceptanceDetailProposal {
  return { text, byUserId: ME, at: T1, ...overrides };
}
function codes(result: { rejected: readonly { reasonCode: AcceptanceDetailReasonCode }[] }): AcceptanceDetailReasonCode[] {
  return result.rejected.map(entry => entry.reasonCode);
}
/** 只给已有条件，一个细化都不提交。 */
function withExisting(existing: readonly string[]) {
  return call({ existing });
}

test("空输入原样返回：不改条件、没有任何变更、也不产生完成状态", () => {
  const existing = ["页面能打开", "提交一份 README"];
  const result = withExisting(existing);

  assert.deepEqual(result.criteria, existing);
  assert.deepEqual(result.added, []);
  assert.deepEqual(result.voided, []);
  assert.deepEqual(result.rejected, []);
  assert.deepEqual(result.trace, []);
  assert.match(result.summary, /保持原样/);
  assert.equal(result.criteria.length, 2);
});

test("完全没有条件时也不报错，只报告空条件", () => {
  const result = detailAcceptance({ existing: [], proposed: [], actorUserId: ME, actorMayRefine: true });
  assert.deepEqual(result.criteria, []);
  assert.equal(result.summary, "未提交细化，检查条件保持原样（共 0 条）。");
});

test("追加细化保留原文与顺序，并可追溯谁在何时加了什么", () => {
  const existing = ["页面能打开"];
  const result = call({
    existing,
    proposed: [
      add("首页在 1366×768 下不出现横向滚动条"),
      add("断网时显示“请检查网络”，不白屏", { at: T2 }),
    ],
  });

  assert.deepEqual(result.criteria, [
    "页面能打开",
    "首页在 1366×768 下不出现横向滚动条",
    "断网时显示“请检查网络”，不白屏",
  ]);
  assert.deepEqual(result.added, [
    { text: "首页在 1366×768 下不出现横向滚动条", byUserId: ME, at: T1 },
    { text: "断网时显示“请检查网络”，不白屏", byUserId: ME, at: T2 },
  ]);
  assert.deepEqual(result.voided, []);
  assert.deepEqual(result.rejected, []);
  assert.deepEqual(result.trace, [
    { action: "added", text: "首页在 1366×768 下不出现横向滚动条", byUserId: ME, at: T1, applied: true },
    { action: "added", text: "断网时显示“请检查网络”，不白屏", byUserId: ME, at: T2, applied: true },
  ]);
  assert.match(result.summary, /新增 2 条/);
  // 已有条目是副本，不会被原地改写。
  assert.notEqual(result.criteria, existing);
  assert.deepEqual(existing, ["页面能打开"]);
});

test("重复条目被识别并拒绝，包括多余空白与全角空格差异", () => {
  const existing = ["完成核心演示"];
  const result = call({
    existing,
    proposed: [
      add("完成核心演示"),
      add("  完成核心演示  "),
      add("完成核心演示\u3000"),
      add("完成核心演示", { byUserId: OTHER, at: T2 }),
    ],
  });

  assert.deepEqual(result.criteria, existing);
  assert.deepEqual(result.added, []);
  assert.equal(result.rejected.length, 4);
  assert.deepEqual(codes(result), Array(4).fill("DUPLICATE_CRITERION"));
  for (const entry of result.rejected) assert.match(entry.reason, /已经存在/);
  // 拒绝也要留痕，不能静默丢弃。
  assert.equal(result.trace.length, 4);
  assert.equal(result.trace.every(entry => entry.applied === false), true);
});

test("同一批里重复的新条件只接受第一条，第二条拒绝", () => {
  const result = call({
    proposed: [add("能导出 CSV"), add("能导出 CSV", { at: T2 })],
  });

  assert.deepEqual(result.criteria, ["能导出 CSV"]);
  assert.deepEqual(result.added, [{ text: "能导出 CSV", byUserId: ME, at: T1 }]);
  assert.deepEqual(codes(result), ["DUPLICATE_CRITERION"]);
});

test("空字符串、纯空白与缺字段被拒绝且说明理由", () => {
  const result = call({
    existing: ["原有条件"],
    proposed: [
      add(""),
      add("   \n\t  "),
      { byUserId: ME, at: T1 } as unknown as AcceptanceDetailProposal,
      add("合法的新条件", { at: T2 }),
    ],
  });

  assert.deepEqual(result.criteria, ["原有条件", "合法的新条件"]);
  assert.deepEqual(codes(result), ["TEXT_MISSING", "TEXT_MISSING", "TEXT_MISSING"]);
  assert.deepEqual(result.added, [{ text: "合法的新条件", byUserId: ME, at: T2 }]);
});

test("超长条件按自定上限拒绝，恰好等于上限则接受", () => {
  const atLimit = "好".repeat(ACCEPTANCE_DETAIL_MAX_TEXT_LENGTH);
  const overLimit = `${atLimit}好`;
  const result = call({ proposed: [add(atLimit), add(overLimit, { at: T2 })] });

  assert.deepEqual(result.criteria, [atLimit]);
  assert.deepEqual(codes(result), ["TEXT_TOO_LONG"]);
  assert.match(result.rejected[0]!.reason, new RegExp(String(ACCEPTANCE_DETAIL_MAX_TEXT_LENGTH)));
});

test("控制字符与零宽字符被拒绝，制表符、换行与行分隔符按空白折叠", () => {
  const result = call({
    proposed: [
      add("第一行\u0000第二行"),
      add("前半\u0007后半"),
      add("零宽\u200b分隔"),
      add("顺\u200f序标记"),
      add("制表\t符", { at: T2 }),
      add(`两行\u2028分开`, { at: T2 }),
    ],
  });

  assert.deepEqual(codes(result), [
    "TEXT_CONTROL_CHARACTER",
    "TEXT_CONTROL_CHARACTER",
    "TEXT_CONTROL_CHARACTER",
    "TEXT_CONTROL_CHARACTER",
  ]);
  assert.match(result.rejected[0]!.reason, /控制字符/);
  // 制表符与行分隔符属于可见空白：折叠成空格后内容仍可读，按折叠后的文字记录。
  assert.deepEqual(result.criteria, ["制表 符", "两行 分开"]);
});

test("每条细化必须能追溯作者与时刻：缺失、空白与非法时间都要拒绝", () => {
  const result = call({
    proposed: [
      add("没有作者", { byUserId: "" }),
      add("作者只有空格", { byUserId: "  " }),
      add("没有时刻", { at: "" }),
      add("日期不是带时区的时间", { at: "2026-10-12" }),
      add("时刻格式不对", { at: "2026/10/12 03:00" }),
      add("月份越界", { at: "2026-13-12T03:00:00Z" }),
      add("没有时区", { at: "2026-10-12T03:00:00" }),
      add("带偏移的合法时间", { at: "2026-10-12T11:00:00+08:00" }),
    ],
  });

  assert.deepEqual(codes(result), [
    "AUTHOR_MISSING",
    "AUTHOR_MISSING",
    "TIME_MISSING",
    "TIME_INVALID",
    "TIME_INVALID",
    "TIME_INVALID",
    "TIME_INVALID",
  ]);
  assert.deepEqual(result.criteria, ["带偏移的合法时间"]);
  assert.deepEqual(result.added, [{ text: "带偏移的合法时间", byUserId: ME, at: "2026-10-12T11:00:00+08:00" }]);
});

test("非当前操作人的提交会被拒绝并说明未核对权限，不会静默丢弃", () => {
  const result = call({
    proposed: [add("别人写的条件", { byUserId: OTHER })],
  });

  assert.deepEqual(result.criteria, []);
  assert.deepEqual(codes(result), ["PERMISSION_NOT_CONFIRMED"]);
  assert.equal(result.rejected[0]!.text, "别人写的条件");
  assert.match(result.rejected[0]!.reason, /权限/);
});

test("调用方没有明确核对细化权限（未传或传 false）时，宁可拒绝也不记无据作者", () => {
  const missing = detailAcceptance({ existing: [], proposed: [add("条件")], actorUserId: ME });
  const denied = call({ proposed: [add("条件")], actorMayRefine: false });

  for (const result of [missing, denied]) {
    assert.deepEqual(result.criteria, []);
    assert.deepEqual(codes(result), ["PERMISSION_NOT_CONFIRMED"]);
    assert.equal(result.added.length, 0);
    assert.equal(result.voided.length, 0);
  }
});

test("作废不删除原文：保留原文、理由、作者与时刻，且不改变条件顺序", () => {
  const existing = ["页面能打开", "完成核心演示", "写一页说明"];
  const result = call({
    existing,
    proposed: [{ text: "完成核心演示", byUserId: ME, at: T2, void: true, voidReason: VOID_REASON }],
  });

  assert.deepEqual(result.criteria, existing);
  assert.deepEqual(result.voided, [{ text: "完成核心演示", reason: VOID_REASON, byUserId: ME, at: T2 }]);
  assert.deepEqual(result.rejected, []);
  assert.deepEqual(result.trace, [
    { action: "voided", text: "完成核心演示", byUserId: ME, at: T2, applied: true, reason: VOID_REASON },
  ]);
  assert.match(result.summary, /标注作废 1 条/);
});

test("作废要拦住：缺理由、理由太短、找不到原文、重复作废", () => {
  const existing = ["完成核心演示", "写一页说明"];
  const short = "太短";
  const result = call({
    existing,
    proposed: [
      { text: "完成核心演示", byUserId: ME, at: T1, void: true, voidReason: VOID_REASON },
      { text: "写一页说明", byUserId: ME, at: T1, void: true, voidReason: short },
      { text: "根本不存在的条件", byUserId: ME, at: T1, void: true, voidReason: VOID_REASON },
      { text: "完成核心演示", byUserId: ME, at: T1, void: true, voidReason: "太短" },
      { text: "完成核心演示", byUserId: ME, at: T2, void: true, voidReason: "负责人第二次提交作废，理由同样足够长" },
    ],
  });

  assert.deepEqual(codes(result), [
    "VOID_REASON_MISSING",
    "VOID_TARGET_NOT_FOUND",
    "VOID_TARGET_ALREADY_VOIDED",
    "VOID_TARGET_ALREADY_VOIDED",
  ]);

  assert.deepEqual(result.voided, [{ text: "完成核心演示", reason: VOID_REASON, byUserId: ME, at: T1 }]);
  assert.deepEqual(result.criteria, existing);
  assert.equal(result.rejected[0]!.reason.includes(String(ACCEPTANCE_DETAIL_MIN_VOID_REASON_LENGTH)), true);
});

test("作废同样要核对权限；未核对时条件与作废记录都不动", () => {
  const existing = ["完成核心演示"];
  const result = detailAcceptance({
    existing,
    proposed: [{ text: "完成核心演示", byUserId: OTHER, at: T1, void: true, voidReason: VOID_REASON }],
    actorUserId: ME,
  });

  assert.deepEqual(result.criteria, existing);
  assert.deepEqual(result.voided, []);
  assert.deepEqual(codes(result), ["PERMISSION_NOT_CONFIRMED"]);
});

test("非法操作与非法字段一律拒绝，不改条件", () => {
  const invalid: unknown[] = [
    { text: "条件", byUserId: ME, at: T1, void: "true" },
    { text: "条件", byUserId: ME, at: T1, action: "void" },
    { text: "条件", byUserId: ME, at: T1, extra: 1 },
    { text: "条件", byUserId: ME, at: T1, void: false },
  ];
  const accepted = call({ proposed: invalid as AcceptanceDetailProposal[] });
  assert.deepEqual(accepted.criteria, ["条件"]);
  assert.deepEqual(codes(accepted), ["INVALID_OPERATION", "INVALID_OPERATION", "INVALID_OPERATION"]);

  const withExisting = call({ existing: ["原有条件"], proposed: invalid as AcceptanceDetailProposal[] });
  // 第四次是合法的 void:false（等价于普通追加），只按重复算一条，其余三次是非法字段/非法操作。
  assert.deepEqual(withExisting.criteria, ["原有条件", "条件"]);
  assert.equal(withExisting.rejected.length, 3);
  assert.deepEqual(codes(withExisting), ["INVALID_OPERATION", "INVALID_OPERATION", "INVALID_OPERATION"]);
});

test("细化提交整体不是列表时不抛异常，也不改动任何条件", () => {
  for (const proposed of [undefined, null, "条件", { text: "条件" }, 42]) {
    const result = call({ existing: ["原有条件"], proposed: proposed as unknown as AcceptanceDetailProposal[] });
    assert.deepEqual(result.criteria, ["原有条件"]);
    assert.deepEqual(codes(result), ["INPUT_NOT_ARRAY"]);
    assert.match(result.summary, /拒绝 1 条/);
  }
});

test("列表里混入不是对象的条目时逐条拒绝，其余正常生效", () => {
  const result = call({
    proposed: [null, "文字", 7, add("真正要加的条件", { at: T2 })] as unknown as AcceptanceDetailProposal[],
  });

  assert.deepEqual(result.criteria, ["真正要加的条件"]);
  assert.deepEqual(codes(result), ["NOT_OBJECT", "NOT_OBJECT", "NOT_OBJECT"]);
  assert.equal(result.trace.length, 4);
});

test("一次提交过多时整批拒绝并说明，不静默丢掉后面的条目", () => {
  const tooMany = Array.from(
    { length: ACCEPTANCE_DETAIL_MAX_PROPOSALS + 1 },
    (_, index) => add(`条件 ${index}`),
  );
  const result = call({ existing: ["原有条件"], proposed: tooMany });

  assert.deepEqual(result.criteria, ["原有条件"]);
  assert.deepEqual(codes(result), ["PROPOSALS_LIMIT_REACHED"]);
  assert.match(result.rejected[0]!.reason, new RegExp(String(ACCEPTANCE_DETAIL_MAX_PROPOSALS)));
});

test("达到条件条数上限后拒绝继续追加，已有条件一条都不动", () => {
  const existing = Array.from({ length: ACCEPTANCE_DETAIL_MAX_CRITERIA }, (_, index) => `已有条件 ${index}`);
  const result = call({ existing, proposed: [add("再追加一条")] });

  assert.deepEqual(result.criteria, existing);
  assert.deepEqual(codes(result), ["CRITERIA_LIMIT_REACHED"]);
});

test("永远不改写已有条目：空白不折叠、重复原文不提纯、非法旧条目也原样保留", () => {
  const existing = ["  两边有空格  ", "重复条件", "重复条件", "", "超长".repeat(400)];
  const result = call({ existing, proposed: [add("新条件")] });

  assert.deepEqual(result.criteria, [...existing, "新条件"]);
  assert.equal(result.criteria[0], "  两边有空格  ");
  assert.equal(result.criteria[3], "");
  assert.deepEqual(result.rejected, []);
});

test("纯函数：传入的数组与对象不被修改，也不读取当前时间", () => {
  const existing = Object.freeze(["页面能打开", "完成核心演示"]);
  const proposal = Object.freeze({ text: "页面在手机上单列显示", byUserId: ME, at: T1 });
  const voidProposal = Object.freeze({ text: "完成核心演示", byUserId: ME, at: T2, void: true, voidReason: VOID_REASON });
  const proposed = Object.freeze([proposal, voidProposal]);

  const originalNow = Date.now;
  let nowCalls = 0;
  Date.now = () => {
    nowCalls += 1;
    return 0;
  };
  let result;
  try {
    result = detailAcceptance({
      existing,
      proposed: proposed as unknown as AcceptanceDetailProposal[],
      actorUserId: ME,
      actorMayRefine: true,
    });
  } finally {
    Date.now = originalNow;
  }

  // 冻结输入在严格模式下会拒绝任何写入，因此“没抛错”本身就说明没有原地改写。
  assert.deepEqual([...existing], ["页面能打开", "完成核心演示"]);
  assert.deepEqual(result.criteria, ["页面能打开", "完成核心演示", "页面在手机上单列显示"]);
  assert.equal(nowCalls, 0);
  assert.notEqual(result.criteria, existing);
  assert.notEqual(result.added[0], proposal);
});

test("变更摘要始终非空，只说事实，不出现完成率或完成状态", () => {
  const added = call({ existing: ["A"], proposed: [add("B")] });
  const refused = call({ existing: ["A"], proposed: [add("")] });
  const voided = call({ existing: ["A"], proposed: [{ text: "A", byUserId: ME, at: T1, void: true, voidReason: VOID_REASON }] });

  for (const result of [added, refused, voided]) {
    assert.equal(typeof result.summary, "string");
    assert.equal(result.summary.length > 0, true);
    assert.doesNotMatch(result.summary, /%|百分比|完成率|进度/);
  }
  assert.match(refused.summary, /拒绝 1 条/);
  assert.match(voided.summary, /共 1 条/);
});
