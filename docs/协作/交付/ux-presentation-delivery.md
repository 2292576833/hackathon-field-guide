# U03 展示材料与代码提交交付

日期：2026-10-09。依据宪法 v1.4.0、U03 规划和本轮文件授权。最新用户命名已落实为“团队空间”；底层仍为 Project、原路由和原业务状态，没有新增空间实体。

## 已完成

- 讲稿与 PPT 页使用连续的“准备讲稿 → 整理 PPT 大纲 → 检查代码与提交”入口。`projectId` 只保存团队空间返回位置，登录返回、讲稿继承和下一步链接均保留该位置；不把私人内容放进 URL，不根据 URL 自动读取项目事实。
- 新增可组合的 `PresentationProjectEntry`，已放到当前空间的仓库操作区。独立 `/roadshow`、`/ppt`、`/github` 页面保留。
- 讲稿页只先展示四项必填输入，计划、技术、依据等选填内容折叠。新增独立 `plannedCapabilities`，旧输入与旧稿省略时兼容为空。PPT 选定本人讲稿后隐藏重复的项目表单，只选择本次结构与时长；服务器仍从本人历史读取并继承已保存输入。
- 新增 `PresentationProjectPicker`：明确选择空间 → 读取有权限的有限资料 → 预览完成/计划/依据 → 明确确认替换对应输入。允许补充私人材料输入。解除引用保留已输入文字并明确转为本人自述；不会删除或重写旧稿。
- 模块新增注入式 `PresentationProjectContextPort`，仅接受浏览器 `projectSource:{projectId,revision}`，拒绝浏览器快照/owner。生成重新读取服务器事实，来源另存 `sourceProject`；个人编辑内容仍存原 `input`/`inputSnapshot`。项目更新不改变历史快照。严格来源生成与旧路演继承分别复核当前权限和版本规则。
- 生成 guard 组合原请求会话检查与项目检查；请求身份排除来源读取时间 `capturedAt`，同版本重复读取不能靠时间戳绕过未知付费请求 hold。已有未知状态不自动重发，不改变预算。
- GitHub 图形分支教程保留，带 `projectId` 时经现有服务器项目接口复核权限后显示当前团队空间与返回操作锚点。登录本站、本人 GitHub 账号授权、仓库授权和绑定仍清楚说明。
- 仓库摘要统一由 `RepositoryPanel` 提供，`DeliveryPanel` 默认不重复请求和展示仓库摘要；独立组合需要摘要时可传 `showRepositorySummary={true}`。代码变更预览/确认不跳过，未知操作与 PR 状态有中文说明。保存代码、运行检查、主办方正式提交仍为三个独立事实。
- PPT 工具卡片继续使用唯一 `PPT_TOOLS` 数据源，新增工具与资料入口。导出仍明确为 Markdown 和可打印 HTML，未声称生成 PPTX。没有维护第二份同名制作工具说明。

## 文件

组件：

- `src/components/presentation-workflow.tsx`（新增）：流程、链接与空间资料选择/预览/来源摘要。
- `src/components/roadshow-client.tsx`、`ppt-client.tsx`：输入复用、来源显示、历史恢复、返回位置、减少重复输入。
- `src/components/github-guide.tsx`、`repository-client.tsx`、`delivery-client.tsx`：空间操作与图形教程、仓库摘要去重、三事实及下一步。
- `src/components/roadshow.module.css`、`ppt.module.css`：各自独立样式；未改共享 CSS。

模块共13文件：`src/modules/roadshow/{project-context.ts（新增）,project-context.test.ts（新增）,types.ts,validation.ts,service.ts,index.ts,roadshow.test.ts,README.md}`；`src/modules/ppt/{domain.ts,validation.ts,service.ts,export.ts,README.md}`。未改 server/shared/app、真实迁移、根配置、依赖、lockfile 或 U02/U04 文件。

## 已验证与模拟边界

- 最后一次 `npm run typecheck -- --incremental false` 通过。中途一次检查曾看到 U02 正在编辑的 `assessment-client`/任务板/planning 报错；未越界修复，后续检查已通过。
- M06 五个既有模拟回归文件合计 93/93 通过：`git-service.test.ts`、`delivery.test.ts`、`delivery-summary.test.ts`、`authorization-service.test.ts`、`repository-creation.test.ts`。这些测试不证明真实 GitHub 写入。
- `node --experimental-strip-types --test src/modules/roadshow/*.test.ts src/modules/ppt/*.test.ts`：58/58通过，其中新增8项项目来源规则测试，覆盖权限、版本变化、历史继承、输入快照、计划不能升格完成、未知请求身份等规则。所有AI/存储/SQL executor使用替身；不代表真实事务并发或付费服务验收。
- GitHub组件另做3/3临时TSX模拟验证，覆盖未知响应保留输入、空间核权导航及摘要去重；没有新增根测试文件。
- 用真实组件的静态 React 渲染、替身资料和本机 headless Edge 做 375px/1280px 离线布局检查，长中文来源摘要无横向溢出，检查的按钮/select/步骤链接最小高度 44px，并查看两张截图。此检查没有访问运行中网站或调用根接口，不代表真实手机/登录/DSH/GitHub贯通验收。
- 离线截图保存在 `C:/Users/27736/.codex/visualizations/2026/10/09/01a12017-966b-7751-a332-8a61329fef83/u03-workflow-375.png` 与 `u03-workflow-1280.png`。

## 未接入与真实未验收

根应用尚未注入项目上下文 Port 与只读 API，现有页默认明确显示“空间资料复用接口尚未接入”，仍可独立填写或继承本人路演；不会静态伪造已使用团队事实。主会话需完成以下 NEEDS_INTERFACE，再贯通服务器与页面。未构建、重启、发布、执行迁移或读取 `.env.local`，未打开嵌入式数据库目录，未发邮件/验证码、付费模型请求或真实 GitHub 写入。

## NEEDS_INTERFACE

公共契约由 `src/modules/roadshow/index.ts` 导出，完整字段与限额见该模块 README：

```ts
interface PresentationProjectSelection { projectId: string; revision: number }
interface PresentationProjectSnapshot extends PresentationProjectSelection {
  schemaVersion: 1;
  projectName: string; projectIdea: string; targetUsers: string; problem: string;
  completed: string[]; planned: string[]; evidence: string[];
  capturedAt: string;
}
interface PresentationProjectContextPort {
  readSnapshot(actor: Actor, projectId: string, guard?: FreshSessionGuard): Promise<PresentationProjectSnapshot>;
  assertCurrent(actor: Actor, selection: PresentationProjectSelection, sql: SqlExecutor): Promise<void>;
  assertCanGenerate(actor: Actor, projectId: string, sql: SqlExecutor): Promise<void>;
}
```

1. 根应用在 `createRoadshowService` 与 `createPptService` 注入同一 `projectContext`。Port 必须通过 M02/M05/M06 的公共接口组合有限事实，不读取跨模块私有表；只在已复核当前账号、原请求会话和活跃 ProjectMembership 的同一个事务中返回事实。普通活跃成员可为本人材料读取这些有限事实；没有空间权限时 403 或隐去存在性的 404。归档空间禁止新生成。
2. `revision` 必须对应所有用于生成的事实版本：目标/范围、成果、计划和依据发生变化时都会改变。不能仅用不覆盖任务/成果变化的 `Project.revision`。`assertCurrent` 必须在传入的同一 `SqlExecutor` 中复核当前会话/账号/成员、未归档和版本；根需保证原 `PersonalAiPort.generate` 在付费请求前与结果落库事务中执行组合 guard。排队期间成员退出、被移除、归档或版本改变不能保存旧结果。
3. 直接 `projectSource` 采用严格版本匹配；本人主动选择旧路演 `artifactId` 时继承当时已保存的来源快照，并用 `assertCanGenerate` 复核现在仍有活跃权限且未归档，不强制把旧稿换成新资料版本。历史 `get/list` 继续只按本人记录归属读取，不自动更新旧稿。PPT 的 `artifactId` 与 `projectSource` 互斥。
4. 根注册登录只读且 private/no-store 的 `GET /api/v1/me/presentation-projects/:projectId`（示例路径，可换 basePath），返回普通 `{data:PresentationProjectSnapshot,requestId}`。读取不收费、不生成、不写预算；`capturedAt` 由服务器设定。`projectIdea/problem` ≤2000 字、`targetUsers` ≤1000 字，可空；名称≤120字；三组数组各≤12项/项≤600字。超过边界不能静默丢失资料，应给可恢复错误；讲稿单字段最多3000字，UI会拒绝将过长数组直接带入该字段并保留原输入。
5. 根页面只在注册接口后传序列化配置：`<RoadshowClient projectContextApi={{basePath:"/me/presentation-projects"}}/>`、`<PptClient projectContextApi={{basePath:"/me/presentation-projects"}}/>`。可另传 `projectId`；也支持原查询参数。仅配置 API 而未注入服务 Port 仍会返回真实未接通错误。
6. `completed` 必须来自既有明确成果事实；任务计划、AI 建议、代码已保存不能自动变成“已运行/已完成/已正式提交”。`planned` 单独归类。缺失目标用户/问题返回空文本让本人补充，不能 AI 补造。不得返回完整代码/规则、私人画像、测评原文或其他人的材料。
7. 稳定错误：`UNAUTHENTICATED` 401；权限403/404；`PROJECT_ARCHIVED` 409；`PROJECT_CONTEXT_CHANGED` 409 + latestRevision；`PROJECT_SOURCE_INVALID`/`PROJECT_COMPLETION_NEEDS_REVIEW` 422；`PROJECT_CONTEXT_INVALID` 502；`PROJECT_CONTEXT_UNAVAILABLE` 503。`PROJECT_CONTEXT_UNAVAILABLE` 在 UI 作为未调用模型的已知失败，可解除引用；任何实际付费未知结果继续走既有防重发/hold，不输出模型原文、私人快照或凭据。

示例：成员确认空间资料版本3，队友在等待生成期间更新所用计划/成果至版本4；落库 guard 拒绝旧请求，不保存旧结果，页面保留输入让用户重新读取。已保存的本人版本3稿件不受影响。

GitHub 三组件无新增根接口。现有项目页面组合 `RepositoryPanel + DeliveryPanel` 可直接使用默认去重行为；如果根只展示 `DeliveryPanel`，按需要显式启用摘要。源文档/生成记录继续复用既有个人 JSON 存储，U03没有新增实际迁移需求。

## 环境与交还

没有新增环境变量。实际 DSH、GitHub 与数据库继续由根应用配置；本报告不包含任何值。

2026-10-09 最终交付：两个内部子代理均已停止编辑并交还，U03会话在保存本报告后也停止编辑。授权文件已交还主会话，可以继续根接口组合与修复。主会话完成根接口和网站贯通后，才能将团队空间事实复用记为已接入。
