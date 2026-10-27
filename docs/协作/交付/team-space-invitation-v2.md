# T01 邀请与加入交付

日期：2026-10-09。依据宪法 v1.7.0、规划16、团队空间 T01。本报告仅记录 T01 实际工作，最终根组合与浏览器验收由主会话填写。

## 已完成

- 修改 `src/components/space-invitation.tsx`、`invitation-client.tsx`；新增 `space-invitation-trigger.tsx`、`space-invitation.module.css`、`tests/e2e/team-space-invitation-v2.spec.ts`。没有修改根路由、API、数据库、迁移、依赖、共享 CSS 或旧测试。
- `SpaceInvitationTrigger` 固定导出 `({detail,onChanged}:{detail:ProjectDetail;onChanged:()=>Promise<void>})`。活跃管理员可打开“邀请队友”；普通成员、已离开成员与归档空间显示权限说明。主会话已告知在各空间页标题接入并移除 TeamPanel 重复邀请；本会话未修改其组合文件。
- 使用原生 `dialog`，Esc/关闭回到触发按钮，375px 宽度约束、纵向滚动、可见键盘焦点。只有首次打开才挂载邀请内容，普通关闭不卸载，关闭重开保留当前链接、人数和折叠状态。旧 `#space-invitation` 初始地址和 hashchange 打开同一弹窗，ID 仅在触发器。
- 默认 1 人，1/3/5 快选，自定义 1–50 整数和邮箱限定按需展开。生成后“复制邀请链接”为主操作，“生成另一条邀请”为次操作，保留选中链接手动复制。二维码按需展示，仍使用既有本地同链接 QR。
- 本次链接保存真实 `invitation.id` 与实际回包，撤销仅清除同 ID 的当前链接。撤销旧邀请保留新链接；新建不会默默撤销旧邀请。名额、到期时间、历史状态来自 DTO；不从列表恢复 token。
- token 仅留在本页组件内存，没有 localStorage/sessionStorage、日志、第三方二维码或截图保存。清楚解释关闭可保留、刷新/离开不能恢复及丢失后撤销/新建。
- 邀请列表及直接读取/创建/撤销返回 401/403/404 时清除本页链接和邮箱，停用操作并说明重新核对账号权限。生成结果未知先核对记录，再由用户明确新建；撤销结果未知保留上下文并要求读取状态。已保存操作之后刷新失败有独立提示，保留已返回链接。
- 加入页按游客/当前账号显示一份邀请说明，保留登录注册 returnTo、最小公开预览、限定邮箱、满额/失效/归档边界和明确接受。成功后提供进入空间、填写本人可用时间、选择本人职责。
- 接受结果未知禁止再次接受，重新核对仅 GET；本页认证视图按账号 ID 重建。重新核对失败会撤下旧成员/成功状态，避免成员被移除后继续显示“已加入”。POST 已成功但当前读取失败会说明已保存而当前状态未能读取。

## 实际 API 契约

所有路径由既有 `api()` 加 `/api/v1`，未新增接口。

| 请求 | 实际参数与回包 | 权限与用途 |
| --- | --- | --- |
| `GET /projects/{id}/invitations` | `PublicInvitation[]` | 当前管理员读取；历史状态、真实名额、有效期、撤销。不返回原 token/hash/acceptances。 |
| `POST /projects/{id}/invitations` | `{expectedRevision,role:"member",maxUses,invitedEmail:null|string}` → `{invitation:PublicInvitation,token:string,projectRevision:number}` | 当前管理员、未归档；默认服务端 72 小时。原 token 一次返回，真实 ID 为 `data.invitation.id`，不是顶层 `id`。 |
| `DELETE /projects/{id}/invitations/{invitationId}` | `{expectedRevision}` → `{invitation:PublicInvitation,projectRevision:number}` | 既有管理员撤销；前端按返回记录 ID 关联本次链接。 |
| `GET /invitations/{token}/public-preview` | `PublicSpaceInvitationPreview` | 持 token 最小公开只读 DTO，不建立成员，不暴露限定邮箱或私有项目详情。 |
| `GET /invitations/{token}` | `InvitationPreview` | 当前已验证账号核对邮箱、状态及当前成员身份；未知接受恢复复用此 GET。 |
| `POST /invitations/{token}/accept` | `{}` → `{scopeType,scopeId,membership,revision,alreadyAccepted}`（项目） | 明确接受；实际同事务名额、成员、审计与幂等规则沿用 M02。成功后再 GET 当前事实。 |

`PublicInvitation` 实际字段：`id,scopeType,scopeId,role,invitedEmail,createdBy,createdAt,expiresAt,status,acceptedBy,acceptedAt,revokedAt,revision,displayStatus,maxUses,usedUses,remainingUses`。`status/displayStatus` 包含 pending/accepted/revoked，展示状态可为 expired；accepted 表示邀请名额已用完，不代表所有参赛状态完成。管理员 DTO 不复用为匿名预览。

`PublicSpaceInvitationPreview` 实际字段：`status,scopeType,scopeName,eventName,inviterDisplayName,requestedRole,expiresAt,maxUses,usedUses,remainingUses`。status 为 pending/expired/revoked/used/unavailable；不可用时身份/说明字段为 null，used 可保留实际名额。没有 scopeId、成员、邮箱、目标、hash 或接受者清单。

`InvitationPreview` 实际字段：`scopeType,scopeId,scopeName,requestedRole,currentRole,expiresAt,alreadyMember,alreadyAccepted,maxUses,usedUses,remainingUses`。现服务端已消费但不活跃的旧成员返回 `INVITATION_ALREADY_USED`，不允许原链接恢复。

## 完整状态与恢复

| 状态 | UI 与恢复 |
| --- | --- |
| 未生成 | 默认 1 人，可独自继续；按需设置与历史。 |
| 正在生成/撤销/读取 | 立即忙碌，ref 防重复写入，保留已有链接及输入。 |
| 已生成 | 实际名额/到期，复制优先、手动选择、同链接 QR。 |
| 复制失败 | 保留链接，提示手动复制，不发新邀请。 |
| 生成未知/无完整回包 | 保留原链接，不自动重发；核对记录，原 token 不能从记录重建，再明确新建。INVALID_RESPONSE 同样作为结果未知。 |
| 撤销未知 | 保留链接与记录，要求先读取当前状态，不假报撤销。 |
| 版本冲突/输入拒绝 | 错误可见、人数/邮箱保留，可读取最新空间与邀请状态后再明确操作。 |
| 401/403/404 | 清除内存链接/邮箱、禁用操作，重新进入空间核对账号权限。 |
| 归档/普通成员 | 无可操作邀请按钮，权限说明；不请求管理员邀请列表。 |
| 游客 | 只读最小预览，登录/注册回原邀请；不自动接受。 |
| 已是成员 | 读取当前角色，直接进入，不占新名额、不静默升权。 |
| 新成员接受成功 | 再读当前事实，进入/时间/职责引导；私人资料不会自动共享。 |
| 接受未知 | 不能重发，GET 核对是否已加入；核对失败保留未知上下文。 |
| 重新核对失败/被移除 | 撤下旧成功与进入入口，显示实际错误；不能把旧成员事实继续当当前成功。 |
| 邮箱不符/满额/失效/不可加入 | 显示服务端状态或错误，索取新邀请；不泄露限定邮箱、不恢复旧名额。 |

## 已验证与模拟测试

- `npm run typecheck -- --incremental false`：开发中多轮通过；最后交付轮在另一并行模块 `src/modules/space-workflow/service.test.ts:78:321` 出现 `DeliveryVerification | null` 不能赋给 `DeliveryVerification` 的 TS2322，未越界修复。T01 组件与新 e2e 使用独立严格 `tsc --noEmit` 检查通过；未写构建或增量缓存。全局最终结论以主会话汇总为准。
- `node --experimental-strip-types --test src/modules/projects/tests/invitation-capacity.test.ts src/modules/projects/tests/http.test.ts src/server/invitation-qr.test.ts`：25/25 通过。测试使用注入夹具与新建无路径的内存 PGlite，未打开生产持久目录；验证现有名额、并发最后名额、事务回滚、旧邀请兼容、权限与 HTTP 边界及独立 QR 解码。
- 独立代码审查已完成：发现并修复直接 GET 失权未清链接、重新核对失败沿用旧加入成功两处状态问题。静态审查未发现新的可证实问题。
- 新 e2e 共10项，复用 `isolated-workspace`、`.test` 邮箱与隔离数据库/API dispatch，关闭截图/视频/trace。覆盖弹窗/关闭回焦点/重开保留、默认与自定义和无效人数、旧邀请撤销关联、复制失败、本地 QR、各页唯一入口、旧锚点、375px、成员/归档、登录上下文/明确加入、未知创建/接受、GET404清令牌及被移除后核对等。文件通过独立 TypeScript 检查；**本会话未执行浏览器**。

## 待主会话统一验收

- 构建后统一运行新 `team-space-invitation-v2.spec.ts` 与主会话更新选择器的旧邀请多人/QR 测试，确认根组合、真实浏览器布局、焦点和 GET/写请求行为。静态 CSS 与测试编写不等于实际375px已通过。
- 实体手机扫码、系统剪贴板、公网登录/证书、真实队友与目标数据库并发均未在本会话验收；没有真实邮件、AI 或 GitHub 写入。
- 未新增环境变量、依赖、迁移；使用既有认证、邀请服务和本地 QR。

## NEEDS_INTERFACE

无新增接口或字段需求。主会话按上述固定 props 在每页标题渲染一次，并移除旧 TeamPanel 邀请即可；根接入已由主会话告知完成，最终以其验收为准。

已有 API 边界供主会话复核：`ProjectsService.revokeProjectInvitation` 当前未执行 `editable(aggregate)`，因此归档后管理员可能仍能 DELETE 撤销邀请。本轮 UI 禁止归档邀请操作，创建/接受归档拒绝继续由既有服务保证；T01没有 API 文件授权，未修改此既有行为，不把前端无入口当服务端归档撤销验收通过。

## 交还

T01 文件交付后停止编辑，临时授权交还主会话。后续根接入、构建、服务启动、真实迁移及最终验收均由主会话统筹。
