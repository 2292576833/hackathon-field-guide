# 账号资料根组合交付

状态：已实现；隔离真实 SQL 验证通过。文件交还主会话后停止编辑。

## 公共签名

```ts
createAccountDataPorts({ database }: { database: DatabasePort }): {
  ownData: OwnDataExportPort;
  deletionImpact: AccountDeletionImpactPort;
}
```

`src/server/account-data.ts` 只实现 M01 已确认的 `collectOwnData(actor, executor, limits)`、`assertProjectAccess(actor, projectIds, executor)` 和 `inspectOwnDeletion(actor, executor)`。所有 SQL 都使用调用方传入的事务 executor；不会借第二连接、开启另一事务、读取文件、调用模型或发送邮件。`database` 参数标明根组合归属，不能代替传入 executor。

## 导出范围

每条记录的 `userId` 从当前 Actor 生成，SQL 按本人所有权筛选。六个集合始终存在：

| 集合 | 实际读取 |
| --- | --- |
| personal | 本人显示名、邮箱、时区、参赛资料、私人招募资料与本人头像、本人名片快照、首登进度、M10 本人安装计划/回执摘要 |
| conversations | 本人导航工作区及全部已存导航消息、本人在当前可读空间的会话与消息 |
| generations | 本人的成功 AI 生成结果；联合校验 DSH 工作区所有权和执行记录成功状态；空间回复/可行性结果必须含当前授权项目 ID |
| assessments | 本人原始测评、量规/题目快照、回答和跟进、本人全部固定评分版本、本人意愿帮助回答/结果；不导出任务凭据和输入指纹 |
| retrospectives | 本人复盘、经验卡、复用草案及生成状态的安全字段；本人历史版本；C05 本人私有编辑草稿 |
| bookmarks | 本人资源收藏 ID、用途备注及版本时间，不读取资源内部工作草稿 |

项目摘要仅收集当前活跃成员关系可读取的项目，含项目名称、完整作品目标和阶段。共享的最小交付物、队友原始资料、其他成员问卷/头像/私聊均不属于本人导出包。目标保留 M02 允许的完整 4000 字，不截断，符合 M01 摘要 5000 字契约。

全局导航和本人私人测评/个人经验不依赖仍在队内。含项目上下文的导航消息、空间 AI、可行性结果及项目范围复盘需保持当前项目权限。历史复盘按历史版本自身 `scope` 校验，不能用当前改为私人绕过旧共享版本的项目权限。C05 私有草稿只导出本人已写 `draftContent`、`requestedScope` 意图及文档/版本元数据，离队后仍可取回本人文字；不读取关联项目或原文上下文，也不将这些项目加入权限摘要。

M10 安装导出采用显式白名单：计划/回执 ID、AI 工具、包及包版本、精确技能版本 ID、时间、安装/加载/任务验证状态。排除安装清单、下载文件、代码内容、目标目录、本机路径、回执路径、自由备注和教程、bridge token/hash、配对码、manifest hash。不会把“文件已写入”改成已完成客户端加载或任务验证。

身份、会话 token/hash、验证码、授权码、API key、数据库/邮件/GitHub 凭据、请求指纹、模型租约和幂等控制字段均不导出。动态嵌套 JSON 还会排除凭据字段；用户本人正常文字照实保留。

## 数量、大小与权限

每个来源按剩余名额 `LIMIT remaining + 1` 检查；记录和项目摘要共同计数，超过任一上限抛出 `ACCOUNT_EXPORT_TOO_LARGE`，不创建或返回偷偷截断的文件。字节按完整 UTF-8 JSON 计数，M01 在添加 profile/schemaVersion 后再次复核最终大小。项目最多 500 个；导出多于 500 个项目同样明确失败。项目未加入新事实或其他数据表。

收集开始检查有效账号，收集结束和 M01 下载时复核当前项目活跃成员关系，并锁定真实权限行至事务提交。移除/离队后旧项目导出文件不可下载；重新申请可导出当前范围内的资料。不会因检查或导出初始化 DSH、M04 指针或付费任务。

## 删除影响与锁序

检查顺序：M01 已锁本人账号/会话 → 按项目 ID 顺序 planning 协调锁 → 全部现有 M04 assignment heads → 全部 M02 项目根 → 本人当前活跃成员关系及管理员成员关系 → 当前有效且已验证管理员的账号行。

最后管理员判断使用 Project manager，普通成员/Team captain 不能替代。暂停、待删除或已删除账号不计入有效管理员。未归档且本人是最后有效管理员的项目返回阻塞项与真实转交入口 `/app/projects/:id/team`；归档项目不阻止该项处理。超过 500 个项目明确返回需要协助的错误，不遗漏项目后放行。

第二位管理员账号用 `FOR SHARE OF u NOWAIT`，锁竞争 `55P03` 转为 `ACCOUNT_DELETION_MANAGER_BUSY` / 409 提示重新核查。避免双方先锁本人账号、再互相等待的死锁；检查失败不会伪造已确认条件。M01 在真正进入处理前再次调用此 Port。

Port 仅返回影响和说明，不删除物理数据，不提供 physical-completed 状态。隔离测试验证最后管理员保持 active/session 有效；条件满足进入 processing 时由实际 M01 标记 deletion_pending 并撤销会话，仍未声称资料已物理删除。共享协作事实保留和私人清理策略由主会话的处理入口负责。

## 已验证

命令：`node --experimental-strip-types --test src/server/account-data.test.ts`。

8 项测试使用全套根迁移的全新内存 PGlite，覆盖：

- 六个集合的真实 SQL、多账号混入隔离、字段/凭据排除、私人评分理由与复盘历史保留。
- 离队后本人私有文字继续可取回，项目上下文和伪造/缺失项目来源的生成结果不可导出；失败任务不冒充成功结果。
- M10 精确技能版本与真实状态保留，安装文件、路径、bridge 数据及另一账号回执不出现。
- 205 条导航消息无 200 条截断；数量和字节精确边界通过，上限减一明确失败，存储内容保持完整。
- 实际 M01 prepare/download：本人可下载、另一账号不可下载、后续成员权限撤回阻断旧文件、重新申请成功；完整 4000 字作品目标和 4000 字共享交付物不会使摘要超契约。
- 实际 M01 requestDeletion/beginDeletionProcessing：他人暂停或降为成员后重新阻塞、提供团队转交链接、归档后进入处理和撤销会话，无 completed 假状态。
- 传入 executor 唯一执行、M04→M02 排序，以及 55P03 映射成可重试 409。
- 暂停账号和不存在账号即使带有 Actor/管理员角色也被拒绝。

PGlite 是实际 PostgreSQL 引擎的隔离回归，不等于线上多连接 PostgreSQL 死锁/并发验收。锁竞争错误注入仅验证根错误映射；实际 NOWAIT 多连接行为需目标 PostgreSQL 环境验收。

## 根接入与边界

NEEDS_INTERFACE：主会话将返回的两个 Port 注入 `AccountCompletionService`，注册已有 M01 私人账号接口；根已确认该组合和路由接入。模块不改 application/router/account-client 或迁移。没有新增环境变量，也未执行生产迁移、真实邮件/模型调用、实际用户删除、构建或服务重启。
