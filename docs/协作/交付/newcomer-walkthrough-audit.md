# 萌新团队空间 · 只读流程审查

日期：2026-10-12。依据`docs/协作/画布交互与萌新走查-2026-10-12.md`，只读本轮当前源码。以下是可从渲染分支和链接确定的问题，以及明确标出的新人理解风险；不是本人实际浏览器走查或用户访谈结果。真实页面走查由主会话负责。

主会话已确认并正在修复邀请节点错表单/双模态、报名节点加载整套规则组件、分工/计划节点重复职责时间表单，本报告不重复列为新问题。

## 1. 无正式规则时，推荐入口仍停在“确认要求”，内部准备路径藏在计划页

**优先级：P1；建议先在规则空状态补一个明确出口。**

- 具体场景：首次创建空间，目标已保存，但平台还没有已发布赛事，或只保存了一条自动发现线索。规则选择处显示“当前没有已发布赛事可选。赛事入库需要真实来源和人工审核”，新人没有权限自己把线索变成正式规则。
- 源码依据：[discovery-client.tsx:95](F:/黑客松情报局/src/components/discovery-client.tsx:95)、[discovery-client.tsx:97](F:/黑客松情报局/src/components/discovery-client.tsx:97)。[guide-tree.ts:199](F:/黑客松情报局/src/modules/space-workflow/guide-tree.ts:199) 在规则/赛道未满足时一直推荐 rules；但[planning-client.tsx:123](F:/黑客松情报局/src/components/planning-client.tsx:123) 明确允许“没有正式赛事时，手填截止仍可作为内部目标”。[facts.ts:173](F:/黑客松情报局/src/server/facts.ts:173)、[facts.ts:195](F:/黑客松情报局/src/server/facts.ts:195) 也分别保留规则未知假设和成员手填目标截止。
- 新人理解风险：“我已选了比赛，为什么还是不能确认？是不是所有工作都要等平台审核？”现有内部准备能力没有在当前受阻处呈现。
- 低改动建议：在已发布赛事为空/无可确认规则处给出两个明确去向：“先设置团队目标时间并人工安排任务”和“继续核对赛事原文，等待正式规则发布”。保留线索与正式规则的区别，不自动升格发现结果，不绕过赛道选择、计划校验或正式提交要求。
- 根走查重点：无正式规则、无发现线索和仅有发现快照三种状态；确认新人能找到内部准备路径，且界面继续说明资格、官方截止和正式提交仍待核对。

## 2. 缺截止时的“先填写团队截止”只回到画布，未打开实际填写处

**优先级：P1；这是具体的入口落点问题。**

- 具体场景：建空间时把允许暂空的完成时间留空，之后进入任务计划。计划保存按钮因没有截止点禁用，提示里的“先填写团队截止”链接仅为`/app/projects/<id>`。
- 源码依据：[planning-client.tsx:123](F:/黑客松情报局/src/components/planning-client.tsx:123) 的链接与[planning-client.tsx:132](F:/黑客松情报局/src/components/planning-client.tsx:132) 的保存禁用条件。真正时间输入在[projects-client.tsx:138](F:/黑客松情报局/src/components/projects-client.tsx:138)；它属于`ProjectGoalForm`，[space-path-canvas.tsx:329](F:/黑客松情报局/src/components/space-path-canvas.tsx:329) 只在 goal 节点打开时才渲染。主页常驻的“空间设置与历史记录”是另一组件，[project-client.tsx:54](F:/黑客松情报局/src/components/project-client.tsx:54)、[project-client.tsx:55](F:/黑客松情报局/src/components/project-client.tsx:55) 并未常驻目标表单。
- 新人理解风险：返回画布后，需要自行猜出“写清作品目标”节点也管截止，修改后还要再找回计划页。
- 低改动建议：把该入口连接到现有`openNode("goal")`并明确文案“打开作品目标与团队截止”；跨页返回时可携带一个由画布 opener 实际识别的锚点/意图，再回原计划。**不能只拼`#project-goal`就认为修好**：[project-client.tsx:30](F:/黑客松情报局/src/components/project-client.tsx:30) 当前只查已存在的DOM，关闭流程弹窗时目标表单尚未挂载。
- 根走查重点：完成目标已填、截止为空的空间，从禁用保存按钮旁的链接起步，直接到日期输入并返回保留的计划输入。

## 3. “建议先做”固定选阶段第一个节点，未必是当前真正缺的行动

**优先级：P2；涉及重复填写的提示风险。**

- 具体场景：规则和官方赛道均已对齐，本人已保存职责和时间，但尚无生效计划。树的下一步是查看/确认任务计划，画布却把该阶段第一个行动“选职责，填时间”标成建议先做。
- 源码依据：[guide-tree.ts:200](F:/黑客松情报局/src/modules/space-workflow/guide-tree.ts:200) 生成 plan 下一步；[space-path-canvas.tsx:274](F:/黑客松情报局/src/components/space-path-canvas.tsx:274)、[space-path-canvas.tsx:291](F:/黑客松情报局/src/components/space-path-canvas.tsx:291) 无条件以`steps[currentStep].nodes[0]`决定高亮。另外[guide-tree.ts:116](F:/黑客松情报局/src/modules/space-workflow/guide-tree.ts:116) 仅从生效计划快照取本人时间，没有计划时不能反映已单独保存的最新时间。
- 新人理解风险：“我刚保存成功，为什么还叫我先填时间？是不是没保存？”这不是保存失败，而是指引投影和真实本人记录读取来源不同。
- 低改动建议：让推荐指向具体待处理行动ID，或暂不对阶段第一个行动加“建议先做”；使用已有本人意愿/可用时间读取事实派生，不另存进度。没有当前时间读取依据时，改为“查看已保存的职责与时间”，避免暗示需要重新填写。
- 根走查重点：保存职责与时间后计划仍为空，以及计划已有但赛道需重新核对，两种状态下推荐应指向实际缺项。

## 4. 首份计划缺少必备用途时，校验直接向新人显示英文内部类别

**优先级：P2；小改动即可改善定位与解释。**

- 具体场景：新人只建了一个“做首页”的功能任务，保存校验后缺联调/测试/材料/提交准备。本站在无正式赛事的内部计划中也要求这些最低准备类别。
- 源码依据：[facts.ts:200](F:/黑客松情报局/src/server/facts.ts:200) 固定最低`requiredTaskKinds`；[rules.ts:400](F:/黑客松情报局/src/modules/planning/rules.ts:400) 错误文案插入原始`kind`，如`integration`、`material`、`submission`。[planning-client.tsx:113](F:/黑客松情报局/src/components/planning-client.tsx:113) 直接显示`issue.message`，虽然[planning-client.tsx:123](F:/黑客松情报局/src/components/planning-client.tsx:123) 和[planning-client.tsx:132](F:/黑客松情报局/src/components/planning-client.tsx:132) 另有中文类别和添加按钮。
- 新人理解风险：不理解英文错误与“增加集成任务”等按钮的对应关系，也可能误以为没有确认官方规则就必须向外部平台正式提交。
- 低改动建议：错误使用同一中文类别映射，并给一句具体例子：集成→“把页面和接口连起来试一次”，材料→“准备演示说明、PPT或视频”，提交准备→“打包并核对要交的文件”。同时说明这是本站准备清单，实际比赛必交材料及外部提交仍按官方规则核对。保留必需任务、估时与依赖校验，不通过假任务或删门槛消掉错误。
- 根走查重点：只建一个功能任务后的错误是否能直接对应到需要补的任务用途。

## 5. 首次无任务时，历史恢复与任务ID输入出现在新建入口之前

**优先级：P2；属于首屏排序和术语负担，不是服务端死锁。**

- 具体场景：第一次打开任务计划，无历史、无草案、无任务。页面先展示AI及其恢复区，再展示“继续已保存的计划草案”“从历史生效计划恢复草案”，随后才是“建立新的计划草案”和增加任务。
- 源码依据：[planning-client.tsx:95](F:/黑客松情报局/src/components/planning-client.tsx:95)、[planning-client.tsx:96](F:/黑客松情报局/src/components/planning-client.tsx:96)、[planning-client.tsx:114](F:/黑客松情报局/src/components/planning-client.tsx:114)。[planning-ai.tsx:15](F:/黑客松情报局/src/components/planning-ai.tsx:15) 常驻“恢复查看已有分工生成任务 ID”；[planning-ai.tsx:22](F:/黑客松情报局/src/components/planning-ai.tsx:22) 还有已有AI计划任务、已审核资源ID输入。
- 新人理解风险：“我没有这些ID和历史，要先弄到它们才能创建任务吗？”这些不是新建必填条件，但版面让它们抢在第一次创建之前。
- 低改动建议：无现有计划时优先显示“增加第一个任务 / 带入已确认分工 / 请AI拟草案”。仅有历史或用户主动展开时显示历史恢复和手输ID；真正进行中、失败/未知结果的恢复入口继续显著保留。资源选择尽量用现有目录名称入口，手输ID收为高级项。
- 根走查重点：零任务的管理员与普通成员分别进入；前者能直接找到新建，后者清楚下一步由管理员确认而非寻找ID。

## 6. 新交接的四项必填默认折叠，首先可见的输入却都标“选填”

**优先级：P2；本会话上一轮交接实现也有这项体验缺口。**

- 具体场景：负责人点击“提交成果，请队友检查”开始新交接。四项交接详情默认关闭，外面看到“补充说明（选填）”“额外成果依据（选填）”及提交按钮。用户可能先点提交，然后才获知四项必填。
- 源码依据：[team-task-board.tsx:261](F:/黑客松情报局/src/components/team-task-board.tsx:261) 默认`handoffOpen=false`，[team-task-board.tsx:347](F:/黑客松情报局/src/components/team-task-board.tsx:347) 受控折叠；[handoff.ts:36](F:/黑客松情报局/src/modules/space-workflow/handoff.ts:36) 新交接要求四项非空，[team-task-board.tsx:311](F:/黑客松情报局/src/components/team-task-board.tsx:311) 在失败后才展开，[team-task-board.tsx:355](F:/黑客松情报局/src/components/team-task-board.tsx:355) 的外部说明标选填。
- 低改动建议：保持任务卡平时收起；用户明确进入“新交接”编辑时直接展开四项，或至少在折叠摘要上写“新交接必填，点此展开”。历史交接补充仍可收起且原样保存。继续保留四项校验、旧输入、CAS和同请求恢复，不以放宽保存门槛解决发现性问题。
- 根走查重点：第一次交PPT或设计稿的用户，在首次提交前即可知道要写位置、版本、打开和检查方法。

## 边界与交还

以上6项依据当前源码分支/字段/链接，行号为本轮读取时位置；主会话并行修改可能使行号移动，可按文中标识符定位。没有运行浏览器、模型、数据库、构建或服务操作，没有修改任何代码、配置、公共文档或之前交付，仅新建本报告。

**STOP：只读审查交付完成，停止编辑，报告交还主会话。**

## 同日新授权 · 问题4/5/6修复交付

主会话在上述只读STOP后重新授权本轮代码修复，仅编辑`planning-client.tsx`、`planning-ai.tsx`、`team-task-board.tsx`、`planning/rules.ts`，新建`planning/task-kind-labels.test.ts`，并追加本节。其它流程、规则入口、根页面和服务文件没有修改。

### 已完成

- **问题4**：`rules.ts`缺必需任务类别的说明使用中文，如“计划缺少「集成」必须任务”，建议明确对应“增加集成任务”按钮，并给出连通页面/接口、准备PPT或视频、打包核对文件等例子。`planningTaskKindLabels`供原计划表单和错误提示共用，八类名称一致。只改变显示说明；必做、用途、已删减、依赖、工时、资源与权限约束保持原样。
- **问题5**：无待采用草案/历史计划时，分工和计划的恢复目录改为高级折叠。已有待采用草案、历史选择、未确认的恢复请求或目录错误仍展开可查；选择和已有输入不清空。AI分工的手输恢复ID、AI计划的已有请求目录和资源ID移入高级项；首次创建不需填写ID。已知请求、请求错误、目录错误及已有计划请求会展示恢复入口，实际`JobProgress`继续留在折叠之外；新增已有计划请求按钮仅做原目录GET。请求状态用中文显示。
- 保留原生成、载入确认、取消、失败版本重试和原版本字段。未知执行/明确UNKNOWN结果下，计划重试按钮禁用且显示先刷新核对说明，服务端规则没有改动，也没有自动重发或重新生成。
- **问题6**：负责人进入新的“提交成果，请队友检查”编辑时即展开四项，不必先失败一次。任务卡平时仍收起；历史review补充、进度/验收更正、收起保留输入、CAS和原请求恢复沿用原行为。
- **问题2的本会话部分**：计划页“没有已知截止点”处改为“打开作品目标与团队截止”，目的地为`/app/projects/<encoded id>#project-goal`。真正打开goal表单和回到任务计划由主会话实现；本会话没有把单纯拼hash宣称为跨页流程已通过。

### 验证

1. `node --experimental-strip-types --test src/modules/planning/task-kind-labels.test.ts src/modules/planning/rules.test.ts src/modules/space-workflow/handoff.test.ts`：**39/39通过**。新增4项验证八类中文与按钮名称对应、联调/材料/提交例子、可选及已删减任务仍不满足必需类别、未知用途仍拒绝；原24项规划规则和11项交接测试回归通过。
2. `node node_modules/typescript/bin/tsc --noEmit --incremental false`：**最终全项目退出0**，无类型错误。
3. 实际`TaskActions`及恢复面板的隔离Edge/Playwright回归通过：新交接首次展开、缺项不发请求、收起保留、409保留输入/CAS、未知结果禁用输入且核对同body/幂等键、旧交接带入与原样保存、归档只读。API为测试替身，没有写实际数据库。该次夹具：`C:\Users\27736\AppData\Local\Temp\c02-handoff-oujMiX`，脚本仍为`C:\Users\27736\AppData\Local\Temp\c02-handoff-browser.cjs`。
4. 实际`PlanPanel`/`AssignmentPanel`/`PlanAi`/`AssignmentAi`的React渲染，加Edge DOM检查通过：375px首份计划无横溢、空历史/手输ID/资源ID默认折叠、增加任务按钮可见、截止链接准确、四种默认准备类型名称与添加按钮一致、queued/running及UNKNOWN失败记录的请求目录展开、未完成草案/已有历史恢复展开、目录错误可见。数据读取及与本轮无关的子组件使用替身，此项是渲染/DOM验证，**不是完整计划请求或真实AI执行验证**。脚本：`C:\Users\27736\AppData\Local\Temp\c02-planning-review.cjs`。

没有构建或重启网站、安装依赖、修改配置/迁移、访问生产数据库或调用真实模型。主会话正在隔离review build整体验收；本会话代码在其提醒后没有新增修改，仅完成验证与本交付说明。

### 根验收边界

- 主会话负责`#project-goal`实际打开与回到计划的联动，以及问题1/3、已确认的节点错表单/双模态修复。
- 保留现有生成请求和未知费用hold；本轮没有新做AI发起请求的跨刷新幂等恢复，不把高级目录折叠当作其已验证。
- 真实页面、完整计划创建/分工应用、AI请求回执和生产构建/发布由主会话验收。无新增接口、环境变量或迁移需求。

**STOP：本轮修复与验证交付完成，代码稳定，停止编辑，以上文件交还主会话。**
