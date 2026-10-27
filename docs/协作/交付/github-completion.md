# C04 M06 补完交付（2026-10-10）

## NEEDS_INTERFACE

新增公开契约见 `src/modules/github/delivery-materials-types.ts`：

- `ConfirmedDeliveryRequirementsPort.readConfirmed(actor, projectId, executor?)` 只投影当前项目已确认的 M03 正式规则，返回 `ConfirmedDeliveryRequirements | null`。版本复用 `${eventId}:${rulesVersion}:${confirmation.revision}`；`materials` 映射正式 `requirements` 的 ID/label/necessity/stageId/evidenceIds；阶段 deadline 只能取提交阶段 `endsAt.utc`，保留 rawText。没有结构化要求分支时 `requiredBranch={status:'unknown',reason:'已确认规则尚未提供结构化要求分支，请人工核对原文。'}`，不能从仓库默认分支、DSH 草案或生成内容猜测。没有清单或清单不完整时 `materialsStatus:'unknown'`，缺资料写入 `unknowns`。`not_required` 仅明确规则证据可支持。
- `DeliveryMaterialsWriteAccessPort.assertWritable(actor, projectId, executor)` 在与清单保存同一事务锁当前账号/请求会话、项目活跃成员、manager能力及归档状态；规则端在同一 executor 锁项目确认与规则版本。不可仅在 HTTP 外层查一次缓存权限。
- 根需组合 `DeliveryMaterialsService`、`PostgresDeliveryMaterialsStore`，`createGitHubHandler` 注入可选 `materials`；新增 `GET/PUT /projects/:id/delivery-materials` 和 `GET /projects/:id/delivery-materials/history`（action为 `materials.get/save/history`）；PUT 使用版本CAS、幂等键、真实位置/修订/commit和成员自报核对证据，不能当平台正式提交。
- GET `delivery-summary` 注入 `materials` 后读取真实清单。M07 `DeliveryFactsPort.read` 需调用 `getDeliverySummary(...).requirements.materials` 投影 `id/label/status`，`failed/outdated` 映射 `unknown`；不得继续固定 `materials:[]`。
- 增量 SQL 建议将放 `src/modules/github/sql/delivery-materials.sql`，根决定下一个实际迁移编号，勿重写已应用迁移。
- `createGitHubMaintenance({drafts,authorization,clock}).run()` 已导出；返回 `{checkedAt,expiredDraftsRemoved,expiredStatesRemoved}`。根现有后台按 `GITHUB_MAINTENANCE_INTERVAL_MS=300000` 每5分钟调用，同一工厂重叠run共享Promise。无新环境变量/迁移；不自行启动timer或第二个生产PGlite连接。`drafts` 使用 `PostgresDraftStore`，`authorization` 使用 `PostgresAuthorizationStore`。两个purge分别运行，即使一方失败另一方仍清理；失败统一安全 `GITHUB_MAINTENANCE_FAILED`，下次可幂等重试。

## 已完成

- `delivery-materials-types.ts/service.ts/postgres.ts`：正式规则投影Port、同事务当前权限/归档/会话复核Port、完整材料清单替换与不可变历史、版本CAS、project/actor/幂等键绑定规范化输入。逐项位置/HTTPS链接/修订/commit/实际核对时间/依据/成员自报记录人，分支核对另有真实名称/SHA/依据。未变更核对保留原核对人；新actor/id/version不可由客户端注入。
- `delivery-summary.ts`：注入材料服务后比较当前确认规则与最新saved commit；未加载/未知要求、缺必交、历史commit、分支不匹配不升级ready。材料ready、保存、运行与正式提交相互独立；branch matched明确 `user_reported`，不能宣称真实GitHub merge或赛事平台确认。未接Port仍not_loaded与人工核对入口。
- `handlers.ts/index.ts`：新增材料GET/PUT/history action及全部公共导出，可信Actor/CSRF沿用原工厂；材料服务缺失返回明确503，不模拟空成功。
- `sql/delivery-materials.sql`：增量建议，head/不可变version/metadata event；实际迁移与外键由根接入。根通知已组合033供隔离验收，生产迁移尚未执行，本会话未执行。
- `delivery-client.tsx`：真实summary材料投影，旧SHA/读取失败不显示prepared；正式要求/提交截止与未知说明；逐项材料/分支编辑；CAS冲突保留未保存输入，明确载入新版本；未知响应保留原body/key，核对history同key+当前用户+赛事/确认规则后只安全重放同请求；权限失效清输入。全历史可读。运行/正式提交不自动勾选。
- `repository-client.tsx`：多选普通UTF-8文本，单次100份/单份1MiB/总5MiB，fatal解码、路径前缀/可编辑路径、依赖/构建/凭据/大小写/NFC/祖先检查；整批成功才加入本地草稿。账号/项目/归档变化取消异步导入，读取时锁编辑/确认。README使用已保存name/goal/minimumDeliverable/revision；技术与运行说明未提供时留人工占位，已有README变更不覆盖。复用draft→差异预览→明确confirm。
- `manifest.ts`：服务器也拒绝压缩/二进制附件扩展和Git LFS指针，防止绕过浏览器校验。显式删除旧附件允许，无ZIP/二进制/LFS扩展。
- `git-postgres.ts/maintenance.ts`：安全清过期正文/state，事务内同时推进CAS列/JSON，保留manifest/hash/previewHash/baseHead/tree/commit/操作/审计。保护saving/unknown、非空lease（含过期）、PR未知/执行、未saved但已有tree/commit的必要恢复材料；明确reconcile结算后下一purge可清。draftRef保护匹配project/actor，不给跨项目引用影响清理。保留恢复材料不延长用户TTL，不撤销授权、不清Token/epoch/refresh未知状态/hold。

## 已验证

- `node scripts/run-module-tests.mjs github`：**214项通过，0失败**，其中本轮材料清单9、summary组合1、maintenance9、上传类型1。现有授权/保存/恢复/HTTP/清单约束测试保留。
- 本模块严格TypeScript：`node node_modules/typescript/bin/tsc --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext --allowImportingTsExtensions --skipLibCheck` 加`rg --files src/modules/github -g '*.ts'`，退出0。
- 材料6项与maintenance5项在新建内存PGlite真实执行SQL，覆盖当前规则变化/非成员/非manager/归档/事务内撤权与会话失效、要求ID/来源/证据/版本约束、同请求持久重放、版本CAS、不可变历史、审计故障原子rollback、真实隔离TTL清理及旧CAS不能恢复正文。均未打开生产PGlite目录；单连接隔离fixture不替代网络PostgreSQL并发。
- repository代理8组隔离纯函数/文件导入与TSX解析检查通过；材料UI代理5项隔离SSR检查通过（真材料、读取失败、旧SHA、未知要求入口、归档只读），没有网络请求/真实服务运行。代理已停止并交还两个组件。
- 全局typecheck最后代理检查在并行修改期间报告外部错误：`auth/http.test.ts:108,183`、`operations/retention-policy-service.ts:150`、`space-workflow/service.test.ts:78,333,336`旧summary DTO夹具。两个授权组件及M06未报类型错误；不越界修外部文件，根统一处理。

## 模拟测试 / 未接入 / 实际边界

外部GitHub HTTP、能力/规则Port仍以注入夹具验证。材料与maintenance SQL已隔离实际执行，真实账户/请求会话/归档锁与M03规则Port由根实现。根尚需组合应用、路由、M07材料读取、后台定时调用与实际迁移。

用户最新明确“暂时先不验收github”：本轮没有真实授权、仓库创建/写入、平台正式提交、真实App配置验收；不请求配置。没有npm install/build/start/重启、生产数据库或付费模型调用。运行中网页/截图、网络PostgreSQL多连接与真实GitHub验证留后续安排。

## 环境变量名称

本轮清单/maintenance不新增env。复用既有DatabasePort；网络部署由根使用`DATABASE_URL`。GitHub配置名称沿用模块README，仅留后续真实验收，不记录值。

## 文件交还

本会话与全部内部代理已完成授权工作并停止编辑。`src/modules/github/`、`src/components/delivery-client.tsx`、`src/components/repository-client.tsx`与本交付文件均交还主会话，不沿用临时授权继续修改。
