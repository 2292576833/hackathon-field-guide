import assert from "node:assert/strict";
import test from "node:test";
import { adviseScopeCut } from "./advice.ts";
import { SCOPE_CUT_WINDOWS, SCOPE_CUT_UNKNOWN_NOTICE_PREFIX, type ScopeCutAdvice, type ScopeCutFacts } from "./model.ts";

const HOUR = 60 * 60 * 1_000;

/** 一份事实完整的基准输入。各用例只覆盖自己关心的字段。 */
function facts(overrides: Partial<ScopeCutFacts> = {}): ScopeCutFacts {
  return {
    goal: "做一个队友能一起用的活动报名页",
    minimumDeliverable: "一个能打开、能提交一次报名的页面",
    remainingMs: 8 * 24 * HOUR,
    stage: "开发",
    tasks: { total: 10, done: 4, blocked: 0, inProgress: 2 },
    ...overrides,
  };
}

function allText(advice: ScopeCutAdvice): string {
  return [advice.sayToTeam, advice.notice, ...advice.keep, ...advice.cut].join("\n");
}

// —— 契约与纯度 ——

test("输出契约字段齐全，keep/cut 均为非空字符串数组", () => {
  const advice = adviseScopeCut(facts());
  assert.deepEqual(Object.keys(advice).sort(), ["cut", "keep", "notice", "sayToTeam", "verdict"]);
  assert.ok(advice.keep.length > 0);
  assert.ok(advice.cut.length > 0);
  for (const line of [...advice.keep, ...advice.cut]) {
    assert.equal(typeof line, "string");
    assert.ok(line.trim().length > 0, `空建议：${JSON.stringify(line)}`);
  }
  assert.ok(advice.sayToTeam.trim().length > 0);
  assert.ok(advice.notice.trim().length > 0);
});

test("纯函数：同一输入两次调用结果相同，且不修改入参", () => {
  const input = facts();
  const snapshot = JSON.stringify(input);
  const first = adviseScopeCut(input);
  const second = adviseScopeCut(input);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(input), snapshot);
  assert.notEqual(first.keep, input.tasks as unknown as string[]);
});

test("无副作用：返回的数组可以被调用方修改而不影响下一次调用", () => {
  const first = adviseScopeCut(facts());
  (first.cut as string[]).push("被调用方污染的建议");
  const second = adviseScopeCut(facts());
  assert.ok(!second.cut.includes("被调用方污染的建议"));
});

// —— 硬约束 2：不产生完成百分比 / 第二套完成状态 ——

const FORBIDDEN_PATTERNS: readonly RegExp[] = [
  /\d+(\.\d+)?\s*%/,
  /百分之/,
  /完成度/,
  /完成率/,
  /进度条/,
  /还剩\s*\d+/,
  /已完成\s*\d+\s*%/,
  /\d+\s*\/\s*\d+\s*已完成/,
];

/** advice.ts 里那句**否定式声明**：它自带"完成度/完成百分比"字样，但是拒绝给结论，不是伪精确。 */
const declaredLimitsSentence =
  "本模块不推算完成度、不给完成百分比，也不替团队决定砍什么；上面的取舍是建议，最终由你们定。";

/**
 * 只豁免这一句，其余文本一律按禁止模式检查，避免豁免范围被悄悄放大。
 */
function assertNoPseudoPrecision(advice: ScopeCutAdvice): void {
  const text = allText(advice).split(declaredLimitsSentence).join("");
  for (const pattern of FORBIDDEN_PATTERNS) {
    assert.ok(!pattern.test(text), `输出出现伪精确表述 ${pattern}：${text}`);
  }
}

test("任何四态下都不出现百分比、完成度、完成率或「还剩 N」", () => {
  const cases: ScopeCutFacts[] = [
    facts({ remainingMs: 8 * 24 * HOUR }),
    facts({ remainingMs: 12 * HOUR }),
    facts({ remainingMs: 2 * HOUR }),
    facts({ remainingMs: 2 * HOUR, tasks: { total: 6, done: 6, blocked: 0, inProgress: 0 } }),
    facts({ remainingMs: 1 * HOUR, tasks: { total: 6, done: 1, blocked: 2, inProgress: 3 } }),
    facts({ remainingMs: Number.NaN }),
    facts({ tasks: undefined as unknown as ScopeCutFacts["tasks"] }),
  ];
  for (const input of cases) assertNoPseudoPrecision(adviseScopeCut(input));
});

test("豁免范围不放水：notice 必须恰好包含一次否定式声明，其余仍是禁止模式", () => {
  const advice = adviseScopeCut(facts({ remainingMs: 8 * 24 * HOUR }));
  assert.equal(advice.notice.split("不推算完成度").length - 1, 1);
  assert.equal(advice.notice.split("不给完成百分比").length - 1, 1);
  // 同一句去掉后仍能检查出真出现百分比的情况（防止将来豁免逻辑失效而测试静默通过）。
  assert.ok(FORBIDDEN_PATTERNS.some(pattern => pattern.test("你们已经完成了 80% 的活儿")));
  // 豁免只对完整的那一句生效：把违规内容拼在真实输出后面，检查必须失败。
  const polluted: ScopeCutAdvice = { ...advice, notice: `${advice.notice}\n我们完成了 80%。` };
  assert.throws(() => assertNoPseudoPrecision(polluted), /伪精确表述/);
  // 真实输出本身通过检查。
  assert.doesNotThrow(() => assertNoPseudoPrecision(advice));
  // 被截断或改写的片段仍然算禁止表述（豁免不覆盖片段）。
  assert.ok(FORBIDDEN_PATTERNS.some(pattern => pattern.test("本模块不推算完成度")));
});

test("只有传入的剩余时间被表述成时间预算，任务计数原样引用为事实", () => {
  const advice = adviseScopeCut(facts({ remainingMs: 5 * HOUR, tasks: { total: 7, done: 3, blocked: 1, inProgress: 2 } }));
  assert.match(advice.notice, /剩余时间约 5 小时/);
  assert.match(advice.notice, /总数 7、已完成 3、阻塞 1、进行中 2/);
  assert.ok(!/完成了 43/.test(advice.notice));
});

// —— 硬约束 1：事实不足 → unknown + 说明缺什么 ——

test("remainingMs 为 NaN → unknown，指出 remainingMs 缺失", () => {
  const advice = adviseScopeCut(facts({ remainingMs: Number.NaN }));
  assert.equal(advice.verdict, "unknown");
  assert.ok(advice.notice.startsWith(SCOPE_CUT_UNKNOWN_NOTICE_PREFIX));
  assert.match(advice.notice, /remainingMs/);
});

test("remainingMs 为负 → unknown，说明超时事实不足而不是报「已截止」", () => {
  const advice = adviseScopeCut(facts({ remainingMs: -1 }));
  assert.equal(advice.verdict, "unknown");
  assert.match(advice.notice, /remainingMs/);
  assert.match(advice.notice, /已经过去/);
});

test("remainingMs 为 Infinity → unknown", () => {
  const advice = adviseScopeCut(facts({ remainingMs: Number.POSITIVE_INFINITY }));
  assert.equal(advice.verdict, "unknown");
  assert.match(advice.notice, /remainingMs/);
});

test("tasks 整块缺失 → unknown，逐个字段说明缺什么", () => {
  const advice = adviseScopeCut(facts({ tasks: undefined as unknown as ScopeCutFacts["tasks"] }));
  assert.equal(advice.verdict, "unknown");
  for (const key of ["total", "done", "blocked", "inProgress"]) {
    assert.match(advice.notice, new RegExp(`tasks\\.${key}`));
  }
});

test("tasks 计数为负或非数字 → unknown", () => {
  const negative = adviseScopeCut(facts({ tasks: { total: 5, done: -1, blocked: 0, inProgress: 0 } }));
  assert.equal(negative.verdict, "unknown");
  assert.match(negative.notice, /tasks\.done/);

  const broken = adviseScopeCut(
    facts({ tasks: { total: 5, done: Number.NaN, blocked: 0, inProgress: 0 } }),
  );
  assert.equal(broken.verdict, "unknown");
  assert.match(broken.notice, /tasks\.done/);
});

test("计数自相矛盾（已完成+阻塞+进行中 > 总数）→ unknown，不猜哪项对", () => {
  const advice = adviseScopeCut(facts({ tasks: { total: 3, done: 2, blocked: 2, inProgress: 1 } }));
  assert.equal(advice.verdict, "unknown");
  assert.match(advice.notice, /大于总数/);
});

test("总数为 0 → unknown，不把「没有任务」说成做完了", () => {
  const advice = adviseScopeCut(facts({ tasks: { total: 0, done: 0, blocked: 0, inProgress: 0 } }));
  assert.equal(advice.verdict, "unknown");
  assert.match(advice.notice, /tasks\.total/);
});

test("minimumDeliverable 为空 → unknown，并提示先写最小成果", () => {
  const advice = adviseScopeCut(facts({ minimumDeliverable: "   " }));
  assert.equal(advice.verdict, "unknown");
  assert.match(advice.notice, /minimumDeliverable/);
  assert.ok(advice.cut.some(line => /冻结新增范围/.test(line)));
});

test("unknown 时不编造进度：notice 明确否认「没有进度」，也不给完成度结论", () => {
  const advice = adviseScopeCut(facts({ remainingMs: Number.NaN }));
  assert.match(advice.notice, /不会推断你现在的进度/);
  assert.ok(!/算下来|大概是|估计/.test(allText(advice)));
});

test("unknown 时仍然给出可执行动作，且 sayToTeam 不指责", () => {
  const advice = adviseScopeCut(facts({ remainingMs: -5 }));
  assert.equal(advice.verdict, "unknown");
  assert.ok(advice.keep.length >= 1 && advice.cut.length >= 1);
  assert.ok(!/你们怎么|为什么还没|又没|拖/.test(advice.sayToTeam));
});

// —— 硬约束 3：cut 是具体可执行的取舍 ——

test("must_cut 的 cut 每条都包含具体动作（降级/停手/推后/收敛之一）", () => {
  const advice = adviseScopeCut(facts({ remainingMs: 3 * HOUR, tasks: { total: 12, done: 5, blocked: 1, inProgress: 3 } }));
  assert.equal(advice.verdict, "must_cut");
  for (const line of advice.cut) {
    assert.ok(
      /降级|停手|推后|不做|先占位|收口|砍|停手|收敛|记进/.test(line),
      `cut 建议不够具体：${line}`,
    );
    assert.ok(line.length >= 20, `cut 建议太短，像空话：${line}`);
  }
  assert.ok(advice.cut.some(line => /实时协作降级为/.test(line)), "缺少把实时协作降级的具名例子");
});

test("at_risk 的 cut 给出降级形态与丢车保帅顺序", () => {
  const advice = adviseScopeCut(facts({ remainingMs: 14 * HOUR }));
  assert.equal(advice.verdict, "at_risk");
  assert.ok(advice.cut.some(line => /降级成「能演示即可」/.test(line)));
  assert.ok(advice.cut.some(line => /从队尾往回砍/.test(line)));
});

test("on_track 也给出防膨胀动作，不假装没有取舍", () => {
  const advice = adviseScopeCut(facts({ remainingMs: 5 * 24 * HOUR, tasks: { total: 12, done: 8, blocked: 0, inProgress: 2 } }));
  assert.equal(advice.verdict, "on_track");
  assert.ok(advice.cut.some(line => /提交后再做/.test(line)));
  assert.ok(advice.keep.some(line => /最小成果/.test(line)));
});

// —— 阻塞与在办 ——

test("存在阻塞时 keep 把处理阻塞放进第一位，并给两小时降级线", () => {
  const advice = adviseScopeCut(facts({ remainingMs: 20 * HOUR, tasks: { total: 9, done: 3, blocked: 2, inProgress: 2 } }));
  assert.match(advice.keep[0] ?? "", /阻塞/);
  assert.match(advice.keep[0] ?? "", /两小时/);
});

test("全部任务已结算（无阻塞、无在办）时不推销砍功能，只收尾交付", () => {
  const advice = adviseScopeCut(
    facts({ remainingMs: 3 * HOUR, stage: "提交", tasks: { total: 6, done: 6, blocked: 0, inProgress: 0 } }),
  );
  assert.equal(advice.verdict, "on_track");
  assert.match(advice.notice, /看不出必须现在砍的东西/);
  assert.ok(advice.cut.some(line => /提交后再做/.test(line)));
});

// —— 边界与阶段 ——

test("剩余时间边界：5.99 小时必须砍，6 小时正好为有风险，23.99 小时有风险，24 小时正好为正常", () => {
  // 用「无阻塞、无未开始任务」的计数，把判定隔离到时间闸门本身，避免被「未开始过多」规则抢先命中。
  const onlyTimeGate = { total: 10, done: 6, blocked: 0, inProgress: 4 };
  assert.equal(
    adviseScopeCut(facts({ remainingMs: SCOPE_CUT_WINDOWS.criticalMs - 1, tasks: onlyTimeGate })).verdict,
    "must_cut",
  );
  assert.equal(
    adviseScopeCut(facts({ remainingMs: SCOPE_CUT_WINDOWS.criticalMs, tasks: onlyTimeGate })).verdict,
    "at_risk",
  );
  assert.equal(
    adviseScopeCut(facts({ remainingMs: SCOPE_CUT_WINDOWS.riskMs - 1, tasks: onlyTimeGate })).verdict,
    "at_risk",
  );
  assert.equal(
    adviseScopeCut(facts({ remainingMs: SCOPE_CUT_WINDOWS.riskMs, tasks: onlyTimeGate })).verdict,
    "on_track",
  );
  // 全部结算后，时间闸门不再产生 must_cut：没有未结算工作就没有"砍"的对象。
  const allSettled = { total: 10, done: 10, blocked: 0, inProgress: 0 };
  assert.equal(adviseScopeCut(facts({ remainingMs: SCOPE_CUT_WINDOWS.criticalMs - 1, tasks: allSettled })).verdict, "on_track");
});

test("剩余时间为 0 且有未结算任务 → must_cut（时间是 0，不是负数）", () => {
  const advice = adviseScopeCut(facts({ remainingMs: 0, tasks: { total: 4, done: 1, blocked: 0, inProgress: 1 } }));
  assert.equal(advice.verdict, "must_cut");
  assert.match(advice.notice, /剩余时间已经是 0/);
});

test("时间还很充裕但大部分任务没开始 → at_risk，提示排一条顺序", () => {
  const advice = adviseScopeCut(facts({ remainingMs: 30 * HOUR, tasks: { total: 12, done: 2, blocked: 0, inProgress: 0 } }));
  assert.equal(advice.verdict, "at_risk");
  assert.match(advice.notice, /偏紧|收范围/);
});

test("存在阻塞且剩余不足 48 小时 → at_risk，即使任务大多已完成", () => {
  const advice = adviseScopeCut(facts({ remainingMs: 40 * HOUR, tasks: { total: 10, done: 9, blocked: 1, inProgress: 0 } }));
  assert.equal(advice.verdict, "at_risk");
});

test("阶段专项：提交阶段的 at_risk 收敛提交材料，路演阶段给三句话讲稿", () => {
  const submit = adviseScopeCut(facts({ remainingMs: 14 * HOUR, stage: "提交" }));
  assert.ok(submit.cut.some(line => /提交材料收敛成一份/.test(line)));

  const pitch = adviseScopeCut(facts({ remainingMs: 2 * HOUR, stage: "路演" }));
  assert.equal(pitch.verdict, "must_cut");
  assert.ok(pitch.keep.some(line => /三句话/.test(line)) || pitch.cut.some(line => /三句话/.test(line)));
});

test("未识别的阶段：照常给建议，但明说没有叠加阶段专项建议", () => {
  const advice = adviseScopeCut(facts({ remainingMs: 2 * HOUR, stage: "打怪升级" }));
  assert.equal(advice.verdict, "must_cut");
  assert.match(advice.notice, /阶段「打怪升级」未识别/);
});

test("stage 为空字符串：不报错、不编造阶段，notice 里说明未提供阶段", () => {
  const advice = adviseScopeCut(facts({ stage: "" }));
  assert.match(advice.notice, /未提供阶段/);
  assert.ok(!advice.sayToTeam.includes("我们还在「」"));
});

test("goal 为空但有最小成果时仍可给建议，用「当前目标」占位而不编造目标", () => {
  const advice = adviseScopeCut(facts({ goal: "  " }));
  assert.equal(advice.verdict, "on_track");
  assert.ok(!advice.notice.includes("目标「」"));
  assert.deepEqual(advice, adviseScopeCut(facts({ goal: "" })));
  // 需要引用目标做逐一对照的两种判断下，空目标退化成明确占位词，而不是空引号。
  assert.match(allText(adviseScopeCut(facts({ goal: "", remainingMs: 14 * HOUR }))), /当前目标/);
  assert.match(allText(adviseScopeCut(facts({ goal: "", remainingMs: 2 * HOUR }))), /当前目标/);
});

test("阶段文本大小写与英文别名都能识别（submit / DEMO）", () => {
  const submit = adviseScopeCut(facts({ remainingMs: 14 * HOUR, stage: "SUBMIT" }));
  assert.ok(submit.cut.some(line => /提交材料收敛成一份/.test(line)));
  const demo = adviseScopeCut(facts({ remainingMs: 2 * HOUR, stage: "DEMO" }));
  assert.ok(demo.cut.some(line => /三句话/.test(line)));
});

// —— 语气 ——

test("sayToTeam 是给队友的一句话，平和可执行且不提「你们要」式命令", () => {
  for (const remaining of [8 * 24 * HOUR, 14 * HOUR, 2 * HOUR]) {
    const advice = adviseScopeCut(facts({ remainingMs: remaining }));
    assert.ok(advice.sayToTeam.length <= 140, `对队友的一句话过长：${advice.sayToTeam}`);
    assert.ok(!/[！!]{1}/.test(advice.sayToTeam), `语气过重：${advice.sayToTeam}`);
    assert.ok(/我们/.test(advice.sayToTeam), `不像对队友说的话：${advice.sayToTeam}`);
    assert.ok(!/你们必须|赶紧|立刻马上/.test(advice.sayToTeam));
  }
});

test("notice 说明只依据传入事实、不给完成度、不替团队决定", () => {
  const advice = adviseScopeCut(facts({ remainingMs: 2 * HOUR }));
  assert.match(advice.notice, /依据你传入的事实/);
  assert.match(advice.notice, /不推算完成度/);
  assert.match(advice.notice, /最终由你们定/);
});
