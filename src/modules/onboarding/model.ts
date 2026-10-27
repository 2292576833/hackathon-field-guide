export const FIRST_LOGIN_GUIDE_VERSION = "first-login-v1";
export const FIRST_LOGIN_GUIDE_STEP_COUNT = 6;

export interface OnboardingState {
  readonly version: string;
  readonly stepIndex: number;
  readonly completedAt: string | null;
  readonly revision: number;
}

export interface SaveOnboardingInput {
  readonly expectedRevision: number;
  readonly stepIndex: number;
  readonly completed?: boolean;
}

export const firstLoginSteps = [
  {
    title: "找到适合你的入口",
    description: "第一次参赛看指引；正在参赛继续自己的比赛；主办方进入办赛工作台。先认识入口，再继续刚才的操作。",
    actions: [
      { label: "开始或继续参赛", detail: "新人从参赛指引了解先后；选手从我的参赛继续比赛与团队任务。遇到问题时再问DSH导航员，看这份指引不会调用收费模型。" },
      { label: "主办方入驻", detail: "从顶部入驻入口申请权限，审核后进入自己的办赛工作台。同一账号可以承担不同身份，无需重新注册。" },
    ],
    reminder: "这是一份网站使用指引；看完不会自动创建团队、报名或生成任务。",
  },
  {
    title: "先找比赛，再核对报名要求",
    description: "打开“找比赛”查看机会，再进入对应比赛的报名页。",
    actions: [
      { label: "查看赛事卡片", detail: "先选有兴趣的比赛，留意报名状态、费用、参加方式和比赛日期。" },
      { label: "确认在哪里报名", detail: "本站正式赛事可在本网站报名并查看审核；全网线索需打开主办方原文，按其报名方式操作。" },
    ],
    reminder: "报名情况可能未知或已经截止；保存比赛线索不等于完成报名。",
  },
  {
    title: "准备自己，再找合适的资料",
    description: "在“我的参赛”开始准备；需要队友时，再打开找队友入口。",
    actions: [
      { label: "个人准备与参赛名片", detail: "填写经验、想承担的职责、参赛目的和可投入时间。名片需要预览确认才会公开；年龄和 MBTI 可不填。" },
      { label: "教程、灵感与 AI 技能", detail: "不会 GitHub 就看教程；需要页面参考就找灵感；技能包先核对来源、许可和适用工具。" },
    ],
    reminder: "个人资料和准备材料不会自动发给队友，分享需要你明确选择。",
  },
  {
    title: "进入团队空间，邀请队友一起做",
    description: "一场参赛项目对应一个团队空间；独自参赛也可以使用，不必先凑齐队伍。",
    actions: [
      { label: "邀请队友", detail: "空间管理员生成邀请链接，选择可加入人数，再复制给队友。队友登录后确认加入。" },
      { label: "选择职责", detail: "先说自己愿意做什么、什么时候有空。不清楚时请 AI 根据官方赛道提出分工建议，再由团队确认。" },
    ],
    reminder: "本站比赛中的正式队伍是参赛名单；团队空间用于私下协作，两者需要明确关联。",
  },
  {
    title: "看清任务，边做边交接",
    description: "空间工作台按“我的下一步、团队任务、团队动态”组织。先看当前能做什么，再更新任务与交接。",
    actions: [
      { label: "我的空间 AI 助手", detail: "每个人在每个空间有自己的私人助手，继承本人导航记忆，结合当前任务指引下一步。确认分享的摘录才进入团队动态。" },
      { label: "提交成果与检查", detail: "做好后提交成果供队友检查。队友能看到进度和前置成果，再继续自己的工作。" },
    ],
    reminder: "AI 给出的是计划草案，确认后才生效；所需工具、教程和模板在对应任务附近查找。",
  },
  {
    title: "完成作品提交，把经验留下来",
    description: "最后检查可运行的 Demo、代码、PPT、演示视频和主办方要求的材料。",
    actions: [
      { label: "演示与正式提交", detail: "准备讲稿和 PPT；本站赛事在本场“提交作品”页确认收件，外部比赛按主办方方式提交并记录凭据。" },
      { label: "赛后复盘", detail: "记录有效分工、踩过的坑和成果，下次选择需要的经验复用。" },
    ],
    reminder: "代码保存到 GitHub、运行检查通过、比赛正式提交是三件不同的事；网站不会把其中一项自动当作全部完成。",
  },
] as const;
