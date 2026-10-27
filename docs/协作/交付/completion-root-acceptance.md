# 根组合补全验收（2026-10-10）

本轮仅拥有 `src/server/completion-integration.test.ts`、`tests/e2e/completion-account-experience.spec.ts` 与本文件。前轮 C02 文件已经交还，不再修改。根路由、应用组合、迁移、构建、生产数据库与启动由主会话负责。

## 已发现并由主会话修复

- 已修复：旧 M07 经验卡、复盘及复用路由未复用 `authenticatedResponse`，缺请求 session 的最终复核。回归修前201、修后401且文档、版本与审计全部回滚；由主会话修根接线。
- `TaskProposal` import 已改用 `planning/index.ts` 公共导出。
- 提醒夹具补齐真实日期证据 `rawDateText`、excerpt 与 fieldKey；没有放松 M03 发布校验。草稿键控读取只取本人正文，无本人草稿为 200/null；陌生人保存仍为 403。
- 未完成草稿与真实计划提醒两项修正后均通过（2/2）。
- 已修复：C06 项目技能面板把实际 `{items:ReviewedSkillOption[]}` 目录响应直接传为数组，现由主会话取 `.items`。移动端代理只修改新 spec，不越权修组件。
- 已修复：C07 固定 GET `admin/resources/link-checks` 被通用资源详情 fallback 覆盖，修前404，修后200；主会话把 fallback 限于 `!matched`，固定路径 PATCH 应为405。

## 夹具边界

真实 `createApplication`、`dispatch`、隔离内存 PGlite 与实际 SQL 迁移；显式 config，不加载 `.env.local`、生产目录或常驻 worker。拦截并禁止 fetch，挑战邮件仅进入隔离数据库 development_mailbox，不调用真实邮件、模型、GitHub 或技能安装。

材料测试的保存 commit 是注明为夹具的持久事实，不声称真实 GitHub 保存成功。提醒使用真实手动计划和 blocked 进度，由根 worker 产生通知。保留期测试在隔离库放入不可变采集回执、unknown 请求及预算，验证维护不会删除或释放它们。

## 最新实测（2026-10-10）

新增账号链路4/4通过：本人导出与下载撤权、最后管理员删除阻塞/转交刷新/取消、双邮箱换绑撤旧会话、挑战账号版本冲突。

保留期测试已通过；技能候选→审核→发布→项目固定版选择/复制→撤回链路已通过，完整历史保留且安装回执、安装计划、AI任务均为0。八工具仍为 installer_declared，未升级成实测成功。

M07接线风险修前已证实：新增 `root rejects a session revoked after private experience persistence...` 在 POST 保存之后撤本次 session，修前返回201（预期401），私人文档已提交。主会话将旧 M07 HTTP 路由纳入 `authenticatedResponse` 后，该回归通过。保留期夹具 timestamptz/text 参数类型推断已修并通过。

最终根集成 **17/17通过**（18.25秒），无 skip；全局类型检查通过。重复参数校正为统一非法查询422 `INVALID_RESOURCE_CHECK_QUERY`，保留确切错误码验证。资源固定路径 PATCH405、GET200、普通账号403、匿名/撤会话401均通过。

| 范围 | 真实根组合已验证 |
| --- | --- |
| C01 账号 | 本人安全投影导出、旧版本拒绝、跨账号404、下载时当前空间权限复核；最后管理员申请blocked→转交→pending→cancelled且账号仍active；近期认证；双邮箱码验证、稳定userId、旧会话全撤销；账号版本变化不消费挑战 |
| C02 成员与经验 | 实际迁移032接受记录关联真实membership；重复接受不重耗名额；归档撤邀请409且project/邀请/审计/事实完全不变；个人经验预览UI待下面375px结果 |
| C03 材料 | 已确认赛事真实材料清单与不可变历史；引用版本冲突拒绝；材料自报不冒充运行验证/正式提交；必选分支unknown；成员可读/管理可写、归档只读；写后撤session全事务回滚 |
| C04 纠错与审计 | 纠错→triaging→confirmed→本人站内响应；审核CAS；游标签名与分页；仅元数据，无正文/证据URL；普通账号、撤admin、撤session拒绝 |
| C05 经验与草稿 | 私人经验列表、历史、选择性复用；归档、转交/离队、迟到权限变化；本人保留草稿引用metadata、正文不越权展开；未完成文字与空白保留、mutation/CAS、归档后导出删除；旧M07写后撤session全回滚 |
| C06 技能 | 新固定版候选→真实审核→发布→项目选择/复制→撤回；三个hash域分别核对；兼容性仍installer_declared；成员只读、平台admin不越项目membership、归档只读；历史不自动升级，无安装或AI副作用 |
| C07 可观测与维护 | 来源历史unknown不因跨日解除；每日calls与来源范围准确；GET不改变来源/AI账本；资源状态GET不初始化lease；busy/waiting不写；旧worker finally无法清新owner lease；保留期仅清过期导出正文和临时本地邮件 |

运行命令：

```powershell
node --experimental-strip-types --test src/server/completion-integration.test.ts
node node_modules/typescript/bin/tsc --noEmit --incremental false
```

根测试中的所有 fetch 调用计数为0。真实外部抓取、SMTP/Resend、目标PostgreSQL多连接并发、GitHub、八种真实技能客户端任务等仍属于目标环境验收，不能从这些隔离测试推导成功。

## 移动端验收

`tests/e2e/completion-account-experience.spec.ts` 新增9条375px真实根页面场景，主会话新版localhost启动后完整复跑 **9/9通过**（19.7秒），exit0，无skip；Playwright `--list` 9条，`npm run typecheck` exit0。前轮旧bundle缺新按钮/页面的失败只反映旧构建；新版首轮两个区域/标签定位器按实际可访问语义修正后，定向和完整复跑均通过。没有修改组件或mock成功响应以满足测试。

浏览器覆盖：

1. 本人画像真实保存→经验预览→明确追加，保留原有/未保存文字，经验共享恢复为false，之后由本人明确选择共享；私人画像不更改。
2. 预览请求期间被移除，迟到真实响应不能恢复旧表单或泄漏私人技能。
3. 私人经验卡创建/确认→本人库→仅选建议复用→刷新保留→删除草稿，来源经验仍保留。
4. 合成官方证据通过真实M08人工审核发布→确认赛事→材料清单保存/版本冲突保留输入→成员只读；未知分支与提交状态保持独立。
5. 真实纠错→运营处理→站内响应与元数据审计；撤admin后旧行隐藏且拒绝写入。
6. 真实已确认规则、精确窗口和手动计划→blocked→根worker提醒→已读；active风险收起409且任务仍blocked；退出后旧行隐藏。
7. 双邮箱码验证→撤旧登录→新邮箱重新登录，userId、个人画像与空间归属保持。
8. 固定技能版本本地选择与刷新保留→真实保存→成员只读→运营精确撤回→历史不自动升级，八工具仍installer_declared，无安装计划/回执。
9. 账号导出本人资料，其他账号不可下载；最后管理员删除申请blocked、持久化且可以cancel，账号仍有效。

全部API由真实dispatch进入owned内存PGlite，不mock组件/成功响应。统一复用主会话 `isolated-workspace.ts` 的逐段decode，与Next catch-all路径语义一致。trace、video、screenshot关闭；各场景验证375px无横向溢出、browser outbound为0、付费模型账本为空，技能场景安装计划/回执为空。邮件只使用隔离development_mailbox。

运行命令：

```powershell
npx playwright test tests/e2e/completion-account-experience.spec.ts --workers=1
npm run typecheck
```

## NEEDS_INTERFACE 与交还

没有新增跨模块接口要求；本轮仅调用已接入根服务。外部环境变量值未读取或输出。本会话未build/start/install、未打开生产数据库、未执行真实迁移，未调用真实邮件/模型/GitHub/安装桥接。

2026-10-10：移动端代理已明确停止编辑；根集成、测试复核及交付说明完成。上述三个本轮文件全部交还主会话，不沿用本轮授权继续覆盖文件。主会话负责整体构建/上线与目标环境验收。
