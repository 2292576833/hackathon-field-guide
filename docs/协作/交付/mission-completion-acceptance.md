# 任务式协作补齐验收

2026-10-10。主会话临时授权仅新增 `tests/e2e/mission-completion-acceptance.spec.ts` 与本交付文档；产品代码、公共规划、生产数据库和外部模型均不修改或访问。

## 已准备

四项浏览器闭环测试使用现有 `isolatedWorkspace`：实际根 `createApplication`、递增迁移、内存 PostgreSQL、根 `dispatch`、实际 HTTP handlers 和当前生产页面。没有组件 API 响应 mock，没有启用模型、采集 worker 或真实发信。

1. 375px 手工填写私人职责和经历，预览仍不公开，明确确认后仅发布所选名片内容，游客可读；撤回后公开页消失，本人私人资料保留。年龄、MBTI 默认不公开。
2. 管理员在空间公开招募，新人提交申请，管理员审核通过仍无成员身份；本人勾选并确认后真实加入，仅普通成员，重复调用不创建新邀请或第二个成员。
3. 已保存私人空间 AI 回答通过实际 GET 读取。编辑摘录、预览和确认分享分开；队友仅看到摘录，实际根上下文读取包含有效建议。采纳不自动产生计划；本人撤回后动态正文和后续上下文均消失，私人原记录保留。
4. 其他账号与其他空间不能冒用私人回答来源。清空本人私人来源后，原分享变为正文不可用记录，队友上下文不再包含旧摘录；请求历史仍保留。

## 模拟与真实边界

私人回答是测试明确插入隔离 `team_assistant_requests/messages/conversations` 的成功记录夹具，内容带隔离标识。它不代表本轮真实调用 DSH；本轮实际验证的是记录读取、来源归属校验、显式分享、成员可见性、采纳/撤回与上下文投影。所有这些读写都走真实根接口及存储，不以静态 UI 回包冒充。

测试使用隔离 `.test` 邮箱、开发邮件夹具和已有完成首登的测试账号；不证明真实验证码收件、手机公网证书、远程 PostgreSQL 并发、真实模型质量或主办方接受提交。浏览器外网请求被阻断，显式断言没有 AI 账本调用或生成请求。

## 执行记录

已执行 Playwright `--list`，四项用例均可发现；使用 `--strict --module NodeNext --moduleResolution NodeNext --target es2022 --skipLibCheck --allowImportingTsExtensions --esModuleInterop --jsx react-jsx` 对新测试及其导入进行 `tsc --noEmit` 检查通过。首次未带 `--strict` 的独立检查在既有 planning/member-display 的类型推断处失败，改用与项目一致的严格配置后通过，没有修改产品文件。

主会话确认现有规划19生产页面可以检查后，执行四项首跑：**1通过、3失败，1.7分钟，退出码1**。日志 `.runtime/mission-completion-existing.log`，结果目录 `.runtime/e2e-mission-completion-existing`。手工名片的私人/预览/发布/游客读取/撤回完整闭环通过。

招募用例的失败为本测试 `filter({has: ...})` 错误保留外层region路径；实际失败快照已经展示真实申请、昵称和审批输入。已将子定位改为相对article的heading，并同步修正共享动态中的同类定位，未修改产品。

后两项在真实邀请接受API返回500：并行C开发已使当前M02 INSERT包含 `projects_invitation_acceptance.membership_id`，但截至首跑根迁移尚未提供此字段。生产页面是先前构建，隔离根API却加载当前源代码，因此受到尚未组合的数据契约影响。没有临时ALTER测试数据库或绕过邀请加入来掩盖该问题，已报告主会话，待根迁移组合完成后重新运行。此结论是当前开发接入边界，不据此认定先前生产构建已经出现同一故障。

主会话组合 `032_invitation_membership_history.sql` 与 `033_project_material_checklist.sql` 后，重新完整执行本文件四项：**4/4通过，19.1秒，退出码0，没有重试**。日志 `.runtime/mission-completion-recheck.log`，结果目录 `.runtime/e2e-mission-completion-recheck`。隔离应用执行实际根迁移，不添加测试专用ALTER或修改产品逻辑；没有放宽加入、确认分享、来源归属、撤回及上下文删除断言。首跑失败日志保留，不覆盖历史。

截至此次复测，上述四条规划19浏览器+真实根接口闭环均已验证。本次没有发现新的产品缺陷；测试定位已修正，C邀请记录的数据契约接入由主会话补齐后正常。迁移033被隔离应用初始化读取，不表示本文件已经验收新材料清单UI/API。C系列新功能仍待根通知最终入口后追加场景。

新 C 系列 API/页面组合完成后按主会话通知追加相关场景，仅继续编辑上述授权文件。不运行构建、重启网站、打开持久 PGlite 或变更依赖。

## NEEDS_INTERFACE

既有19功能无需新增接口。后续 C 系列验收需要主会话提供最终路由、页面入口和权限/状态契约，避免测试仍断言旧页面或假定接口已经接入。
