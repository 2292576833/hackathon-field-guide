import type { JourneyGuide, JourneyHref } from "./model.ts";

const JOURNEY_HREFS: readonly JourneyHref[] = [
  "/events", "/competitions", "/app", "/participation", "/app/account", "/resources",
  "/inspiration", "/skills", "/github", "/roadshow", "/ppt", "/library",
  "/library/start-here", "/library/hackathon-introduction",
  "/library/github-first-repository", "/library/github-team-workflow",
  "/library/delivery-checklist", "/library/skill-pack-guide",
];

/** Exact existing destinations; no project placeholders, API routes or external URLs. */
export function isJourneyHref(href: string): href is JourneyHref {
  return JOURNEY_HREFS.some(allowed => allowed === href);
}

/** Validate authored content without reading accounts, project facts or services. */
export function validateJourneyGuide(guide: JourneyGuide): readonly string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  const keys = (value: object, allowed: readonly string[], path: string) => {
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) errors.push(`${path}.${key}: unexpected field`);
    }
  };
  const text = (value: string, path: string) => {
    if (typeof value !== "string" || !value.trim()) errors.push(`${path}: text is required`);
  };
  const id = (value: string, path: string) => {
    if (!/^[a-z][a-z0-9-]*$/.test(value)) errors.push(`${path}: invalid id`);
    if (ids.has(value)) errors.push(`${path}: duplicate id ${value}`);
    ids.add(value);
  };
  const href = (value: string, path: string) => {
    if (!isJourneyHref(value)) errors.push(`${path}: unsupported destination`);
  };
  keys(guide, ["root", "phases"], "guide");
  keys(guide.root, ["id", "title", "description", "actions"], "root");
  id(guide.root.id, "root.id");
  text(guide.root.title, "root.title");
  text(guide.root.description, "root.description");
  if (guide.root.actions.length === 0) errors.push("root.actions: an entry action is required");
  guide.root.actions.forEach((action, index) => {
    const path = `root.actions[${index}]`;
    keys(action, ["label", "href"], path);
    text(action.label, `${path}.label`);
    href(action.href, `${path}.href`);
  });
  if (guide.phases.map(phase => phase.id).join(",") !== "before,during,after") {
    errors.push("phases: expected before, during and after in preparation order");
  }
  guide.phases.forEach((phase, phaseIndex) => {
    const path = `phases[${phaseIndex}]`;
    keys(phase, ["id", "title", "description", "cautions", "nodes"], path);
    id(phase.id, `${path}.id`);
    text(phase.title, `${path}.title`);
    text(phase.description, `${path}.description`);
    if (phase.cautions.length === 0) errors.push(`${path}.cautions: phase cautions are required`);
    phase.cautions.forEach((caution, index) => text(caution, `${path}.cautions[${index}]`));
    if (phase.nodes.length === 0) errors.push(`${path}.nodes: actions are required`);
    phase.nodes.forEach((node, nodeIndex) => {
      const nodePath = `${path}.nodes[${nodeIndex}]`;
      keys(node, ["id", "title", "description", "actionLabel", "href", "parallel", "resources"], nodePath);
      id(node.id, `${nodePath}.id`);
      text(node.title, `${nodePath}.title`);
      text(node.description, `${nodePath}.description`);
      text(node.actionLabel, `${nodePath}.actionLabel`);
      href(node.href, `${nodePath}.href`);
      if (node.parallel !== null) text(node.parallel, `${nodePath}.parallel`);
      if (node.resources.length === 0) errors.push(`${nodePath}.resources: contextual aids are required`);
      node.resources.forEach((resource, index) => {
        const resourcePath = `${nodePath}.resources[${index}]`;
        keys(resource, ["title", "description", "href"], resourcePath);
        text(resource.title, `${resourcePath}.title`);
        text(resource.description, `${resourcePath}.description`);
        href(resource.href, `${resourcePath}.href`);
      });
    });
  });
  return errors;
}

const GUIDE: JourneyGuide = {
  root: {
    id: "journey-root",
    title: "从找比赛到留下经验",
    description: "本站原创指南，主办方要求优先，点击不代表完成。沿树枝找到行动与资料；实际依赖、进度和交付在团队空间确认。",
    actions: [
      { label: "先找比赛", href: "/events" },
      { label: "打开我的团队空间", href: "/app" },
    ],
  },
  phases: [
    {
      id: "before",
      title: "赛前：选比赛，定目标，做好准备",
      description: "从适合的比赛开始，把规则、最小作品、人员和可用时间说清楚，再安排能交付的任务。",
      cautions: [
        "DSH 自动发现卡片是未核验线索。资格、人数、费用、报名状态、官方赛道、评分重点和 AI 使用规则，都要回到主办方原文核对。",
        "分别记下报名截止、开赛时间和作品提交截止，保留时区；作品提交截止不能代替报名截止。赛前已有代码、素材和预做作品是否可用，也按比赛规则确认。",
        "单人也能创建团队空间。个人准备、出行和画像仅本人可见；邀请队友不会自动共享这些资料，选择共享前先检查内容。天气只在实际预报范围内参考，临近出行再次核对交通与天气。",
        "工具、技能和 AI 建议按需要使用。把学习、配置、排错、休息和提交缓冲算进时间，容量不足先缩小作品范围。",
      ],
      nodes: [
        {
          id: "find-event",
          title: "找比赛，核对规则与报名",
          description: "挑一场比赛，核对资格、费用、时间与必交材料。本站正式比赛可直接报名并查看审核结果；DSH发现的比赛先打开来源，按主办方入口报名。保存分析或创建空间都不等于已报名。",
          actionLabel: "去找比赛并查看原文",
          href: "/events",
          parallel: null,
          resources: [
            { title: "比赛分析与来源", description: "选比赛时，用已保存的 DSH 分析梳理条件与未知项；从卡片打开真实来源或报名候选继续核对。", href: "/events" },
            { title: "本站正式比赛与报名", description: "主办方在本站发布的比赛，可在报名页提交资料，并在我的参赛查看审核、入选通知和本场要求。", href: "/competitions" },
            { title: "黑客松入门", description: "第一次参赛时，先读本站原创说明，了解组队、限时协作与规则核对要点。", href: "/library/hackathon-introduction" },
          ],
        },
        {
          id: "define-demo",
          title: "定一个最小能演示的作品",
          description: "写清一个使用者、一个问题和一条核心流程，把必需功能与可选功能分开。先创建或打开一个团队空间，保存经团队确认的目标与比赛资料。",
          actionLabel: "创建或打开团队空间",
          href: "/app",
          parallel: null,
          resources: [
            { title: "团队空间与项目资料", description: "有明确作品方向时，进入“我的参赛”选择或创建空间，让同一比赛的目标、资料和后续任务放在一起。", href: "/app" },
            { title: "第一次使用说明", description: "还不清楚入口怎么用时，读本站原创步骤，理解个人准备和团队协作分别在哪里进行。", href: "/library/start-here" },
          ],
        },
        {
          id: "prepare-personal",
          title: "安排个人备赛与出行",
          description: "补充自己的经验、城市和可投入时间，选择比赛后安排练习与出行。核对交通、住宿、现场设备和费用；个人计划是待核对草案，分享给队友前由本人选择内容。",
          actionLabel: "打开个人参赛准备",
          href: "/participation",
          parallel: "可与团队目标讨论并行：先准备本人时间和出行资料，等比赛地点、形式与日期明确后再定行程。",
          resources: [
            { title: "个人参赛计划", description: "先从比赛卡片选择赛事并进入此页，再查看本人保存的准备、出行建议与实际可用天气资料；生成草案需登录并明确发起。", href: "/participation" },
            { title: "本人资料与经验", description: "准备个人计划前，登录补充首次参赛情况、开发经验、城市与时间，让建议有可核对的本人依据。", href: "/app/account" },
          ],
        },
        {
          id: "prepare-environment",
          title: "试通开发环境与版本保存",
          description: "用一个小练习确认项目能启动、核心工具能用，并练习保存与恢复版本。准备网络或设备故障时的替代演示；练习内容能否带入比赛，先核对规则。",
          actionLabel: "学习 GitHub 与版本保存",
          href: "/github",
          parallel: "可提前并行：练习环境与保存流程，不代表已经完成正式参赛作品。",
          resources: [
            { title: "GitHub 第一次保存", description: "还没用过仓库时，读本站原创教程，练习分支、一次版本保存及查看差异。", href: "/library/github-first-repository" },
            { title: "开发工具与资料", description: "准备环境时，按当前任务筛选经运营审核的工具与资料，再核对账号、费用、前置条件和使用许可。", href: "/resources" },
          ],
        },
        {
          id: "invite-and-assign",
          title: "邀请队友，填时间，选择职责",
          description: "先创建或打开一个团队空间，在成员页按所需人数创建邀请链接或本地二维码。每人填写可用时间并自选一项或多项职责；不确定时可请 AI 帮助，由管理员确认正式分工。",
          actionLabel: "进入空间安排成员与分工",
          href: "/app",
          parallel: "可与资料整理并行：有人核对规则，有人补时间和职责意愿；AI 建议不自动成为正式安排。",
          resources: [
            { title: "成员、邀请与分工", description: "组队时，先在“我的参赛”打开目标空间，再到成员与分工页邀请队友、填写时间、自选职责或使用可选 AI 帮助。", href: "/app" },
            { title: "官方赛道与要求", description: "分工前，从比赛来源核对实际官方赛道与评分重点；工具分类或技能套餐不能替代比赛赛道。", href: "/events" },
          ],
        },
        {
          id: "plan-dependencies",
          title: "排任务、交接条件与提交缓冲",
          description: "先创建或打开一个团队空间，在任务与时间页确认负责人、成果、验收条件、预计用时、起止时间和前置交接。按实际条件安排并行，把集成、测试、展示与提交留出缓冲。",
          actionLabel: "进入空间确认任务与时间",
          href: "/app",
          parallel: "准备顺序不是强制依赖：UI 草图、资料整理和讲稿大纲可提前做，等待前置成果时先做不受阻的任务。",
          resources: [
            { title: "任务与时间", description: "目标和成员时间明确后，在所选空间确认计划草案；等待时查看在等谁、等什么和当前可开始的任务。", href: "/app" },
            { title: "AI 技能与任务套餐", description: "已有具体任务且有时间试用时，查用途、版本、许可和兼容证据；复制命令、安装、客户端加载与试做分别验证，安装不等于完成作品。", href: "/skills" },
            { title: "技能包使用说明", description: "决定使用技能前，读本站原创说明，检查前置条件与安装范围，并为配置、客户端加载和示例验证留时间。", href: "/library/skill-pack-guide" },
          ],
        },
      ],
    },
    {
      id: "during",
      title: "赛中：做出作品，检查协作，展示提交",
      description: "先做通核心流程，再持续集成和检查；展示材料围绕实际成果制作，按主办方要求完成正式提交。",
      cautions: [
        "任务依赖看真实交接条件，团队成员报告完成后还需检查成果。当前进度在所选团队空间更新，路线图不替代任务记录。",
        "UI 草图、素材准备、PPT 与讲稿大纲可以提前并行；演示视频成片需有可演示流程。只准备比赛实际要求的材料。",
        "设计参考不等于获得图片、品牌或代码许可。灵感页未完成的 DSH 说明保留等待状态，使用素材前另行核对来源、许可与署名。",
        "代码保存、实际运行检查和向主办方正式提交分开记录。为链接权限、网络故障、上传与最终回执核对留出时间，别等最后一分钟。",
      ],
      nodes: [
        {
          id: "build-core-demo",
          title: "做通一个核心 Demo",
          description: "先完成能从头演示的最小流程，给每次交接附成果与启动方法。先创建或打开一个团队空间，在任务页更新实际进度；时间不够时先删减可选功能。",
          actionLabel: "进入空间推进核心任务",
          href: "/app",
          parallel: "按真实接口交接并行：队友可以先准备测试样例或说明，缺少前置成果时不要假设依赖已解除。",
          resources: [
            { title: "团队任务与进度", description: "开始实现或交接时，在所选空间查看负责人、前置成果与最新状态，报告完成后等待相应检查。", href: "/app" },
            { title: "开发工具与资料", description: "遇到具体开发问题时，用经运营审核的资源补足当前任务；临近截止优先选熟悉且能验证的做法。", href: "/resources" },
            { title: "GitHub 团队协作", description: "多人改代码时，读本站原创教程，约定文件分工、小步保存并在合并后检查受影响流程。", href: "/library/github-team-workflow" },
          ],
        },
        {
          id: "design-ui-assets",
          title: "准备 UI、素材与视觉参考",
          description: "围绕核心流程先画草图，再整理配色、界面文案与需要的素材。选组件前确认技术栈和许可，最终界面接入真实功能后再检查，不把漂亮截图当作可运行作品。",
          actionLabel: "按当前界面任务找灵感",
          href: "/inspiration",
          parallel: "可提前并行：UI 草图、配色和素材整理不必等 Demo 完成；最终交互检查需要接入可运行功能。",
          resources: [
            { title: "设计灵感官网", description: "画草图或调整视觉时，查看真实官网与已完成的 DSH 说明，分析未经人工核验；未分析条目只有身份、链接和等待状态。", href: "/inspiration" },
            { title: "组件与设计资源", description: "需要实现界面时，筛选经运营审核的组件和资料，复核适用技术栈、素材许可及必要署名。", href: "/resources" },
          ],
        },
        {
          id: "integrate-and-test",
          title: "集成、测试，记录实际运行结果",
          description: "把各部分接成核心流程，按启动说明从头跑一次，检查登录、网络、空数据和主要失败路径。先创建或打开一个团队空间，在代码与提交页记录版本、运行环境、检查结果和未解决问题。",
          actionLabel: "进入空间检查作品运行",
          href: "/app",
          parallel: "可提前准备检查清单和测试样例；实际运行检查需要对应的可运行版本。",
          resources: [
            { title: "代码与提交中的运行检查", description: "已有可运行版本后，在所选空间记录实际验证与依据；版本保存成功不能替代运行通过。", href: "/app" },
            { title: "交付检查清单", description: "集成与提交前，读本站原创清单，用新窗口或另一台设备复现流程，核对链接和备用演示。", href: "/library/delivery-checklist" },
          ],
        },
        {
          id: "prepare-pitch",
          title: "写讲稿、做 PPT，练习路演",
          description: "用问题、使用者、实际成果和演示流程组织讲稿与 PPT，按比赛时长练习。登录后可主动选择经确认的项目资料作为输入，生成内容仍需本人核对，不自动共享给团队。",
          actionLabel: "准备讲稿与路演练习",
          href: "/roadshow",
          parallel: "可提前并行：讲稿与 PPT 大纲先搭框架，最终截图、效果和成果说明等可展示内容准备好后再补齐。",
          resources: [
            { title: "路演与讲稿", description: "要解释作品价值时，查看案例、准备大纲或本人讲稿，再按实际演示时长练习并删去无法证明的表述。", href: "/roadshow" },
            { title: "PPT 大纲与制作工具", description: "确定表达顺序后，选模板、整理大纲和制作工具，把可核对的成果放进展示页；保存材料需登录并主动确认。", href: "/ppt" },
          ],
        },
        {
          id: "record-demo-video",
          title: "按要求准备演示视频",
          description: "先核对比赛是否要求视频以及时长、格式和上传方式。可以提前写脚本、试录设备；成片需基于可演示成果录制，检查声音、画面和链接权限，并保留故障时的备用演示。",
          actionLabel: "查看录制与演示工具",
          href: "/resources",
          parallel: "可提前准备脚本和试录；最终视频依赖可演示流程，不能用脚本或静态画面冒充运行结果。",
          resources: [
            { title: "演示与录制工具", description: "确认需要视频后，在经运营审核的资源中找录制与剪辑辅助，先核对设备、费用与导出条件再试用。", href: "/resources" },
            { title: "必交材料检查", description: "导出视频前，用本站原创交付清单复核官方必交项、演示方式和可打开的链接。", href: "/library/delivery-checklist" },
          ],
        },
        {
          id: "save-and-submit",
          title: "保存代码，向主办方正式提交",
          description: "先创建或打开一个团队空间，在代码与提交页核对仓库、分支和差异并保存版本，再确认作品实际运行。按主办方原文进入正式提交入口，核对格式、访问权限与最终截止，保留回执或注明本人自报依据。",
          actionLabel: "进入空间核对保存与提交记录",
          href: "/app",
          parallel: null,
          resources: [
            { title: "GitHub 保存操作说明", description: "保存代码前，学习账号授权、仓库选择和差异预览；GitHub 保存或合并成功不等于已提交比赛。", href: "/github" },
            { title: "代码、运行与正式提交记录", description: "在所选空间分别留下版本保存、运行检查和主办方提交凭证；没有回执时说明来源和待确认项。", href: "/app" },
            { title: "最后的提交检查", description: "正式提交前，用本站原创清单核对必交材料、链接权限和平台回执；主办方入口从比赛真实来源查找。", href: "/library/delivery-checklist" },
          ],
        },
      ],
    },
    {
      id: "after",
      title: "赛后：复盘，保留成果，用于下一次",
      description: "把这次的协作、技术和时间经验整理成可核对记录，保留成果，再挑选适合下次参赛的部分。",
      cautions: [
        "复盘区分实际发生的事与个人感受，核对交付记录后再确认经验。复盘不生成另一份运行成功或提交成功状态。",
        "归档前保留仓库、演示链接、提交凭证和需要的共享资料；私人讲稿、计划与收藏只在本人主动选择后共享。",
        "经验、模板与资源选择性复用。下一场比赛的资格、官方赛道、截止、工具费用、许可和授权都要重新核对，旧计划不会自动适用。",
      ],
      nodes: [
        {
          id: "review-experience",
          title: "复盘合作、技术与时间问题",
          description: "先创建或打开本次团队空间，在复盘页对照实际任务和交付记录，写清做对了什么、卡在哪里、下次怎么改。由有权限的成员确认可复用经验卡，保留具体依据。",
          actionLabel: "进入本次空间写复盘",
          href: "/app",
          parallel: null,
          resources: [
            { title: "空间复盘与经验卡", description: "比赛结束后，打开本次空间的复盘页，结合任务、运行与提交记录整理经验，再确认哪些经验值得复用。", href: "/app" },
            { title: "交付记录核对说明", description: "回看交付时，用本站原创清单区分保存、运行和正式提交，避免把印象写成成功事实。", href: "/library/delivery-checklist" },
          ],
        },
        {
          id: "preserve-results",
          title: "保存成果，按需归档空间",
          description: "先打开本次团队空间，整理仓库版本、演示说明、提交凭证与共享资料，检查链接能否继续访问。由管理员按需要归档空间，保留历史；私人材料只在本人明确选择后共享。",
          actionLabel: "打开空间整理成果与历史",
          href: "/app",
          parallel: "可与复盘并行整理资料，归档前先确认所需成果和凭证已保留。",
          resources: [
            { title: "团队空间历史与共享资料", description: "要收尾时，选择本次空间整理资料并查看历史，确认保留内容后由管理员按需归档。", href: "/app" },
            { title: "仓库与版本说明", description: "整理成果时，检查仓库版本、可见范围和启动说明，让队友或后续使用者能找到可复现成果。", href: "/github" },
          ],
        },
        {
          id: "reuse-next-time",
          title: "挑选经验和资源，准备下一次",
          description: "从本次空间选择已确认的经验，按下一场比赛重新判断适用性。先创建或打开新的团队空间，再明确采用需要的资料；保留有效个人收藏，不照搬旧分工、截止和授权。",
          actionLabel: "选择下一次参赛空间",
          href: "/app",
          parallel: null,
          resources: [
            { title: "经验卡与下一次空间", description: "准备新比赛时，从原空间复查已确认经验，在新空间主动选择采用；先核对当前规则与团队条件。", href: "/app" },
            { title: "个人收藏与审核资源", description: "下次再用工具时，在经运营审核的资源与本人收藏中重新核对可用状态、费用和许可，按需要主动分享。", href: "/resources" },
            { title: "下一场比赛", description: "有新的作品想法时，回到比赛分析与真实来源，重新核对资格、报名、官方赛道和各项截止。", href: "/events" },
          ],
        },
      ],
    },
  ],
};

const contentErrors = validateJourneyGuide(GUIDE);
if (contentErrors.length > 0) throw new Error(`Invalid journey guide: ${contentErrors.join("; ")}`);

/** Return an independent public snapshot; consumers cannot contaminate later reads. */
export function getJourneyGuide(): JourneyGuide {
  return structuredClone(GUIDE);
}
