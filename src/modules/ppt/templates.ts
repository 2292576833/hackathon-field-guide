import type { PptTemplate, PptTemplateId } from "./domain.ts";

/** Protect the shared originals; getPptTemplate returns an editable copy. */
function protectTemplate(template: PptTemplate): PptTemplate {
  for (const slide of template.slides) {
    Object.freeze(slide.write);
    Object.freeze(slide.avoid);
    Object.freeze(slide);
  }
  Object.freeze(template.slides);
  return Object.freeze(template);
}

/** Original editorial frameworks. These are not generated project outlines. */
export const PPT_TEMPLATES: readonly PptTemplate[] = Object.freeze([
  protectTemplate({
    id: "demo-3",
    name: "3 分钟 Demo：先让人看懂",
    durationMinutes: 3,
    description: "围绕一条已完成的使用路径展开，适合把小而真实的成果讲清楚。",
    slides: [
      {
        title: "一句话介绍项目",
        write: [
          "填写项目名，以及它想帮助哪类用户完成哪件事。",
          "标明当前阶段：想法、原型或已运行版本，按实际情况选择。",
        ],
        say: "用一句日常语言介绍：我们正在为谁，解决哪个具体问题。目标效果尚未验证时，讲成目标。",
        avoid: ["开场堆满技术名词。", "把目标效果说成已经实现的效果。"],
        visualSuggestion: "项目名加一句话定位；如有真实产品截图，放一张并标注版本。",
        durationSeconds: 20,
      },
      {
        title: "把问题说具体",
        write: [
          "写一个目标用户正在做的具体任务，以及现在遇到的阻碍。",
          "附实际观察或反馈；没有证据就标明“待验证假设”。",
        ],
        say: "先带大家进入这个场景，再解释为什么选择这一小段流程来改进。",
        avoid: ["虚构访谈、用户数或节省时间。", "把个人猜测写成所有用户的共同需求。"],
        visualSuggestion: "用三格描述“用户—任务—阻碍”；假设旁放清楚的文字标签。",
        durationSeconds: 25,
      },
      {
        title: "演示一条已完成的路径",
        write: [
          "列出输入、两到三个关键操作和实际输出，只选择已经完成的环节。",
          "标明现场演示、录屏或界面讲解；录屏写明录制版本。",
          "准备同一流程的截图或录屏备用；未完成的环节单独标注。",
        ],
        say: "从一个明确输入开始，边操作边解释用户下一步做什么，最后停在实际得到的结果。演示失败时说明现状，再切到已标注的备用材料。",
        avoid: ["连续切换多个账号和页面。", "把界面占位、模拟数据或计划中的功能演成真实成功。"],
        visualSuggestion: "演示画面为主，旁边只留“输入—操作—结果”三步；备用截图保持同一顺序。",
        durationSeconds: 75,
      },
      {
        title: "哪些已完成，哪些还没",
        write: [
          "分别填写“已完成”“待实现”“证据待补”，每栏最多三项。",
          "已有结果附来源和测试条件；没有测试数据就写“尚未测量”。",
        ],
        say: "说明这次能交付的范围，以及还需要验证的部分，让大家知道刚才看到的结果能说明什么。",
        avoid: ["用成功率、性能或成本数字填补未知。", "把本地一次运行写成已上线或稳定可用。"],
        visualSuggestion: "三列短清单；用文字区分状态，证据放在对应条目旁。",
        durationSeconds: 35,
      },
      {
        title: "下一步和一句请求",
        write: [
          "写下一项最值得做的验证，以及希望得到的具体反馈。",
          "填写已经可访问的项目入口；还未开放就写当前获取方式。",
        ],
        say: "用一句话收束价值，然后告诉大家下一步想验证什么、欢迎帮助看哪件事。",
        avoid: ["临时展开新功能或完整商业计划。", "展示未核对的二维码、地址或获奖承诺。"],
        visualSuggestion: "一句结尾加一个明确行动；入口较长时另留可读短说明。",
        durationSeconds: 25,
      },
    ],
  }),
  protectTemplate({
    id: "product-5",
    name: "5 分钟产品：问题到交付",
    durationMinutes: 5,
    description: "把用户问题、产品选择、真实演示与验证计划串起来，适合说明一个完整产品想法。",
    slides: [
      {
        title: "项目与这次的主张",
        write: [
          "填写项目名、目标用户和最想改善的一件事。",
          "用一句话概括本次已完成成果，并注明当前版本或阶段。",
        ],
        say: "让听众先知道我们为谁做、现在做到哪里，再带他们看具体场景。",
        avoid: ["先讲团队履历很久。", "用“全自动”“人人适用”等词替代具体范围。"],
        visualSuggestion: "项目名、一句价值主张和一张真实界面图；没有界面则用简洁文字。",
        durationSeconds: 25,
      },
      {
        title: "用户在什么场景遇到问题",
        write: [
          "描述一个用户、一个任务和当前处理方式。",
          "填写实际访谈或观察的来源；未做验证时标为“待验证假设”。",
        ],
        say: "说清楚具体麻烦发生在哪里，以及现有方式为什么让我们想尝试另一条路径。",
        avoid: ["编造市场规模、调研人数或用户引语。", "把所有人的问题混成一句笼统痛点。"],
        visualSuggestion: "一条现有流程，圈出真实阻碍；有引用时写明来源和日期。",
        durationSeconds: 40,
      },
      {
        title: "我们的产品选择",
        write: [
          "写核心流程及两到三个关键选择，解释它们如何对应上述任务。",
          "分别标记已实现能力、设计建议和待实现能力。",
        ],
        say: "解释我们为什么先做这些步骤。比较现有方式时使用已知事实，未知效果留给验证。",
        avoid: ["没有实际比较就宣称优于所有竞品。", "把工具清单当作用户价值。"],
        visualSuggestion: "“输入—处理—用户得到什么”流程图；待实现节点直接加文字标签。",
        durationSeconds: 40,
      },
      {
        title: "演示一条真实使用路径",
        write: [
          "选择一条已完成流程，列出输入、关键操作与实际输出。",
          "注明演示方式和数据来源；使用示例数据时写“示例数据”。",
          "准备同版本录屏或截图，以及失败时切换材料的步骤。",
        ],
        say: "从用户的任务出发演示，解释实际输出能帮助做什么。碰到未实现或失败的步骤时如实说明。",
        avoid: ["展示过多页面，留不出结果说明时间。", "把录屏说成现场运行，把占位结果说成真实调用。"],
        visualSuggestion: "放大关键界面，最多三处注释；备用材料沿用同一路径。",
        durationSeconds: 75,
      },
      {
        title: "现在有哪些验证证据",
        write: [
          "填写已有测试、观察或反馈的结果，并附样本、条件和来源。",
          "没有证据的效果标为“待验证”，写下一次准备怎样验证。",
        ],
        say: "区分已经看到的现象和仍在期待的效果，说明当前证据支持哪一条结论。",
        avoid: ["编造增长、准确率、节省时间或营收。", "把小样本结果扩展成所有用户都有效。"],
        visualSuggestion: "一到两条证据卡；只有真实测量时才画图，未知项直接写文字。",
        durationSeconds: 50,
      },
      {
        title: "交付范围与下一轮计划",
        write: [
          "分开列出已完成和待实现的能力，注明已知限制。",
          "选择下一项验证、必要条件和负责角色；未确定的时间写“待定”。",
        ],
        say: "解释当前可以尝试到哪一步，以及下一轮会先解决哪个最影响使用的问题。",
        avoid: ["把计划、意向合作或未确认排期写成已交付事实。", "承诺未经验证的上线时间或商业结果。"],
        visualSuggestion: "“当前可用—下一步—所需条件”三列；少用没有依据的进度百分比。",
        durationSeconds: 40,
      },
      {
        title: "希望得到什么反馈",
        write: [
          "重述本次最核心的价值目标，并提出一个具体问题。",
          "填写已核对的体验入口或联系方法，以及当前可试用的范围。",
        ],
        say: "邀请大家围绕那一个问题给反馈，用一个清楚的请求结束。",
        avoid: ["结尾临时新增产品方向。", "以保证效果或保证获奖作结。"],
        visualSuggestion: "一句价值目标、一个问题、一个入口，给听众留阅读时间。",
        durationSeconds: 30,
      },
    ],
  }),
  protectTemplate({
    id: "agent-technical",
    name: "5 分钟技术 Agent：过程可追溯",
    durationMinutes: 5,
    description: "用真实执行路径讲清 Agent 的输入、工具、权限和结果，适合技术实现与可信边界说明。",
    slides: [
      {
        title: "Agent 接受什么任务",
        write: [
          "填写目标用户、具体任务及期待得到的输出。",
          "注明当前是设计、原型还是已运行版本，列出本次演示范围。",
        ],
        say: "先说明这位用户要完成什么，Agent 在这次演示中负责哪一段。",
        avoid: ["用模型名称代替任务说明。", "把设计目标说成已完成能力。"],
        visualSuggestion: "一张任务卡：用户、输入、预期输出、当前阶段。",
        durationSeconds: 25,
      },
      {
        title: "输入、权限与边界",
        write: [
          "列出实际接收的数据、已接入的工具和允许执行的动作。",
          "标明需要用户确认的动作，以及未接入、未知或不支持的部分。",
        ],
        say: "告诉大家 Agent 能读取什么、在哪些步骤停下来交给人决定。权限或外部接入尚未验证时明确说明。",
        avoid: ["把界面上的按钮等同于已经获得权限。", "在演示材料中暴露密钥、私人数据或验证码。"],
        visualSuggestion: "输入、Agent、工具三块图；确认点和未接入点用文字标注。",
        durationSeconds: 35,
      },
      {
        title: "一次任务怎样流转",
        write: [
          "画实际实现的步骤：接收任务、生成建议、调用工具、核对结果。",
          "注明各步的存储或回执，以及失败后实际支持的恢复方式。",
        ],
        say: "沿着同一条路径解释每一步由谁负责；仅在设计中的组件另外标明，不让架构图混淆完成状态。",
        avoid: ["展示未实现的组件却不标注。", "把模型回复“成功”作为外部写入成功的唯一依据。"],
        visualSuggestion: "最多五个流程节点，旁边写实际输入输出；已有回执才标“已核对”。",
        durationSeconds: 50,
      },
      {
        title: "演示一次可追溯执行",
        write: [
          "选一个已经跑过的任务，依次展示输入、工具请求、实际回执和最终输出。",
          "区分真实调用、录屏、模拟或界面讲解；隐去敏感信息。",
          "准备相同版本的录屏或截图；结果未知时先核对状态。",
        ],
        say: "把建议和执行分开讲，停在实际获得的回执与输出上。出现失败或结果未知时展示真实状态和可用恢复方式。",
        avoid: ["用生成文字冒充工具回执。", "把模拟日志当成生产执行，或结果未知时重复触发同一动作。"],
        visualSuggestion: "左边演示，右边列“输入—调用—回执—结果”；日志只展示必要片段。",
        durationSeconds: 80,
      },
      {
        title: "如何判断任务做得对",
        write: [
          "填写实际测试任务、通过条件、样本范围和观测结果。",
          "列一个已知失败情况；尚未测试的准确率或性能写“尚未测量”。",
        ],
        say: "说明当前验证覆盖了什么、没覆盖什么，以及下一轮准备增加哪种失败场景。",
        avoid: ["凭一次成功宣称稳定或高准确率。", "编造基准分数、样本量、耗时或模型费用。"],
        visualSuggestion: "用“条件—实际结果—待验证项”短表；指标旁保留来源和测试条件。",
        durationSeconds: 50,
      },
      {
        title: "错误与成本怎样处理",
        write: [
          "填写已实现的超时、错误、人工接管或确认机制，未实现项标为待实现。",
          "成本只填写实际账单或 usage 记录；缺少记录就写“成本待测量”。",
        ],
        say: "讲清失败时用户能看到什么、可以怎样继续，以及已知的使用限制。成本未知时说明准备怎样测量。",
        avoid: ["把设计中的重试或预算控制说成已经生效。", "保证零成本、不会失败或绝对安全。"],
        visualSuggestion: "一条失败处理路径加一条成本说明；不用虚构仪表盘数字。",
        durationSeconds: 35,
      },
      {
        title: "下一项验证与交付入口",
        write: [
          "填写下一项最重要的验证或待实现能力，以及所需条件。",
          "给出已可访问的演示或代码入口，并说明目前开放的范围。",
        ],
        say: "用当前已完成的能力收束，再提出一个技术反馈问题，帮助下一轮验证。",
        avoid: ["结尾堆叠未确认的新集成。", "把路线图或未来部署状态写成当前交付。"],
        visualSuggestion: "当前成果、一项下一步、一个已核对入口；保持短而可读。",
        durationSeconds: 25,
      },
    ],
  }),
]);

export function getPptTemplate(id: PptTemplateId): PptTemplate {
  const template = PPT_TEMPLATES.find((item) => item.id === id);
  if (!template) throw new RangeError("未知 PPT 模板。请重新选择模板。");
  return {
    ...template,
    slides: template.slides.map((slide) => ({
      ...slide,
      write: [...slide.write],
      avoid: [...slide.avoid],
    })),
  };
}

/** Downloadable Markdown framework: no project data, AI call, or artifact state. */
export function templateMarkdown(id: PptTemplateId): string {
  const template = getPptTemplate(id);
  const lines = [
    `# ${template.name}`,
    "",
    "本站原创结构模板 · 手动填写框架，未调用 AI。",
    "导出为 Markdown（.md）文件，不是 PowerPoint（.pptx）文件。",
    "",
    template.description,
    "",
    `建议时长：${template.durationMinutes} 分钟，共 ${template.slides.length} 页。时间包含演示；如比赛另设问答，请另计问答时间。`,
    "",
    "使用前：用实际项目内容替换占位；分别标注已完成、待实现和证据待补；没有测量数据就写尚未测量。",
    "",
    "项目名：[填写]",
    "目标用户：[填写]",
    "本次演示版本与日期：[填写]",
    "",
  ];
  template.slides.forEach((slide, index) => {
    lines.push(
      `## ${index + 1}. ${slide.title}（${slide.durationSeconds} 秒）`,
      "",
      "### 写什么",
      "",
      ...slide.write.map((item) => `- ${item}`),
      "",
      "### 讲什么",
      "",
      slide.say,
      "",
      "### 视觉建议",
      "",
      slide.visualSuggestion,
      "",
      "### 避坑",
      "",
      ...slide.avoid.map((item) => `- ${item}`),
      "",
      "### 填入本页内容",
      "",
      "- 标题：[填写]",
      "- 页面要点：[填写]",
      "- 讲者备注：[填写]",
      "- 已完成 / 待实现 / 证据待补：[填写]",
      "- 演示方式与备用材料：[填写；本页无演示可写无]",
      "",
    );
  });
  lines.push(
    "## 上台前快速检查",
    "",
    "- [ ] 全程计时排练一次，演示与材料切换都计入时长。",
    "- [ ] 每条数字、引用和完成状态都有真实依据；未知项已注明。",
    "- [ ] 现场演示、录屏、模拟和界面讲解已经清楚区分。",
    "- [ ] 入口已核对，备用材料能打开，投影后字仍清楚。",
    "- [ ] 讲者和换页顺序已确认，问答材料另备。",
    "",
  );
  return lines.join("\n");
}
