# M09 工具与灵感库

人工精选资源的内容、受控分类与标签、公开查询、个人收藏及跨模块发布适配。`index.ts` 是服务端入口；React 组件从 `components.tsx` 导入，避免 Node 行为测试加载 TSX。

## 体验改版（U04）

`/resources` 按任务连接工具、灵感、AI 技能与新手教程。工具的人工审核、灵感的 DSH 官网分析、本站原创教程分别保留来源和状态。原审核条目、资源 ID、内容版本与产品文档地址保持不变。

`navigation.ts` 只读写受控资源筛选、排序、每页数量与分页位置；详情和登录返回保留这些条件，未知 URL 字段不进入公开 API。`site-identity.ts` 为 shadcn/ui、Radix、Ant Design、Awwwards 的不同文档入口提供固定同站身份及已有灵感搜索链接，不改变审核快照，不提供 DSH 结果或扩大许可范围。

`bookmark-lookup.ts` 按现有私人 API 分页寻找当前页资源的收藏，找到全部目标可提前结束；只有读到末页才认定未收藏。失败、非前进 cursor、身份错配或中止不会返回伪造的未收藏结果。页面私人读取按账号和当前资源绑定，拒绝旧请求更新，刷新已有收藏时保持编辑器及草稿。

资源分享的页面名称为“分享到团队空间”，底层继续引用参赛项目和 `ProjectResourceBookmark`，用户须显式选择目标，服务端仍复核实际项目权限；私人收藏不会自动分享。已归档项目不作为新的分享选项。

`tutorial-links.ts` 供原创教程页面使用：允许白名单站内下一步与明确 HTTP(S) 外部参考，拒绝协议相对地址、反斜杠、控制字符、未允许的协议、带凭据地址和不安全路径。分类/关键词保留到详情与返回目录。

## 内容与公开版本

资源的 `version` 是内容版本，`revision` 是整体乐观锁。`resource_records` 同时保存工作稿和当前公开快照。更新产生新工作稿和内容版本；旧公开版在审核期间继续可读。提交审核后，由 M08 的真实人工核验记录绑定 ID、版本、内容哈希和来源。下架保留详情与收藏，公开列表和新推荐排除下架条目；严重风险外链被阻断。核验过期由 `verificationState` 和可配置天数派生，不能当作费用或许可已更新。

费用分类与许可分别允许未知。非未知的费用/许可需要官方依据和核验时间；有免费方案不代表全部功能免费，来源核验不构成赛事允许使用的保证。分类及标签首版为代码中的受控词表；动态后台分类管理后置。

`candidates.ts` 保留模块规划中的十个未核验候选。第二轮新增 `catalog.ts` 的 13 条官方来源精选候选，目录版本 `2026-10-08.1`，核验日期 `2026-10-08`。`RESOURCE_CATALOG_CHECKED_AT` 是固定批次整理时间，不是网络请求或 M08 审核时间。用途与步骤是编辑建议；费用/许可的来源、时间与支持范围保存在 `evidence`。全部为 `reviewStatus: candidate`、`linkStatus: unknown`，没有已发布种子。

| 候选 key | 费用依据 | 许可依据与边界 |
| --- | --- | --- |
| `shadcn` | [MIT 代码许可](https://github.com/shadcn-ui/ui/blob/main/LICENSE.md)，代码无许可费 | 同一官方许可；第三方 registry、依赖与素材另查 |
| `radix` | [Primitives MIT](https://github.com/radix-ui/primitives/blob/main/LICENSE)，代码无许可费 | 同一许可，只覆盖 Primitives |
| `antd` | [antd MIT](https://github.com/ant-design/ant-design/blob/master/LICENSE)，代码无许可费 | 同一许可；模板、关联产品与素材另查 |
| `lucide` | [官方 ISC](https://lucide.dev/license)，图标代码无许可费 | 保留版权、许可及所选版本的 Feather 声明 |
| `uiverse` | [官网](https://uiverse.io/)声明站内元素免费 | 官网声明 UI 元素为 MIT；逐条保留作者与声明，不扩展到外链 |
| `penpot` | [免费和付费云方案](https://penpot.app/pricing) | **未知**：已查[云条款](https://penpot.app/terms)和[MPL 2.0 源码](https://github.com/penpot/penpot/blob/develop/LICENSE)，仍需核验实际素材与账号条件 |
| `awwwards` | **未知**，现行费用证据不足 | **未知**；[案例目录](https://www.awwwards.com/websites/single-page-1/)仅支持灵感观察用途 |
| `figma` | [免费和付费方案](https://www.figma.com/pricing/) | **未知**；[Community 许可](https://help.figma.com/hc/en-us/articles/360042296374-Figma-Community-copyright-and-licensing)依具体资源而异 |
| `v0` | [免费和付费用量](https://v0.app/pricing) | **未知**；[FAQ](https://v0.app/docs/faqs)要求评估输出及第三方权利 |
| `github-codespaces` | [个人额度与计算/存储按量计费](https://docs.github.com/en/billing/concepts/product-billing/github-codespaces) | **未知**；[服务条款](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service)不替代仓库/依赖许可 |
| `excalidraw` | [免费白板与收费 Plus](https://plus.excalidraw.com/pricing) | [官方 MIT](https://github.com/excalidraw/excalidraw/blob/master/LICENSE)仅覆盖软件源码 |
| `canva-presentations` | [免费和付费方案](https://www.canva.com/pricing/) | **未知**；[内容许可](https://www.canva.com/policies/content-license-agreement/)依素材/音乐而异 |
| `framer` | [免费、付费与增购条件](https://www.framer.com/pricing) | **未知**；[条款](https://www.framer.com/legal/terms-of-service)区分客户内容和第三方社区资源 |

已确认的源码许可也不授予第三方图片、品牌和赛事使用权。未知许可保留政策入口，但 `licenseVerifiedAt: null`。M10 技能库使用独立模型，本次没有修改 Resource 枚举或把复制命令记成安装成功。

## 目录导入 CLI 工厂

`createResourceCatalogCli(deps).run(args)` 是可执行的命令工厂，不读取进程环境、不退出进程。根脚本由主会话创建；模块没有越界添加 `scripts/` 文件。参数示例是传入工厂的 argv，当前不能当作已存在的 npm 命令：

```ts
await cli.run([]); // 默认 dry-run，不读取身份，不写数据库
await cli.run(["--import", "--keys", "shadcn,lucide"]); // 只建草稿，链接仍未知
await cli.run(["--import", "--keys", "shadcn", "--review", "--confirm-links",
  "--review-reason", "已人工核对当前官方入口、MIT 原文和项目采用版本"]);
await cli.run(["--import", "--keys", "v0", "--review", "--confirm-links", "--ack-unknown",
  "--review-reason", "已核对费用来源，许可继续明确显示未知", "--publish"]);
```

`--review` 必须有 `--import`、非空理由与人工确认链接的 `--confirm-links`；含未知费用或许可还需 `--ack-unknown`。`--publish` 必须同时指定 `--review`。`--confirm-links` 是实际操作者的确认，候选浏览和 worker 成功不会自动添加它。CLI 拒绝 `--role` 等自授身份参数；`loadTrustedActor` 必须从主会话的持久身份/会话查询加载真实 reviewer/admin。

主会话组合示意（`application` 为现有根应用，`clock/ids/loadTrustedActor` 为根可信依赖）：

```ts
const cli = createResourceCatalogCli({
  entries: RESOURCE_CATALOG, clock, requestIds: ids, loadTrustedActor,
  runEach: work => application.database.transaction(tx => work({
    resources: application.resources,
    reviews: application.operations.services.resourceReview,
    checkpoints: createResourceCatalogCheckpointPort(tx),
  })),
});
const result = await cli.run(process.argv.slice(2));
```

此示意依赖根数据库当前同事务复用 executor 的机制；其他宿主必须为三个 Port 显式提供同一事务。使用根 `resourceReview` 服务，保留其发布台账/纠错目标登记包装。CLI 不调用 `ResourceService.publish`。导入、审核、发布各自为一个事务；失败回滚当前阶段，前一成功阶段留作恢复。持久检查点按候选 key 加锁，保存目录版本和稳定内容哈希；相同输入重复运行复用资源，目录变化或人工修改资源/审核修订返回 409，避免覆盖现有内容。审核事务内提交、注册并批准；不会留下未审完的中间阶段。

接入前由主会话将新增建议 `migrations/002-resource-catalog-imports.sql` 纳入递增根迁移，不能重写已应用文件。该表只存导入检查点，不创建第二份审核或公共成功状态。

## 可运行活性检查

`createResourceLinkCheckWorker` 默认使用 `createNodeResourceLinkTransport` 真正发出 HTTPS HEAD。调用方提供服务端审批的**完整 URL**；跳转目标也必须精确入列。默认总超时 8 秒、最多 3 次跳转，可配置上限分别为 15 秒和 5 次。DNS 仅接受公网 IPv4，连接固定解析地址并验证原域名 TLS；私网、回环、保留地址、凭据 URL、非标准端口和未审批 URL 被拒绝。IPv6-only、网络失败、403/429、HEAD 不支持等保留未知。

```ts
const worker = createResourceLinkCheckWorker({
  approvedUrls: ["https://lucide.dev/"], clock, timeoutMs: 3000,
});
const check = await worker.check("https://lucide.dev/");
```

只读取响应头，不收集网页正文、不执行脚本；结果没有写库或发布能力，也不核验费用/许可。实际本机一次 Lucide 请求在 3 秒后超时，记录为 `unknown / request_timeout`，不是可用证明。成功/跳转等分支测试注入 HTTP 夹具，不能视为外站实测。主会话仍需创建隔离 worker 的调用入口、服务端 URL 审批配置与结果存储/人工复核流程。

## 服务接入

```ts
import { ResourceService, createPostgresResourceRepository } from "./index.ts";

const resources = new ResourceService({
  repository: createPostgresResourceRepository(database),
  reviews, clock, ids,
  projectAccess, projectSharing, corrections,
});
```

`database` 使用共享 `DatabasePort`，由主会话提供真实连接池。`reviews` 是 M08 的服务端查询 Port；不能把浏览器 JSON 中的“审核通过”当核验事实。`createDraft/updateDraft/getDraft/requestReview/publish/withdraw` 检查平台 reviewer/admin；worker 不获得此身份。公开 list/detail 不要求登录，收藏身份仅来自共享 Actor。

运营事务接入优先使用 `createOperationsResourcePublicationAdapter({clock, ids, readReview})`。它与 M08 的 `ResourcePublicationPort` 结构一致，在调用方 `SqlExecutor` 中锁/CAS 修订与内容哈希，读取 M08 核验、保存资源版本、幂等结果和通知；没有独立提交或网络调用。`readReview(tx, reviewId)` 应由集成层委托 M08 的事务 `getReview`，不直接读另一模块的表。流程是保存工作稿 → `requestReview` → M08 register/decide → M08 publish；未提交审核的草稿不能发布。M08 当前撤下 Port 没有风险字段，因此此适配默认阻断全部外链，重新人工发布后恢复。

M05 可直接注入本服务的 `getDisplayableApprovedIds(ids, transaction?)`；需要内容版本快照时使用 `getReviewedResources`、`validateResourceRefs`。传调用方 `SqlExecutor` 时，按稳定 ID 顺序锁定当前发布头至事务提交，保护计划应用与撤下并发；不另开提交。未知、不存在、已下架或版本变化不能成为新任务引用。M02 的 `ReviewedResourcePort` 可直接注入 `getReviewedResource(id, transaction?)`，只返回当前审核公开的 ID/标题。

个人收藏按 `userId + resourceId` 唯一，重试返回原收藏并保留首次备注；修改备注需 `expectedRevision`。收藏不触发共享。`shareBookmark(actor, bookmarkId, projectId, purposeNote?)` 仅在用户显式选择项目后调用 M02 Port，共享备注可独立覆盖，私人备注不变。也可通过 `shareResource(actor, {projectId, resourceId, resourceVersion, purposeNote})` 直接共享本条审核资源；标题/URL 来自服务端当前公开快照，不接受客户端伪造。M02 必须在写入事务内再次检查活跃项目成员和当前资源版本，幂等合并；删除个人收藏不删除 M02 共享资料。

## HTTP 与组件

`createResourceHandlers` 接收服务、可信会话 `resolveActor`、requestId 生成器和强制 `assertMutationAllowed`（由主会话执行同源/CSRF 检查）。提供列表、详情、分类、本人收藏 CRUD 与纠错 handler，主会话负责 Next 路由组合。请求不能传 userId/role，输入 JSON 有 16 KiB 上限，私人数据 `private, no-store`，未知错误不返回内部栈。运营 HTTP 由 M08 组合，没有第二份资源后台。

`components.tsx` 提供资源卡、受控筛选、详情、收藏备注编辑和显式项目分享。动作由 props 注入 Promise；确认成功后才更新状态，失败保留备注。私有编辑/共享组件必须传当前可信 `identityKey`，所有私人 props 要属于该身份；账号切换会清除旧草稿与窗口，旧 Promise 不能更新新身份。项目选择默认空，输入文本按 React 文本渲染；没有任意 URL 抓取、图片镜像、脚本执行或自动安装。

## 持久化与验证

`migrations/001-resources.sql` 仅为建议，由主会话审核/执行。包含资源头/版本历史、个人收藏唯一约束、发布幂等结果及轻量通知表；M02 项目资料和 M08 ResourceReview 不重复建表。用户 FK/账号删除联动由集成层与 M01 确定。通知只携带 ID、版本与状态，由主会话选择消费/确认机制，不自动修改计划。

```powershell
npm test -- resources
npm run typecheck
```

测试夹具在 `testing/`，仅用于规则、并发和失败覆盖。SQL 录制测试验证参数、事务边界与访问约束。根应用已组合持久本地 PGlite、连接模式和路由；本模块第二轮不执行实际应用迁移、导入或发布。浏览器键盘/放大、移动端和减少动效仍需整体验收。隔离 SQL 测试的范围及最新结果见交付文档。

集成需求与最新验证结果见 `docs/协作/交付/resources.md`。
