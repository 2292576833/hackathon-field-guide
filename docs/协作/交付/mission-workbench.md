# 任务式团队协作工作台交付

日期：2026-10-09。依据宪法 v1.10.0 与规划19。本任务为主会话内部代理，只编辑以下五个临时授权文件；未修改既有组件、根路由、模块索引、实际迁移或配置。

## 已完成

- `src/components/space-mission-workbench.tsx`：工作台组合、三工作区、独立空间 AI 原生对话框。
- `src/components/space-mission-workbench.module.css`：暖白/炭黑/橙红视觉、44px主要操作、375px折行布局、键盘焦点、减少动效。
- `src/modules/space-workflow/mission-workbench.ts`：只读模型、真实可做/检查/等待任务、准备事项、成员正在做、检查通过与截止投影。
- `src/modules/space-workflow/mission-workbench.test.ts`：16项关键行为测试。

主工作区只有“我的下一步 / 团队任务 / 团队动态”。我的下一步优先等本人检查的成果，再已有正在做或可开始的任务；展示交付物、检查条件和按任务种类已有工具。任务详情与实际操作仍进入原任务板，不产生游戏任务副本。等待时只显示实际独立、已排程、依赖满足的本人任务；没有任务时要求与管理员核对分工，不虚构可做项。单人不必招满队员，不强制做测评。

团队任务中按真实检查记录展示必做、可选和删减数量；必做为零不会判全板完成。全部必做任务检查通过后进入当前版本运行、材料和正式提交核对，仍不认定整场成功。成员摘要展示当前活跃成员的“正在做”任务、可检查交接与本人负责成果的通过数量，不显示能力排名。归档空间只供回顾。

三工作区保持挂载，仅切换 `hidden`，因此任务与动态面板的本地草稿不会因切页被销毁。箭头/Home/End控制可聚焦的tab；空间助手使用原生 `dialog.showModal()`，Escape和关闭按钮可返回焦点，助手首次打开后保持挂载，关闭再打开保留本地输入。该组件不生成AI答复，也不复制导航员对话；记忆来源与读写由主会话/R03提供。

## 导出与根接入

直接从组件文件导入：

```ts
import { SpaceMissionWorkbench } from "./space-mission-workbench.tsx";
```

```ts
interface SpaceMissionWorkbenchProps {
  detail: SpaceDetail;
  current: CurrentPlanningView | null;
  planningLoading?: boolean;
  planningError?: unknown;
  preparation?: MissionPreparation;
  taskBoard?: ReactNode;
  teamFeed?: ReactNode;
  assistant?: ReactNode;
}
```

`taskBoard`、`teamFeed`、`assistant` 由主会话注入真实业务组件；不直接导入未完成的 R02/R03。未注入任务或动态面板时显示真实待接入说明及现有任务页，不展示假记录。未注入助手时不显示助手按钮。主会话需以本组件替换原 `SpaceTaskSummary` 的主组合；旧长指引、详细树、资料和设置由根另行折叠保留，不重复铺满主工作区。

纯模型直接导入：

```ts
import { buildMissionWorkbench, missionTaskChecked } from
  "../modules/space-workflow/mission-workbench.ts";
```

`MissionPreparation` 可由根提供以复用读取：

```ts
interface MissionPreparation {
  rules?: ReadState<SpaceRules>;
  tracks?: ReadState<ProjectOfficialTracksView>;
  intention?: ReadState<MyIntentionView>;
  availability?: ReadState<{
    availability: MemberAvailability | null;
    confirmationRequired: boolean;
  }>;
}
```

若完全不传 `preparation`，组件只读四个已有GET：

- `/api/v1/projects/:id/rules`
- `/api/v1/projects/:id/official-tracks`
- `/api/v1/projects/:id/my-intention`
- `/api/v1/projects/:id/my-availability`

提供 `preparation` 时不会再次发起这些GET；省略字段表示尚未读取。组件收到同项目 `hackathon:project-input-changed` 或项目revision变化才复核自己的准备读取，不轮询付费服务，不发POST。当前任务周期读取、未知响应恢复和业务输入保留由注入任务板及根组合负责。

本人职责与时间仅当 projectId、userId、membershipRevision 与当前身份相符时才作为已保存准备事实；未提供、错误或旧成员版本均不能当已确认。规则/赛道投影复用已有详细树版本与证据检查。生效计划的任务投影需要本空间、活跃本人身份、应用状态；推荐开始需要当前校验、输入未变化、实际排程和前置成果检查。普通进度导致的 `staleInputs` 不等同于输入变更；`inputVersionsChanged` 会阻止开始建议。纯模型不会变更输入。

## 已验证

命令：`node --experimental-strip-types --test src/modules/space-workflow/mission-workbench.test.ts`。

16/16：单人准备、未知/加载/失败、草案不当生效、跨项目/退出成员过滤、检查者权限、自检、并行/阻塞、伪完成/错误检查不解锁、可选删减分开、无排程/无负责人/缺失依赖、版本变化与普通进度区分、已知规则/赛道需复核、私人意愿/时间归属、成员工作摘要、归档、无必做不全亮、时区依据、输入不变。

`npm run typecheck` 在本轮共享目录未通过：当次错误位于 `src/modules/recruiting/service.ts:165`（unknown到string）、`src/modules/team-collaboration/TeamFeed.tsx:154`（撤回tombstone缺canWithdraw），没有本任务新增文件诊断。未越界修复；最终全局typecheck由主会话收敛后执行。

交付前第二次复查中 recruiting 诊断已消失；仍有 TeamFeed 上述错误，以及主会话正在接入的 `src/server/team-mission.ts:116`（共享建议 DTO 的 authorUserId/body 字段映射）。仍没有工作台文件诊断。这些为当时并行编辑状态，不作为其他模块最终结论。

## 未验证与边界

- 没有build/start、真实迁移、生产写操作、付费模型调用或依赖安装。
- 样式和键盘结构已实现，但375px/桌面的真实页面、native dialog、邀请锚点、各slot结合以及输入跨tab保留尚需主会话生产构建与浏览器验收。
- 测试为纯事实投影，不等同实体手机、人类理解、实际项目可行性、真实DSH答复、模型记忆或主办方提交成功。

## NEEDS_INTERFACE

无需新增服务契约、迁移或环境变量。根需注入现有M05任务板和新R02动态、新R03本人空间助手，保留原导航员入口；接入AI记忆范围说明/共享与权限应来自真实R03及根适配，而不是由工作台文案冒充读取结果。

本轮授权工作交付后停止编辑，文件交还主会话；后续浏览器修复需新授权。
