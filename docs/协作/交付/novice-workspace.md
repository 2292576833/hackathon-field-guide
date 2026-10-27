# P03 新人私人工作区减负交付

日期：2026-10-11。依据宪法 v1.14.0、规划23及本轮主会话临时授权。

## 已完成

- `src/components/projects-client.tsx`：`/app` 按当前可读空间区分未登录、读取失败、无空间、单个空间、多个空间及仅归档空间。未登录以登录为主；无空间以创建为主；单个空间直接继续或回顾；多个空间明确选择。没有用列表顺序推测最近项目，没有用阶段推断任务或报名完成。带入比赛线索保留原 `event` / `discovery` 上下文；仅有归档空间时引导新建，不引导写入归档空间。
- 创建表单默认按需展开，`#create-project` 仍可直接打开；有本人填写、发送中或创建失败时保持展开，错误在折叠外显示。已填写内容可由本人明确清空。作品目标及时间可以稍后补充，原创建请求字段与服务器规则保留。
- 正式报名与私人空间分别显示。`/me/competitions`、`/competitions` 入口保留为第二层，没有读取报名事实就宣称本人已报名。
- `src/components/project-workflow.tsx`：个人出行、路演、PPT、画像与经验收在一个默认关闭的辅助区，每个入口简短解释用途；个人建议不替代团队生效任务。固定队伍仍按需打开。
- `src/components/space-lifecycle.tsx`：完整指引树与阶段工具默认收起，原“我的下一步”工作台继续作为主要行动来源。规则/赛道读取错误、赛道规则需复核在折叠外显示，可就地重新读取或回原比赛页。
- 目标与阶段设置的错误和保存回执移到折叠外；未保存填写保持展开。没有新增任务、完成、权限或报名状态。
- 新 `src/components/novice-workspace.module.css`：独立样式、44px 操作目标、手机换行、长空间摘要收短；未修改共享 CSS。

## 保留的入口与事实

`/app`、`#create-project`、全部原项目页面、`/participation`、`/roadshow`、`/ppt`、`/app/account#participant-profile`、`/app/experience`、`/app/teams`、`/recruiting`、`/journey`、正式赛事入口仍可达。任务/检查/阻塞、常驻邀请、队友动态、私有 AI 对话及本人导航记忆均由原组件/服务承担。此次没有改写工作台任务投影、主办方/评委权限或 AI 上下文与共享逻辑。

## 已验证

- `node node_modules/typescript/bin/tsc --noEmit --incremental false`：退出0，无类型错误。最初 `npm run typecheck` 的 `tsc` 命令 shim 不可用，改用已安装 TypeScript 的真实入口验证，未安装依赖。
- `node --experimental-strip-types --test src/modules/space-workflow/service.test.ts src/modules/space-workflow/guide-tree.test.ts src/modules/space-workflow/mission-workbench.test.ts`：60/60通过，包含权限/跨空间、未知读取、旧计划、依赖、真实检查、归档及正式提交不可推断规则。
- 源码核对：读取失败不当作无空间推荐；单个空间不重复铺满同一张空间卡；规则错误和保存回执在折叠外；有未保存填写的创建/目标/阶段表单不能被折叠隐藏。

## 只读审查发现的下一批优先点

以下未修改，供根决定后续范围；具体组件和文件已核对，不据规划猜测功能缺失。

1. **规则页缺少唯一当前动作。** `src/components/project-client.tsx` 的 rules 组合与 `src/components/discovery-client.tsx:58` 的 `RulesPanel` 顺序铺开项目线索、完整已确认规则、版本差异、选新版本，再接官方赛道和 `src/components/rule-analysis-client.tsx:15` 的完整人工/AI分析表单。建议根据原确认/差异事实突出“选择并核对规则”或“核对更新”；当前资格、费用、截止、必交项保留可见，历史/换赛事/人工分析按需展开，不隐藏正在编辑的内容。
2. **分工和排程首次设置同时展示太多建立方式。** `src/components/planning-client.tsx:44` 的 `AssignmentPanel` 同时展示AI、当前分工、历史草案和人工任务表；`PlanPanel:94` 首次会展开AI、保存草案、历史恢复、新计划与具体编辑。低成本用当前草案事实决定一个“继续草案/建立安排”动作，AI与人工采用本地标签切换且保留挂载输入，历史默认收起。普通成员优先本人职责/时间，管理员再做校验确认；保留分工和任务计划分别确认的业务事实。
3. **展示材料入口先要求读教程，自己的作品在后面。** `src/components/roadshow-client.tsx:182` 的案例与时间讲解排在 `:195` 私人讲稿表单前；`src/components/ppt-client.tsx:94` 的模板全套逐页说明排在 `:115` 作品工作区前。带 `projectId` 或恢复本人记录时优先当前来源、填写/继续编辑；案例、模板细节、工具收在辅助区。保留本人明确采用空间资料、私人保存、provider:dsh与未知请求恢复。
4. **名片入口有重复位置和回跳。** `src/components/recruiting-client.tsx:11` 已有同页名片编辑器，`RecruitingLobby.tsx:135` 的“准备我的名片”却跳 `account#recruiting-profile`，账号页又放同一编辑器；`RecruitingProfileEditor.tsx:175` 的时间/技能修改继续跳账号。建议大厅主按钮就地展开现有编辑器，修改本人资料后回到原组队场景；公开快照预览、明确发布/撤回、审核后本人确认加入不变。

## 限制与 NEEDS_INTERFACE

- 本次检查为源码、类型和既有纯行为测试；没有执行生产构建、启停服务、生产数据库、模型/邮件/GitHub调用，没有宣称已部署、实体手机或真人理解测试通过。
- 根负责最终320/390px与桌面浏览器、键盘焦点、登录原去向、创建/归档/错误恢复及跨角色验收。
- NEEDS_INTERFACE：无；此次纯展示复用原接口，不需要迁移或新环境变量。
- 已读规划13/17/18/19/20/23与私人工作区相关代码。该审查覆盖本代理分派范围，不代表每个全站文件都由本代理逐行读过。

## STOP

已完成本轮交付并停止修改。上述3个组件、独立CSS及本交付文件全部交还主会话；本轮授权结束。
