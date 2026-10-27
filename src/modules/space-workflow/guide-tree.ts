import type { PlanningTask } from "../planning/index.ts";
import type { LifecycleInput, SpaceLink } from "./model.ts";

export type SpaceGuideStepId = "enter" | "rules" | "planning" | "execution" | "submission" | "reflection";
export type SpaceGuideFactStatus = "recorded" | "prepare" | "check" | "unknown" | "loading" | "error" | "review";
export interface SpaceGuideFact { status: SpaceGuideFactStatus; label: string; explanation: string }
export interface SpaceGuideNode {
  id: string;
  title: string;
  when: string;
  actions: readonly string[];
  condition: string;
  fact: SpaceGuideFact;
  links: readonly SpaceLink[];
  tools: readonly SpaceLink[];
  next: string;
  optional?: boolean;
}
export interface SpaceGuideStep {
  id: SpaceGuideStepId;
  title: string;
  summary: string;
  nodes: readonly SpaceGuideNode[];
  next: string;
}
export interface SpaceGuideTreeView {
  steps: readonly SpaceGuideStep[];
  currentStepId: SpaceGuideStepId;
  next: SpaceLink;
  readonly: boolean;
  solo: boolean;
  notice: string;
}

const factLabels: Record<SpaceGuideFactStatus, string> = {
  recorded: "有记录", prepare: "待准备", check: "自行核对", unknown: "尚未读取", loading: "读取中", error: "读取失败", review: "需要复核",
};
function fact(status: SpaceGuideFactStatus, explanation: string): SpaceGuideFact { return { status, label: factLabels[status], explanation }; }
function link(title: string, href: string, purpose: string): SpaceLink { return { title, href, purpose }; }
function accepted(task: PlanningTask): boolean {
  const check = task.acceptance;
  return task.status === "done" && Boolean(check && check.acceptedByUserId.trim() && Number.isFinite(Date.parse(check.acceptedAt))
    && ["manager", "reviewer", "self_check"].includes(check.mode) && (check.evidenceRefs.some(value => value.trim()) || check.note.trim()));
}

/** A read-only explanation tree. Browsing never creates or completes a task.
 * Only DTOs already authorized by the parent may be passed to this function. */
export function buildSpaceGuideTree(input: LifecycleInput): SpaceGuideTreeView {
  const { detail } = input, project = detail.project, id = project.id, encoded = encodeURIComponent(id);
  const base = `/app/projects/${encoded}`, readonly = project.stage === "archived";
  const manager = detail.membership.role === "manager" && detail.membership.status === "active" && !readonly;
  const solo = detail.members.filter(member => member.projectId === id && member.status === "active").length <= 1;
  const goalPresent = Boolean(project.goal.trim() && project.minimumDeliverable.trim());
  const goalFact = fact(goalPresent ? "recorded" : "prepare", goalPresent
    ? `空间已保存作品目标与最小成果；请和队友核对能否在本场时间内完成。`
    : "作品目标或最小成果还没写清，先确定一个可实际体验的核心流程。");

  const ruleRead = input.rules;
  const ruleValue = ruleRead?.status === "ready" ? ruleRead.value : null;
  const confirmation = ruleValue?.confirmation;
  const rules = ruleValue?.rules;
  const ruleMatches = Boolean(confirmation && rules && confirmation.projectId === id && confirmation.eventId === rules.eventId && confirmation.rulesVersion === rules.version);
  const ruleStale = Boolean(ruleMatches && rules!.qualityFlags.some(flag => ["needs_recheck", "source_stale", "source_failed"].includes(flag)));
  const ruleFact = fact(ruleRead?.status === "error" ? "error" : ruleRead?.status === "loading" ? "loading" : !ruleRead || ruleRead.status === "unread" ? "unknown"
    : ruleMatches ? ruleStale ? "review" : "recorded" : confirmation || rules ? "review" : "prepare",
    ruleRead?.status === "error" ? "比赛要求读取失败，当前要求未知；请去比赛与资料重新读取，不能当作没有要求。"
      : ruleRead?.status === "loading" ? "正在读取比赛要求，暂不判断是否已确认。"
      : !ruleRead || ruleRead.status === "unread" ? "比赛要求尚未读取，需到原页面核对。"
      : ruleMatches ? `已保存规则版本 ${rules!.version}${ruleStale ? "，来源状态需要复核" : "；未知项与官网更新仍需核对"}。`
      : confirmation || rules ? "已读内容与本空间确认的规则版本未对齐，请重新核对；不把旧规则当作当前依据。"
      : "还没有本空间已确认规则；手填比赛名称或团队截止不代替官方要求。");

  const trackRead = input.tracks;
  const trackValue = trackRead?.status === "ready" && trackRead.value.projectId === id ? trackRead.value : null;
  const trackContext = trackValue?.rules, selection = trackValue?.selection;
  const trackContextMatches = Boolean(ruleMatches && trackContext && trackContext.eventId === confirmation!.eventId
    && trackContext.rulesVersion === confirmation!.rulesVersion && trackContext.confirmationRevision === confirmation!.revision
    && (trackContext.latestPublishedRulesVersion === null || trackContext.latestPublishedRulesVersion === trackContext.rulesVersion));
  const selectionMatches = Boolean(trackContextMatches && selection && selection.projectId === id && selection.eventId === trackContext!.eventId
    && selection.rulesVersion === trackContext!.rulesVersion && selection.confirmationRevision === trackContext!.confirmationRevision
    && selection.catalogStatus === trackContext!.catalog.status && (selection.trackId === null && trackContext!.catalog.status === "none"
      || trackContext!.catalog.status === "confirmed" && trackContext!.catalog.tracks.some(track => track.id === selection.trackId)));
  const trackReady = Boolean(trackValue && !trackValue.needsReview && selectionMatches);
  const trackFact = fact(trackRead?.status === "error" ? "error" : trackRead?.status === "loading" ? "loading" : !trackRead || trackRead.status === "unread" ? "unknown"
    : trackReady ? "recorded" : trackValue?.needsReview || trackValue && !trackContextMatches ? "review" : "check",
    trackRead?.status === "error" ? "官方赛道读取失败，赛道安排未知。"
      : trackRead?.status === "loading" ? "正在读取官方赛道；工具或技能分类不代替主办方赛道。"
      : !trackRead || trackRead.status === "unread" ? "官方赛道尚未读取；先查看本场主办方是否划分赛道。"
      : trackReady ? selection!.trackId === null ? "已保存主办方未细分赛道的选择，按统一要求准备。" : `已保存官方赛道选择：${selection!.trackName || "到比赛与资料查看名称"}。资格和规则更新仍需核对。`
      : "官方赛道或选择待核对。旧选择、未知或冲突信息不能解释为主办方没有赛道。");

  const current = input.current;
  const planScopeMatches = Boolean(current?.plan && current.plan.projectId === id && current.plan.inputSnapshot.projectId === id);
  const currentReadable = !input.planningError && !input.planningLoading && current !== null;
  const planApplied = Boolean(currentReadable && planScopeMatches && current!.plan!.status === "applied");
  const planChanged = Boolean(planApplied && (current!.inputVersionsChanged || ruleMatches
    && current!.plan!.inputSnapshot.requirementVersionId !== `${confirmation!.eventId}:${confirmation!.rulesVersion}:${confirmation!.revision}`));
  const planReady = planApplied && !planChanged;
  const planFact = fact(input.planningError ? "error" : input.planningLoading ? "loading" : current === null ? "unknown"
    : !current.plan ? "prepare" : !planScopeMatches || !planApplied || planChanged ? "review" : "recorded",
    input.planningError ? "任务计划读取失败，当前安排未知；去任务进度重新读取。"
      : input.planningLoading ? "正在读取当前计划，暂不判断任务是否能开始。"
      : current === null ? "任务计划尚未读取，不等于没有计划。"
      : !current.plan ? "还没有生效计划。先选职责、确认时间，再检查并确认任务安排。"
      : !planScopeMatches ? "计划与本空间未对齐，请重新读取，暂不使用这些任务。"
      : !planApplied ? "读取到的计划尚未确认生效；保存草案不代表全队已有执行安排。"
      : planChanged ? "已保存计划的比赛要求或空间输入有变，请保留成果并重新核对计划。"
      : "已有已确认生效的计划；实际开始条件、时间容量和前置成果仍在任务进度检查。");
  // Never display another space's task contents, or treat failed reads as an empty plan.
  const tasks = planApplied ? current!.tasks.filter(task => task.projectId === id && task.status !== "cancelled") : [];
  const checked = tasks.filter(accepted);
  const awaiting = tasks.filter(task => task.status === "review");
  const incomplete = tasks.filter(task => !accepted(task));
  const acceptanceFact = fact(!planApplied ? planFact.status : planChanged ? "review" : "recorded", !planApplied ? planFact.explanation
    : `当前计划有 ${tasks.length} 项未删减任务，${checked.length} 项有检查通过记录，${awaiting.length} 项待检查。${planChanged ? "输入已变化，需复核安排与后续依赖。" : "检查记录只说明对应任务，不代表整场比赛已完成。"}`);
  const memberTime = planReady ? current!.plan!.inputSnapshot.availability.find(value => value.membershipId === detail.membership.membershipId) : undefined;
  const availabilityFact = fact(memberTime?.confirmedAt ? "recorded" : "check", memberTime?.confirmedAt
    ? "当前生效计划引用了本人已确认时间；这里是计划快照，临时变化请回队友与分工更新。"
    : "这里尚无生效计划引用的时间快照；已填过的职责与时间可在下方查看，不必重复填写。首次使用时再补充，不默认全天有空。");
  const assignmentFact = fact(planReady && current!.plan!.inputSnapshot.assignmentVersionId ? "recorded" : "check", planReady && current!.plan!.inputSnapshot.assignmentVersionId
    ? "当前生效计划引用了已保存分工记录；临时职责调整仍需回原页面确认。"
    : "当前输入不能证明分工已确认。每人先选职责，不清楚时再请 AI 提建议。");

  const shared = link("查看本空间共享资料", `${base}/resources`, "查看队友主动共享的资料；本人行程、测评与讲稿不会自动公开。");
  const resources = link("工具与资料", "/resources", "按当前任务找已审核资料和工具，先核对用途、前置条件和许可。");
  const inspiration = link("找视觉与组件灵感", "/inspiration", "参考视觉、组件和动效官网，查看分析状态与素材许可。");
  const skills = link("AI 技能与赛道包", "/skills", "按实际 AI 工具和任务选技能，复制命令不等于安装或成功试用。");
  const github = link("GitHub 全流程教程", `/github?projectId=${encoded}`, "学习建仓、分支、拉取与保存；进入操作前仍需授权和确认。");
  const roadshow = link("准备路演讲稿", `/roadshow?projectId=${encoded}`, "带入当前空间供本人确认；讲稿仍保存在本人，分享需主动选择。");
  const ppt = link("准备 PPT 大纲", `/ppt?projectId=${encoded}`, "带入当前空间供本人确认，整理演示结构；生成大纲不代表 PPT 已制作完成。");
  const rulesLink = link("去比赛与资料核对要求", `${base}/rules`, "核对官方规则、赛道、必交材料与各阶段截止。");
  const planLink = link("去任务进度查看安排", `${base}/plan`, "在原任务页查看草案、风险、负责人、依赖和真实检查记录。");

  const steps: SpaceGuideStep[] = [
    {
      id: "enter", title: "1. 先确定作品目标，按需邀请队友", summary: "先说清楚要解决什么、至少做出什么；一个人也能继续。",
      nodes: [
        { id: "goal", title: "写清楚这次要做出什么", when: "刚进入空间，或团队想法发生变化时。", actions: ["用一句话说明作品解决的问题，再写一个能实际体验的最小成果。", "和队友约定哪些必做、哪些来不及可以删减，避免一开始目标过大。"], condition: "作品目标和最小成果都已保存，队友能用自己的话说清核心体验。", fact: goalFact,
          links: [link(manager ? "填写作品目标与最小成果" : "查看目标，与管理员核对", `${base}#project-goal`, manager ? "在空间原设置中保存；本树不另存作品目标。" : "空间成员可查看；修改由管理员在原设置完成。")], tools: [link("查看完整参赛路线图", "/journey", "先了解赛前、赛中和赛后的通用行动。")], next: "目标清楚后，按需邀请队友，再核对本场比赛要求。" },
        { id: "invite", title: "需要协作时邀请队友（可选）", when: "需要队友共同完成作品时；独自参赛可以直接继续。", optional: true,
          actions: ["管理员选择链接允许加入的人数，生成后及时复制链接或展示二维码。", "队友登录、核对目标空间和角色、明确接受后才加入；各自填写时间与职责。"], condition: "需要协作的人已明确接受并出现在活跃成员中；复制链接不等于已经加入。",
          fact: fact("check", solo ? "当前空间只有一位活跃成员，可以独自继续；没有邀请完成记录可据此判断是否还要拉人。" : `当前有 ${detail.members.filter(member => member.projectId === id && member.status === "active").length} 位活跃成员；是否齐员由团队核对，不从人数推断邀请完成。`),
          links: [link(manager ? "打开邀请队友窗口" : "查看队友，联系空间管理员邀请", manager ? `${base}#space-invitation` : `${base}/team`, manager ? "打开已有邀请弹窗，保留人数、有效期、撤销和接受流程。" : readonly ? "归档空间只读，可查看历史成员。" : "邀请由当前空间管理员操作；普通成员不会获得发链接权限。")], tools: [], next: "一个人或多人都可进入下一段；固定队伍关系不代替本空间成员权限。" },
      ], next: "接着打开比赛与资料，核对主办方要求；不用等队伍满员。",
    },
    {
      id: "rules", title: "2. 核对报名、官方赛道和比赛要求", summary: "官网报名、资格、AI 规则和截止都要看清，别把团队计划当官方要求。",
      nodes: [
        { id: "registration", title: "去主办方入口核对报名", when: "决定参加比赛之前，或报名信息更新时。", actions: ["从已保存赛事线索打开主办方原文，核对报名截止、资格、费用、地点和参加方式。", "需要报名时在主办方入口完成操作，保留确认邮件或回执；不清楚就联系主办方。"], condition: "你已核对当前资格与报名状态，并自行保留主办方确认依据。", fact: fact("check", "空间没有报名完成或主办方接受记录；有比赛卡片、开赛日期或已确认规则都不能证明报名成功。"),
          links: [rulesLink, link("查看与更新本空间赛事线索", `${base}/rules`, "先查看本空间已保存线索与原文，旧线索不自动成为确认规则。")], tools: [link("去找比赛页查看线索", "/events", "需要换比赛时查看公开赛事；通过原保存流程选择本空间。")], next: "报名情况核对清楚后，查看本场官方赛道和提交要求。" },
        { id: "official-track", title: "按主办方规定选择赛道", when: "选作品方向和分工之前，或规则出现新版本时。", actions: ["在比赛与资料核对赛道资格、评分关注点和对应交付物。", "由管理员保存本场官方赛道选择；主办方明确未细分赛道时，按统一要求准备。"], condition: "当前规则与赛道选择一致；未知或冲突信息已经向主办方核对。", fact: trackFact, links: [rulesLink], tools: [], next: "按选定赛道整理必交材料和截止，再安排任务；技能包分类不代替官方赛道。" },
        { id: "requirements", title: "确认比赛要求与每个截止", when: "制定计划前；比赛要求有变化时再核对。", actions: ["核对 AI 使用限制、代码或素材许可、队伍人数，以及 Demo、文档、PPT、视频是否必交。", "分别记清报名、各轮提交、视频与路演时间和时区，保存确认规则版本。"], condition: "当前空间有已确认规则，必交、可选、未知项都已区分；未知截止没有被补成精确时间。", fact: ruleFact, links: [rulesLink], tools: [link("黑客松与规则入门", "/library", "看不懂比赛术语时先读本站原创入门说明。")], next: "把确认的要求带到职责、可用时间和任务计划里；团队手填截止仍要单独说明。" },
      ], next: "根据官方赛道选择职责、确认本人时间，再安排计划。",
    },
    {
      id: "planning", title: "3. 选职责、填时间，确认分工与计划", summary: "先确定谁能做什么、什么时候能做，再检查计划；草案要确认才生效。",
      nodes: [
        { id: "duties-time", title: "每个人选择职责，确认可用时间", when: "开始安排任务之前；职责或工作时间变化时。", actions: ["每人选择愿意承担的工作，可选多个职责；不清楚时让 AI 根据官方赛道提建议。", "本人填写实际可工作、休息和忙碌时段，按需分享相关意愿，不把私人测评全部公开。"], condition: "各人已确认实际可投入时间，团队清楚负责人；单人同样可以承担多个职责。", fact: availabilityFact,
          links: [link("去队友与分工填写本人时间", `${base}/team`, "本人确认可用时间，管理员不代替他人声明全天可工作。"), link("选择职责，查看分工建议", `${base}/assessment`, "自选职责优先，AI 建议按需使用；测评不是必走步骤。")], tools: [link("个人参赛与出行准备", "/participation", "行程与天气建议保存在本人账号，需要时主动分享给队友。")], next: "每人意愿和时间清楚后，明确分工并制定任务草案。" },
        { id: "assignment", title: "确定分工，安排任务草案", when: "作品目标、要求和成员时间已有依据时。", actions: ["团队核对每项职责由谁承担，管理员在原分工页面确认；AI 草案可修改或手动安排。", "任务写明负责人、交付物、检查条件、截止和真正依赖；为联调、录制、排错和提交留时间。"], condition: "分工已明确，每项任务都知道交什么、谁检查、等什么；不强制 Demo→UI→视频为唯一顺序。", fact: assignmentFact, links: [link("确认职责与分工", `${base}/assessment`, "在原页面核对并确认分工，不把 AI 建议直接当生效安排。"), planLink], tools: [], next: "查看任务计划风险，调整范围和缓冲，再明确确认生效。" },
        { id: "applied-plan", title: "检查风险，确认计划生效", when: "计划草案保存后、实际执行前；输入变化后。", actions: ["检查时间容量、缺失负责人、前置关系、必交材料和无法完成的任务，先删减或调整。", "管理员核对后确认计划；新规则或时间变化时复核安排，已经完成的成果保留。"], condition: "原计划页明确显示当前生效版本；浏览、生成、保存草案都不代替确认。", fact: planFact, links: [planLink], tools: [], next: "计划生效后，每个人到任务进度查看当前能做的工作。" },
      ], next: "执行按真实任务依赖进行，不按这份说明自动开始或打钩。",
    },
    {
      id: "execution", title: "4. 按依赖执行任务，交成果并检查", summary: "先看能做什么；等前置时可做并行工作，交成果后请队友检查。",
      nodes: [
        { id: "start-task", title: "查看本人任务和真实前置条件", when: "准备开始工作，或在等队友交付时。", actions: ["在任务进度核对负责人、时间安排和待检查的前置成果。", "UI 草图、技术验证、路演结构可按实际依赖并行；等 Demo 时先做不依赖 Demo 的准备。"], condition: "当前计划有效，负责人和工作时间可用，实际前置成果已检查通过；只看 done 文字或说做好了不够。", fact: planFact, links: [planLink], tools: [inspiration, resources, skills], next: "能开始就实际工作；不能开始则联系对应负责人，并选择可并行的任务。" },
        { id: "handoff", title: "交出成果，让队友能接手", when: "任务成果可查看时，或遇到阻塞需要帮助时。", actions: ["在原任务页提交成果链接、说明和证据；遇到问题写清阻塞与剩余工作。", "交接时说明代码版本、运行方式、已知问题；邀请检查，不用口头“做完了”替代记录。"], condition: "成果可访问、使用方式清楚，任务进入待检查；提交成果还不等于检查通过。", fact: acceptanceFact,
          links: [planLink, shared, link("保存代码或查看运行记录", `${base}/delivery`, "需要时记录版本和运行依据，与任务成果分开保留。")], tools: [github], next: "交出成果后，由有权限的检查人按任务条件检查。" },
        { id: "check-unlock", title: "检查通过，再继续后续任务", when: "收到队友成果，或自己的成果等待检查时。", actions: ["检查人按任务条件试用成果，记录检查依据；单人可按原规则自检。", "前置任务当前已完成并有有效检查记录，后续任务才可能解除依赖；仍要核对时间与负责人。"], condition: "原任务保留当前检查通过记录。已删减、待检查、重开的任务以及缺检查记录的 done 都不能解除等待。", fact: acceptanceFact, links: [planLink], tools: [], next: "需要返工就交代问题；必交任务和可演示版本准备好后，进入演示与提交。" },
      ], next: "阶段说明不会自动认定 Demo、环境或整套任务已完成。",
    },
    {
      id: "submission", title: "5. 准备演示，核对正式提交", summary: "代码保存、运行、PPT/视频、官方提交是独立事项，按本场规则逐项核对。",
      nodes: [
        { id: "code-runtime", title: "分别核对保存版本与实际运行", when: "联调、演示或正式提交之前。", actions: ["按规则保存对应代码版本；需要网站代操作 GitHub 时先授权、预览变化，再明确确认。", "在实际演示环境跑通核心流程，记录版本、步骤和证据，预留故障备用方案。"], condition: "已核对要交的版本和实际运行记录；旧版本运行通过不代表当前版本可用。", fact: fact("check", "本树没有读取仓库、运行或环境准备记录；请到提交与复盘查看，不能从任务完成推断运行成功。"),
          links: [link("查看代码保存与当前版本运行", `${base}/delivery`, "保存、运行和正式提交分别记录；GitHub 不是使用空间的前置条件。")], tools: [github, resources], next: "能实际演示后，按主办方要求核对展示材料并排练。" },
        { id: "presentation-materials", title: "准备 PPT、视频与路演（按规则）", when: "整理演示内容时；脚本和大纲可以提前并行准备。", actions: ["按本场要求准备问题、方案、真实 Demo、结果和限制，PPT/视频是否必交以规则为准。", "排练限时表达与现场演示；录像前核对 Demo 版本，避免讲稿和实际功能不一致。"], condition: "实际文件可打开、视频可播放、演示可复现且符合时间限制；生成大纲或讲稿不等于材料完成。", fact: fact("check", "空间没有 PPT、视频或讲稿制作完成记录，请自行核对实际材料；本人生成内容不会自动分享给全队。"),
          links: [roadshow, ppt, rulesLink], tools: [inspiration, resources], next: "材料准备齐后，核对每轮正式提交入口与截止，并保留实际凭据。" },
        { id: "formal-submission", title: "按官方要求提交，保留真实依据", when: "每个正式提交截止之前，不只最后一轮。", actions: ["在主办方要求的平台逐轮提交，检查文件、公开访问权限和对应代码版本。", "回原交付页记录真实提交时间和凭据；失败、撤回、成员自报与平台核验分开保留。"], condition: "逐轮核对主办方回执或状态；保存代码、运行通过、空间标为 submitted 都不能代替正式提交。", fact: fact("check", "本树没有读取正式提交记录，主办方是否接受仍待核对；成员报告提交也不能代表整场已被接受。"),
          links: [link("核对材料并查看正式提交依据", `${base}/delivery#official-submission`, "查看原提交清单和记录；无官方入口时先回规则页核对。"), rulesLink], tools: [], next: "核对实际交付后，带着成果、问题和证据进入复盘。" },
      ], next: "提交成功、主办方接受和获奖各有自己的依据，这棵树不会自动判定。",
    },
    {
      id: "reflection", title: "6. 留下复盘，选择复用或归档", summary: "保存真实经验；下次复用方法，重新核对比赛、时间和账号授权。",
      nodes: [
        { id: "retrospective", title: "整理成果、问题和经验", when: "比赛结束后，或团队准备总结时。", actions: ["核对实际保存、运行、材料和提交依据，区分已做成、没确认、待改进。", "记录有效分工、时间失误、环境问题与复用建议，在原复盘页保存并确认。"], condition: "原复盘记录有真实成果和具体改进；改空间阶段或打开复盘页不代表复盘已完成。", fact: fact("check", "本树没有读取复盘确认记录，需到原页面查看；空间阶段只表示团队安排。"),
          links: [link("查看或整理本空间复盘", `${base}/retrospective`, "复盘事实由原模块保存，树里不另存完成状态。"), link("回看代码、运行和正式提交", `${base}/delivery`, "核对真实版本与历史记录，包括失败、撤回和待确认结果。")], tools: [], next: "选择值得复用的经验和资料，再决定是否归档本空间。" },
        { id: "reuse-archive", title: "选择复用资料，按需归档", when: "本次协作告一段落，或开始下一次比赛时。", actions: ["选择有用的经验和明确共享的资料；下次重新核对新比赛要求、成员时间和仓库授权。", "管理员确认后在原空间设置归档；归档保留历史并只读，不清空成果。"], condition: "复用内容由本人选择，新项目没有继承旧报名、截止或成功状态；归档事实以原空间记录为准。", fact: fact(readonly ? "recorded" : "check", readonly ? "当前空间已归档，历史只读；这不表示整场流程已完成或比赛已获奖。" : "是否复用或归档由团队决定；查看资料不等于已复用，也不自动归档。"),
          links: [link("查看经验与选择性复用", `${base}/retrospective`, "旧成功记录不会自动变成新比赛的完成事实。"), shared, link(readonly ? "查看空间设置与历史" : manager ? "打开空间设置，按需归档" : "查看空间设置，联系管理员归档", `${base}#space-settings`, "归档仍在原操作页确认，本树不发起修改。")], tools: [link("回顾参赛路线图", "/journey", "选择下一次需要补齐的准备，保留独立的团队任务事实。")], next: "下次参赛从新比赛要求开始，按需复用经验，不复制旧截止或提交状态。" },
      ], next: "这次记录保留，下次按新比赛重新确认事实。",
    },
  ];

  let currentStepId: SpaceGuideStepId;
  let next: SpaceLink;
  if (readonly) { currentStepId = "reflection"; next = link("查看本空间复盘与经验", `${base}/retrospective`, "空间已归档，只回顾已保存记录；不把归档当整场流程完成。"); }
  else if (!goalPresent) { currentStepId = "enter"; next = { ...steps[0]!.nodes[0]!.links[0]!, purpose: goalFact.explanation }; }
  else if (!ruleMatches || ruleStale || !trackReady) { currentStepId = "rules"; next = { ...rulesLink, purpose: !ruleMatches || ruleStale ? ruleFact.explanation : trackFact.explanation }; }
  else if (!planReady || tasks.length === 0) { currentStepId = "planning"; next = { ...planLink, purpose: planReady && tasks.length === 0 ? "已读到生效计划，但还没有未删减任务。请在原页面核对是否需要补充实际安排；空列表不代表全部完成。" : planFact.explanation }; }
  else if (project.stage === "retrospective") { currentStepId = "reflection"; next = steps[5]!.nodes[0]!.links[0]!; }
  else if (["finalizing", "submitted"].includes(project.stage) || incomplete.length === 0) {
    currentStepId = "submission"; next = link("查看提交前核对清单", `${base}/delivery`, "分别核对代码、运行、展示材料与各轮正式提交；空间阶段不证明提交成功。");
  } else {
    currentStepId = "execution";
    const related = incomplete.filter(task => task.ownerMembershipId === detail.membership.membershipId || task.helperEfforts.some(helper => helper.membershipId === detail.membership.membershipId)
      || task.status === "review" && (detail.membership.role === "manager" || task.reviewerMembershipId === detail.membership.membershipId));
    const statusOrder = { review: 0, in_progress: 1, blocked: 2, todo: 3, done: 4, cancelled: 5 };
    const selected = related.sort((a, b) => statusOrder[a.status] - statusOrder[b.status] || a.id.localeCompare(b.id))[0];
    next = selected ? link(`查看任务：${selected.title}`, `${base}/plan#task-${encodeURIComponent(selected.id)}`, selected.status === "review" ? "先核对成果与检查依据，再按原页面权限处理。" : "查看这项任务的时间、前置成果和交接要求，再决定能否开始。") : planLink;
  }
  return { steps, currentStepId, next, readonly, solo, notice: readonly
    ? "归档只读：下方是本场流程说明与历史入口，不能据此发起新邀请或更新记录。"
    : "这棵树告诉你何时做、怎么做、下一步去哪；依据当前已读取记录推荐入口，未知事项仍需自行核对。浏览不会生成任务、收费调用、共享私人资料或保存另一份进度。" };
}
