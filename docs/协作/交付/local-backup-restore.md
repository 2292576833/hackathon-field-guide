# 本机 PGlite 备份恢复验收

2026-10-10。只修改 `scripts/verify-local-backup.mts` 与本报告。两次实测分别由主会话明确授权旧027备份 `.runtime/backups/task-mission-20261010-000105`、最终041备份 `.runtime/backups/completion-final041-20261010`，均复制到各自全新 `.runtime/restore-check-<随机ID>` 并只打开隔离副本。没有读取运行中的 `postgres-data`，没有直接打开或写入备份。

## 脚本行为

- 默认仍固定 `task-mission-20261010-000105`，可通过唯一显式参数 `--backup-name <名称>` 选择主会话明确提供的备份。名称只接受最多200字符的 `[a-z0-9-]+`，仅允许 `.runtime/backups` 下单层目录；绝不自动选择 latest 或接受任意CLI路径，不加载 `.env.local` 或服务配置。校验备份根、备份目录和 `.runtime` 的 realpath 与 lstat，拒绝符号链接；校验新副本绝对路径位于 `.runtime`、不在 backups/live 内、不是原备份且尚不存在，拒绝无关环境文件/密钥。
- 复制前后在内存比较文件内容摘要，摘要不输出。使用根 `createDatabase({localPath: clone})` 读取实际备份，不调用 `createApplication`、`migrate`、seed、worker 或网络服务。
- 读取原有迁移数量和最后迁移ID，核对账号、项目、规则、计划、交付、审核与预算表存在；所有公共业务表的行数及内容摘要都只用于内存比较。
- 在只读事务内检查全部实际FK、实际SQL CHECK约束、所有JSON列解析及计划内任务/计划/进度的项目范围。预算未知请求和未结算/预留记录保留并计数，不解锁、不重发。
- 关闭后重开同一隔离副本，确认各表内容摘要、计数、迁移和完整性检查均一致，再核对原备份内容未变。隔离恢复目录留在 `.runtime` 供复查，不递归删除。
- 输出包含明确 `backupName`、本次绝对 `clonePath`、表名、计数、通过状态与必要schema版本元数据（包括 `lastMigrationId`）；不输出私人正文、邮箱、token、digest、SQL原始表达式或配置值。失败只给固定步骤，不打印数据库异常内容。

2026-10-10新增参数改造：参数解析/边界负向检查通过，路径穿越、绝对路径和额外 `--latest` 均在任何文件读取前退出；独立严格类型检查退出0。随后收到主会话明确的最终041备份名称，按下述记录只运行一次实际恢复。调用格式：`node --experimental-strip-types scripts/verify-local-backup.mts --backup-name <主会话提供的单层名称>`，不用 `--env-file`，不能传完整路径。

## 最终041备份实际恢复记录

明确备份名称：`completion-final041-20261010`。主会话已停止网站、完成真实迁移并关闭数据库后完成该备份。本验收没有打开 live，也没有对该备份应用迁移。

实际执行一次：`node --experimental-strip-types scripts/verify-local-backup.mts --backup-name completion-final041-20261010`。退出码 **0**，日志 [.runtime/completion-final-restore.log](F:/黑客松情报局/.runtime/completion-final-restore.log)。没有重试、删除目录或替换运行库。

输出明确记录 `backupName` 与绝对 `clonePath`，本次保留副本为 [restore-check-fede73dc-5735-4999-8d2f-42bb935cdfe2](F:/黑客松情报局/.runtime/restore-check-fede73dc-5735-4999-8d2f-42bb935cdfe2)。

| 实际检查 | 结果 |
| --- | --- |
| schema版本 | 41份已应用迁移，最后 `041_resource_link_maintenance.sql`；PostgreSQL主版本18 |
| 全量公共业务表 | 148张表、合计2585行；全部逐表内部内容摘要与行数在重开前后完全一致 |
| 账号与项目 | `auth_users` 124行，项目59行，项目成员82行，邀请23行，接受事实23行 |
| 计划与任务 | `planning_states` 26行，内含108项任务、26份计划、0条进度记录；项目范围异常0 |
| 交付与复盘 | 交付验证23行；正式提交版本0行；`m07_documents` 23行、历史版本46行 |
| 本轮新增表 | 账号导出/删除/邮箱变更、材料清单、复盘编辑草案、技能审核/候选、队内动态/AI、计划通知、资源入口维护等表均存在，逐表读取并纳入重开比较 |
| 招募与个人空间 | 招募画像1行、名片1行、历史2行；独立团队AI会话1行、消息0行，个人DSH会话124行；不输出私人内容 |
| 发现与灵感 | 赛事卡片8行、历史16行；灵感卡片13行、历史13行；保留原有状态，不视为正式人工审核 |
| 预算 | 预算桶4行、执行9行、用量9行；未知任务0，未结预留/未知用量0；没有解锁或重发 |
| 外键 | 检查118条，关联异常0 |
| SQL CHECK约束 | 检查531条，异常0，遵循当前schema的NULL允许语义 |
| JSON | 92列、791个非空值实际解析通过 |
| 重开与源备份 | 关闭后重新打开，全部表内容摘要/计数/schema/完整性检查一致；原备份恢复前后文件内容摘要未变化 |
| 运行边界 | `noMigrationApplied=true`、`noApplicationInitialized=true`、`cloneWithinRuntime=true`、`backupUnchanged=true` |

这是最终041版本本机 PGlite 快照的实际隔离恢复、数据库约束和重开稳定性验收。表中0行的正式提交/材料清单/审核/未知请求等类型，只证明表与约束能恢复，非空业务行为仍以隔离功能测试和真实集成验收为准。没有执行远程PostgreSQL、云部署、真实浏览器、模型、邮件或恢复库替换生产服务的验收。

本次明确备份恢复任务已完成，停止编辑并交还主会话；隔离副本和安全聚合日志保留。

## 旧027备份执行记录（历史）

实际运行：`node --experimental-strip-types scripts/verify-local-backup.mts`，不使用 `--env-file`。最终退出码 **0**，约4.9秒；安全汇总日志 `.runtime/local-backup-restore-content.log`。严格独立 TypeScript 检查通过。没有调用迁移方法或初始化应用。

通过的隔离恢复目录为 [restore-check-b2d01f30-47ea-4507-af71-ff10d20a855e](F:/黑客松情报局/.runtime/restore-check-b2d01f30-47ea-4507-af71-ff10d20a855e)。目录保留，没有替换运行数据库。

| 实际检查 | 结果 |
| --- | --- |
| 备份schema | 27份已应用迁移，最后 `027_user_onboarding.sql`；PostgreSQL主版本18 |
| 全量业务表 | 112张表、合计2554行；计数与内部内容摘要在重开前后完全一致 |
| 账号与项目 | `auth_users` 124行，`projects_project` 59行，`projects_project_membership` 82行 |
| 计划与任务 | `planning_states` 26行；内含108项任务、26份计划、0条进度记录 |
| 交付 | `m06_delivery_verifications` 23行；正式提交版本0行 |
| 规则与审核 | 规则/审核表存在；项目规则、赛事审核及资源审核当前各0行 |
| 发现结果 | `event_discovery_cards` 8行，历史版本16行；不升级为正式审核赛事 |
| 预算 | `ai_budget_buckets` 4行，执行8行，用量记录8行；未知任务与未结算/未知用量计数均0 |
| 外键 | 检查94条，关联异常0 |
| SQL CHECK约束 | 检查406条，异常0；遵循原schema允许NULL的语义 |
| JSON | 68列、786个非空值实际解析通过；另检查计划内任务/计划/进度的项目范围，异常0 |
| 重开 | 全部业务表计数和内存内容摘要、schema及检查结果一致 |
| 原备份 | 恢复前后文件内容摘要一致；没有直接打开备份或访问运行数据库 |

前两次准备运行分别停在复制阶段，未打开数据库；日志 `.runtime/local-backup-restore.log`、`local-backup-restore-recheck.log` 保留。调整为由 `cp` 创建全新目标、只验证内容而不额外保存Windows文件时间后，最终完整恢复及重开通过。失败尝试的隔离目录也保留，没有递归删除或修改原备份。未将复制阶段失败猜作备份数据损坏。

这是本机旧版本备份的实际恢复演练，不等于远程PostgreSQL多连接恢复、云部署、自动备份计划或公网上线已经通过。这份明确备份不含后续28号起的新增表与功能，本次没有迁移到当前schema；验证最新应用的恢复还需主会话另外选择最新备份并验收升级。规则/审核/正式提交/未知请求样本为0，不宣称验证了这些类型非空记录的业务正确性；全量表内容与数据库约束的稳定恢复检查已经完成。

损坏副本负向测试为可选项，本脚本不修改备份或恢复内容来人为制造损坏；其路径边界、复制一致性与实际数据库约束检查均为恢复验收的一部分，不宣称已经验证所有文件损坏类型。
