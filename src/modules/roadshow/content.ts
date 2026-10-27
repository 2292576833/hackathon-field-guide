/** Original educational material. These fictional projects are not award-winning work or user evidence. */
export const ROADSHOW_EXAMPLES = [
  {
    id: "borrowing-board", title: "邻里借用板", category: "生活工具", label: "本站原创 · 虚构练习项目",
    idea: "让住在同一栋楼的人按时间借用不常用的小工具。",
    opening: "想挂一幅画，却不想为十分钟的使用买一台电钻。我们想让邻居能先看到可借的工具，再约好借还时间。",
    story: "先展示一位借用者如何查找工具，再展示物主如何确认时间。重点解释借还状态；信用与责任处理放在待验证项里。",
    demo: ["用明确标注的演示账号搜索工具", "选择借用时间，展示确认页面", "切到物主视角，解释确认和归还状态"],
    ending: "这个练习方案优先检验：邻居是否愿意出借、时间确认是否足够清楚。下一步先访谈，再决定是否开发信用功能。",
    question: "发生损坏时怎么办？", answer: "目前只是练习设想，尚未验证赔付机制。原型应先说明责任边界，不宣称已经解决信任问题。",
    lesson: "用一个完整的小场景串起讲稿，别把尚未完成的信用系统讲成已上线能力。",
  },
  {
    id: "meeting-card", title: "会后行动卡", category: "AI 辅助工具", label: "本站原创 · 虚构练习项目",
    idea: "把一段用户提供的会议笔记整理为可人工确认的行动卡。",
    opening: "会开完了，大家却对谁做什么理解不同。我们想把笔记里的行动整理出来，让参与者逐条确认。",
    story: "演示输入、草稿、人工修正三个画面。用标注为演示材料的笔记，展示不确定负责人如何保持待确认。",
    demo: ["粘贴一段不含私人信息的演示笔记", "展示行动卡和待确认字段", "手动修改负责人，再展示确认后的卡片"],
    ending: "我们希望减少会后反复确认，但还没有真实效果数据。下一步检验遗漏、误分配和用户修正所需时间。",
    question: "AI 写错任务怎么办？", answer: "行动卡保持草稿状态，由人确认后再使用。还需要评估错误和遗漏；这里没有已经通过的准确率测试。",
    lesson: "AI 能力要讲清输入、人工确认和失败处理，不用编造准确率证明价值。",
  },
] as const;

export const ROADSHOW_REMINDERS = [
  { title: "只讲一个主要问题", text: "先说谁在什么场景遇到困难，再说你做了什么。把不影响理解的背景、术语和功能留到问答。" },
  { title: "把完成与设想分开", text: "说清楚哪些功能已经做出来，哪些是演示数据、原型或计划。用户反馈、市场规模与测试结果需要真实依据。" },
  { title: "按规则计时彩排", text: "先确认演讲和问答是否分别计时。用自己的语速完整讲一遍，保留切屏和设备缓冲，超时就删内容。" },
  { title: "备份最短演示路径", text: "预先准备本地截图或自己录制的演示视频。切换备份时说清楚素材来源和录制时的版本，不宣称正在实时运行。" },
] as const;

export const DEMO_FALLBACKS = [
  { problem: "网络或模型请求超时", action: "停止重复点击，改用已准备的截图或录屏，说明这是备份材料；解释正常输入与预期输出。" },
  { problem: "账号登录或权限受阻", action: "使用提前验证过的演示账号；无法继续时展示已录制流程，不在台上输入私人密码或验证码。" },
  { problem: "功能报错或数据为空", action: "如实指出失败位置，说明现有处理与待修复项。用标为演示数据的材料讲流程，不假装现场成功。" },
  { problem: "时间只剩几十秒", action: "跳过次要功能，直接说明一个核心输出、当前限制和下一步验证。保留结尾，不抢占问答时间。" },
] as const;

export const JUDGE_QUESTIONS = [
  { question: "谁会使用？问题怎么确认？", answer: "先说明目标用户与使用场景。有访谈就讲样本和发现；没有就说这是待验证假设，并说明准备怎样验证。" },
  { question: "和现有办法相比，有什么差异？", answer: "比较具体流程或约束，不泛称行业领先。尚未调查替代产品时，明确这是初步差异判断。" },
  { question: "现在真正能用的部分是什么？", answer: "用已完成能力和现场可见输出回答，分别标明原型、演示数据、人工步骤与后续计划。" },
  { question: "技术为什么这样选？", answer: "解释一个关键取舍：时间、成本、效果或维护难度。说明限制，以及需要进一步检验的地方。" },
  { question: "AI、隐私或费用有风险吗？", answer: "按实际做法回答数据来源、授权、错误处理与费用。没有落实的保护措施列为待办，不承诺已经具备。" },
  { question: "如果继续做，下一步是什么？", answer: "给出一个小而可检验的行动，如访谈目标用户或验证核心流程；不承诺未经论证的商业收入。" },
] as const;

export interface RoadshowAllocation { label: string; seconds: number; tone: string }
/** An editable rehearsal guideline, not a rule for every event. Includes switching/recovery buffer. */
export function roadshowAllocation(totalSeconds: number): RoadshowAllocation[] {
  if (!Number.isInteger(totalSeconds) || totalSeconds < 60 || totalSeconds > 900) throw new RangeError("路演时长应为 60–900 秒。");
  const parts = [
    { label: "开场", ratio: .12, tone: "opening" }, { label: "问题", ratio: .16, tone: "problem" },
    { label: "方案", ratio: .20, tone: "solution" }, { label: "演示", ratio: .32, tone: "demo" },
    { label: "结尾", ratio: .10, tone: "closing" },
  ];
  const allocation = parts.map(part => ({ label: part.label, seconds: Math.floor(totalSeconds * part.ratio), tone: part.tone }));
  return [...allocation, { label: "切屏与缓冲", seconds: totalSeconds - allocation.reduce((sum, part) => sum + part.seconds, 0), tone: "buffer" }];
}

/** Read a small text-only idea. No URL navigation, HTML interpretation or private input persistence. */
export function readRoadshowIdea(search: string): string | null {
  const params = new URLSearchParams(search);
  if (params.getAll("idea").length !== 1) return null;
  const idea = params.get("idea")?.trim() ?? "";
  return idea.length > 0 && idea.length <= 1200 && !/[\u0000-\u001f\u007f]/.test(idea) ? idea : null;
}

/** Only the record reference goes into the URL; the PPT page must read it through owner-checked API. */
export function roadshowPptHref(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new TypeError("记录 ID 无效。");
  return `/ppt?roadshowId=${encodeURIComponent(id)}`;
}
