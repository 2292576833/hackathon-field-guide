# DSH 站内检索：公开来源只读适配交付

日期：2026-10-09。责任：`novice_flow_acceptance`。本次仅新增 `src/server/site-search-sources.ts`、`src/server/site-search-sources.test.ts` 与本报告，不修改检索核心、导航员、接口、数据库、公共规划或前端。

## 接入签名

```ts
createSiteSearchSourceReader({
  resources: Pick<ResourceService, "list">,
  discoveries: Pick<ReturnType<typeof createDiscoveryService>, "list">,
  skills: Pick<SkillsService, "list">,
  inspiration: Pick<ReturnType<typeof createInspirationService>, "snapshot">,
}).readPublicDocuments(): Promise<readonly SiteSearchDocument[]>
```

`SiteSearchDocument` 从核心 `site-search.ts` 仅导入类型。灵感现有公开服务的读取方法是 `snapshot()`，没有 `list()`。依赖只允许上述公开读取方法；不传 Actor、不读取个人收藏、账号、项目或原始回答，不访问数据库/任意表、文件系统、环境变量或外部网络，不调用保存、后台任务、安装或模型服务。

## 来源与边界

| 来源 | 文档投影 | 入口与范围 |
| --- | --- | --- |
| 资源 | 仅 published 且外链未阻断的公开版本；用途、不适用情形、开始步骤、费用/许可未知状态、公开内容版本；不索引编辑草稿、撤下内容、录入者身份 | `resource:<真实ID>`；`/resources/<真实ID>`；最多 2 页，每页 50 条，共 100 条 |
| DSH 赛事线索 | 已保存的实际 DSH 卡片；明确未经人工核验，报名未知/已截止和过去/将来开赛信息保留；保留风险、条件性建议和实际引用依据，引用片段注明未读取全文 | `discovery:<真实64位ID>`；`/participation?event=<实际卡片ID>`，不是不存在的正式 `/events/<发现卡片ID>`；公共 list 负责 active/撤回可见性；最多 60 条，不筛日期 |
| 技能 | 只取 published 固定版本并用现有 `assertVersion` 检查 commit、文件清单哈希与许可；目录只声明路径/格式，客户端加载及任务效果尚未实测，不能确认安装成功；不读技能文件正文或运行脚本 | `skill:<固定版本ID>`；`/skills/<技能ID>?versionId=<固定版本ID>`；最多 100 个合法公开版本 |
| 灵感 | 只有公开 snapshot 中实际已保存、DSH 状态、完整带时区分析时间及官网依据的条目才使用说明；待分析或仅日期的编辑 seed 只保留身份、分类、官网与等待状态，不采用 description/useWhen/usageNote | `inspiration:<真实ID>`；统一 `/inspiration`，无虚构锚点；分析和候选合计最多 60 条 |

现有技能 list 与灵感 snapshot 不接受分页参数，适配器约束的是返回检索文档数量，底层目录读取量由这些已有服务控制。资源分页最多两次，发现只读取一页；不无限追游标。当前四类理论总上限为 320，核心检索另有限制 256 条，因此调用方需要如实说明有界覆盖，必要时交错组合类别；不能把结果解释为全站/全网完整检索。

正文来自当前服务返回的公开字段，固定字段投影不会加入本次时间、配额、后台心跳或生成式补充。关键词仅为实际名称、类别、方向、工具声明等公开信息。所有文档 `scope: public`；入口为真实站内页面，外部 URL 仅作为正文来源依据。

## 最终复核

适配器不保留自身缓存，每次调用重新读取注入服务的公开快照。稳定 ID、当前公开修订/固定版本以及对应 `updatedAt` 有助于根导航员最终重新读取后比较实际回答使用的文档摘要。资源和发现的撤回由其公开 list 自动排除；内容变化会改变投影，不能复用旧回答。灵感服务自身已有短暂 snapshot 缓存，其 save 会使该实例缓存失效；本适配器不绕过服务读取任意表。

某一来源读取失败会向上传播错误，不把失败悄悄替换为空列表并宣称已完成撤回核对。四个分支通过 `Promise.allSettled` 等待全部读取结束后再抛错，避免在根事务/savepoint 退出后仍有同级 SQL 继续执行。最后账号/项目权限事务、回答文档摘要比较以及 DSH 提示约束由主会话组合；此适配器只提供公开只读来源。

## 已验证

`node --experimental-strip-types --test src/server/site-search-sources.test.ts` **9/9 通过**：

1. 空服务不制造结果，仅访问四个只读方法。
2. 真实 `ResourceService` 走创建草稿、送审、夹具审核、发布、更新未公开改稿与撤回，导航员只获得当前公开快照。
3. 防御性排除 draft、withdrawn、阻断外链与不安全 ID。
4. 两页资源、单页赛事及技能/灵感返回数量上限。
5. 赛事保留未知/已截止/已过日期，不混为正式赛事规则，使用实际参赛计划入口。
6. 已保存灵感说明与候选身份分开；静态 seed、候选附带说明和重复候选不会覆盖真正分析内容。
7. 技能只取合法固定 published 版本，固定版本入口与未实测说明保留。
8. 重读投影稳定，公开内容变化可见；读取失败不冒称复核成功。
9. 一个分支先失败时，调用仍等待被阻塞的其他分支结束，才返回失败，不提前释放调用方 SQL 作用域。

严格单独 TypeScript 检查通过：

```powershell
npx tsc --noEmit --strict --module NodeNext --moduleResolution NodeNext --target ES2023 --allowImportingTsExtensions --esModuleInterop --skipLibCheck src/server/site-search-sources.ts src/server/site-search-sources.test.ts
```

运行全局 `npm run typecheck` 时曾遇到根导航员并行编辑的 readonly notices 和联合类型 join 报错，已报告而未越界修改；本文件严格独立 TypeScript 检查通过。主会话随后确认全局 typecheck 已过，并完成 application 注入及导航员 initial/final 事务复核接入。最终组合结果由根记录。

测试中的审核结果为隔离夹具，资源服务使用专用内存仓库；其用途是验证真实业务发布/撤回路径，不代替生产持久化。技能与灵感示例是隔离数据，未触发 DSH、联网采集、真实安装、邮件、第三方账号或外部写入。未 build、未迁移、未启动或停止网站服务。

## NEEDS_INTERFACE 与交还

不新增业务 API 或环境变量。根应用注入当前 resources、discoveries、skills、inspiration 服务，导航员把返回文档与本站原创资料组合检索；最终回答前再次读取并核对实际引用文档摘要。核心需支持 `/participation?event=<64位ID>` 及技能详情的 `versionId`，已通知核心代理。

现停止编辑并交还三份新增文件。无需继续沿用此前前端或 E2E 授权。
