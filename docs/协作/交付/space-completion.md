# C02 协作边界补全

日期：2026-10-10。范围仅 `src/modules/projects/`、`src/components/assessment-client.tsx` 与本交付；前轮已停止。本轮已完成，全部内部代理已停止；本会话停止编辑并将授权文件交还主会话。

## NEEDS_INTERFACE

2026-10-10 接入确认：下述 `InvitationAcceptance` 类型、消费方法参数及 SQL 建议已稳定；主会话可先复制为新根 **032** 用于隔离验收。生产迁移仍由主会话在全部模块交付后统一停服、备份和执行；本会话不执行真实迁移。

- `InvitationAcceptance` 增加 `membershipId: string | null`。新消费必须记录本事务实际创建或重新激活的成员 ID；已活跃成员仍直接进入，不新建接受事实、不消费、不升权。旧接受历史保留 `null`，表示当时成员关联未记录，不能据此推断、复活或重新消费。该私有事实继续不进入邀请 DTO。
- 既有公共消费方法改为 `consumeInvitation(value,userId,membershipId,acceptedAt)`；两个 scope 的服务调用均已接入真实成员 ID，根无其它调用点。
- 增量 SQL 建议位于 `src/modules/projects/sql/invitation-acceptance-membership.sql`，必须由主会话复制为 **024 之后的新根迁移** 并在部署新适配器前应用。不修改已应用 024，不回填旧历史。新插入需校验 membershipId 所属空间、账号和当时活跃状态；已引用成员禁止物理删除，已消费邀请禁止迁移空间，离队/移除继续保存状态。现有不可修改/删除与额度事务约束保留。
- `revokeProjectInvitation` 保持方法/HTTP 签名；归档项目直接 DELETE 返回 `PROJECT_ARCHIVED` / 409，邀请、项目 revision、审计和事实均不变。
- `MemberIntentionForm` 使用已存在的 `GET /api/v1/me/participant-profile`，只读本人私人画像；按钮手动带入经验预览，沿用已有意愿保存与明确共享。不需新增 server/app/shared API。

## 已完成

- `service.ts`：归档撤销在当前项目锁内拒绝，项目与固定队伍接受消费传入实际成员 ID；项目接受审计同时记录该 ID。归档后的管理权交接、退出/移除是既有明确例外，保留原行为。
- `model.ts`、`invitation-usage.ts`、`postgres.ts`：接受事实保存/读取 `membershipId`，旧对象缺字段归一 `null`，只读归一不修改原对象；新消费不得缺少成员关联。现有 1–50、默认成员、活跃重试不耗额、退出不返还、原链接不复活及事务额度规则保留。
- `sql/invitation-acceptance-membership.sql`：增量建议增加字段及新插入真实关联校验；有接受事实引用的 project/team 成员禁止物理删除，接受事实所在邀请不得移到其它空间。保留旧 `null`，不重放、不推断回填，原不可变/额度触发器不替换。
- `assessment-client.tsx`：明确“带入本人经验”读取预览，预览可编辑；第二次明确点击才追加到本地草稿，保留已有空间经验和未保存文字。只投影本人填写的开发经历、技能和路演经历，不引用城市/兴趣/想法/年龄/MBTI，不推断职责；不回写画像、不自动保存、不自动共享。新追加经验取消原经验共享勾选，其余共享选择不变，并提示需本人重新确认。
- `participant-experience.ts` 与测试：组件实际使用请求代次 guard，读取/采用均复核本人画像账号及当前空间意愿/成员版本，注销、撤权、归档、换空间/账号、迟到响应不能采用旧预览。读取 15 秒超时保留输入；重复、空预览、追加超 2000 字不改变草稿，不截断旧文字。
- 项目 README 已更新。公开类型/服务仍通过既有 `index.ts` 导出；画像辅助函数为组件内部接线，直接从纯 helper 文件读取，未新增根 API 或第二权限/完成状态。

## Constitution Check

- 原则 III：经验来自本人主动填写，只作为可编辑职责参考，不推断能力或自动分工。
- 原则 VI：空间权限与私人画像分别复核，邀请、成员和消费同事务；共享仍需本人逐项确认，旧历史不得重开或恢复权限。
- 原则 IV/X：版本冲突与未保存输入保留，原任务/完成事实不复制；仅补既有流程边界。
- 外部模型、邮件、仓库写入与付费原则本轮不涉及，没有相关调用。

## 已验证 / 模拟测试

- `node --experimental-strip-types --test src/modules/projects/tests/*.test.ts`：**113/113 通过**。新增 `tests/space-completion.test.ts` 11 项，三处既有 PGlite setup 加载新 SQL；覆盖归档管理员直接 DELETE 409 且邀请/revision/audit/facts/成员全部不变，普通成员 403、被撤权 404；真实新建/重新激活成员 ID；活跃重试无写入；错误 scope/user/type、空/离队成员拒绝；真实接受 INSERT 后失败完整回滚；旧 `null` 历史、满额、不复活、不改写；project/team 删除保护及邀请空间保护。既有名额、最后位置竞争、邮箱、撤销/到期测试继续通过。
- `node --experimental-strip-types --test src/modules/projects/participant-experience.test.ts`：**7/7 通过**。覆盖已有/未保存文字保留、私人字段投影、新经验不沿旧共享勾选、重复/空/超长无变化、2000 字边界、归档/撤权/换空间/账号/重入成员与迟到请求失效。
- `node node_modules/typescript/bin/tsc --noEmit --incremental false`：本轮授权文件无类型错误；最后全局检查 exit 1，错误位于 `src/modules/auth/http.test.ts`（联合类型不可调用）、`src/modules/planning/restore-http.test.ts`（readonly role 赋值）、`src/modules/skills/publication.ts`（implicit any）、`src/modules/space-workflow/service.test.ts`（新上下文字段缺失）。没有越界修改。
- SQL 使用全新内存 PGlite 执行建议迁移与真实 SQL，未打开网站嵌入式数据目录；单连接测试不替代独立 PostgreSQL 多连接并发验收。画像测试是纯逻辑与请求失效规则，未将其称作浏览器贯通验收。

## 未接入与环境

主会话仍需组合根 032（或实际分配的后续递增编号）、执行整体测试/构建及隔离浏览器权限和经验带入流程；真实生产迁移须按主会话安排统一停服备份后执行。本会话不操作生产数据库、真实迁移、模型、邮件、npm install、build 或 start。无新增环境变量；数据库沿用现有 `DATABASE_URL` 或嵌入式适配。
