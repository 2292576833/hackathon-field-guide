import type { PhaseGuide } from "./model.ts";

/** Guides contain suggestions and destinations, never project completion facts. */
export function spacePhaseGuides(projectId: string): readonly PhaseGuide[] {
  const base = `/app/projects/${encodeURIComponent(projectId)}`;
  const presentationContext = `?projectId=${encodeURIComponent(projectId)}`;
  return [
    { id: "formation", title: "组队与选方向", purpose: "先确定这次要解决什么问题，按主办方规定选方向，再确定谁愿意做什么。",
      actions: [
        { title: "核对比赛与官方赛道", href: `${base}/rules`, purpose: "确认资格、官方赛道与规则依据；工具分类不能代替官方赛道。" },
        { title: "选择职责与确定分工", href: `${base}/assessment`, purpose: "可以自选多个职责；不清楚时再使用 AI 帮助，建议需要确认。" },
        { title: "查看队友与可用时间", href: `${base}/team`, purpose: "多人时邀请队友并填写可工作时间；单人也能继续。" },
      ], tools: [
        { title: "找比赛", href: "/events", purpose: "查看已保存的赛事线索，回主办方原文核对报名方式。" },
        { title: "参赛路线图", href: "/journey", purpose: "了解完整流程，帮助确定当前要准备什么。" },
      ], caution: "空间没有报名完成记录。打开官网或浏览规则不代表已经报名。" },
    { id: "preparation", title: "赛前准备", purpose: "把要求、时间和最小成果写清楚，提前试用真正需要的工具。",
      actions: [
        { title: "核对比赛要求", href: `${base}/rules`, purpose: "逐项核对必交材料、截止与未知信息。" },
        { title: "确认任务与时间计划", href: `${base}/plan`, purpose: "按本人确认的可用时间安排任务、依赖与提交缓冲。" },
        { title: "查看代码保存与运行记录", href: `${base}/delivery`, purpose: "需要仓库时再绑定；提前检查环境与关键演示流程。" },
      ], tools: [
        { title: "工具与资料", href: "/resources", purpose: "寻找教程和工具，预留配置、学习与排错时间。" },
        { title: "技能库", href: "/skills", purpose: "按实际任务选择技能；安装和客户端验证需要另行操作。" },
        { title: "我的参赛与出行计划", href: "/participation", purpose: "在本人账号准备行程与天气事项，不自动共享给队友。" },
      ], caution: "空间没有环境、出行或天气准备完成记录。请按自己的实际情况核对。" },
    { id: "competition", title: "比赛进行中", purpose: "先看自己负责的任务和真实前置条件，再交付成果、请队友检查。",
      actions: [
        { title: "查看我的任务与交接", href: `${base}/plan`, purpose: "查看负责人、依赖、成果与检查状态；前置未通过不能当作已解除。" },
        { title: "查看团队共享资料", href: `${base}/resources`, purpose: "使用队友明确共享的资料和当前任务依据。" },
      ], tools: [
        { title: "设计灵感", href: "/inspiration", purpose: "需要界面、组件或动效参考时使用，并核对来源和许可。" },
        { title: "工具与资料", href: "/resources", purpose: "遇到实现、联调或测试问题时找相关教程。" },
        { title: "技能库", href: "/skills", purpose: "按要交的成果选工具，避免临近截止盲目换工具。" },
      ], caution: "UI 草图、技术验证和讲稿结构可按真实依赖并行；准备建议不会自动成为已分配任务。" },
    { id: "presentation", title: "演示与提交", purpose: "核对这一版能否演示、有哪些必交材料，以及每个正式提交阶段的记录。",
      actions: [
        { title: "查看提交前核对清单", href: `${base}/delivery`, purpose: "分别核对代码保存、当前版本运行与官方提交，记录实际依据。" },
        { title: "查看已确认的比赛要求", href: `${base}/rules`, purpose: "按主办方材料、时间与入口逐项核对，缺失时回原文确认。" },
      ], tools: [
        { title: "准备路演讲稿", href: `/roadshow${presentationContext}`, purpose: "带入当前空间供本人确认，讲稿先保存在本人账号，需要时主动分享。" },
        { title: "准备 PPT 大纲", href: `/ppt${presentationContext}`, purpose: "带入当前空间供本人确认，在本人账号组织展示要点，需要时主动分享。" },
        { title: "工具与资料", href: "/resources", purpose: "寻找展示、录制与材料整理工具；是否必交以本场规则为准。" },
      ], caution: "空间没有 PPT、视频或讲稿已完成记录。成员报告提交也不能代表主办方已接受。" },
    { id: "reflection", title: "赛后复盘", purpose: "留下真实成果、问题和依据，决定哪些经验适合下次复用。",
      actions: [
        { title: "查看复盘与经验", href: `${base}/retrospective`, purpose: "区分已做成、没确认和待改进的事情，再选择复用内容。" },
        { title: "查看代码与提交记录", href: `${base}/delivery`, purpose: "回看实际保存、运行和各阶段提交依据，保留撤回与历史。" },
        { title: "查看团队共享资料", href: `${base}/resources`, purpose: "保留对后续参赛有用、且已明确共享的资料。" },
      ], tools: [{ title: "参赛路线图", href: "/journey", purpose: "回顾完整过程，选择下一次需要补齐的准备。" }],
      caution: "项目阶段只表示空间安排，不能代替官方提交或获奖结果。归档空间只读。" },
  ];
}
