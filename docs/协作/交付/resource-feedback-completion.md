# 资源反馈与正式赛事根接线交付

日期：2026-10-10。仅修改主会话本次授权文件；交付后停止编辑并交还。

## 已完成

- `src/components/discovery-client.tsx` 给 M09 ResourceDetail 注入 `onReport`，就地展开资源问题表单；详情可查看当前资源或全部资源的本人反馈，资源列表页有“我提交的资源反馈”入口。
- 新 `src/components/resource-feedback.tsx` 提交真实公开资源内容版本、问题类型、说明与最多五个依据链接。匿名不发送，登录返回保留当前位置。成功只表示反馈已保存，不能表示资源已修正。
- 复用唯一 M08 队列：`POST /api/v1/corrections`，`GET /api/v1/me/corrections?limit=100`，`GET /api/v1/me/corrections/:id`。不新增路由、数据表、采集、DSH 调用或第二套处理状态。
- 状态使用真实 `received / triaging / confirmed / needs_more_info / dismissed / resolved`；“已采纳、待修正”和“已处理完毕”分别展示，显示本人说明、来源依据、运营回复、处理关联版本与更新时间。查询范围明确为本人最近 100 条反馈中的资源反馈，不承诺完整历史。
- 新 `src/modules/resources/feedback-client.ts` 是浏览器的临时交互状态，非服务器持久存储；账号切换、退出、权限错误和被忽略的取消请求均不能回填旧私人结果。普通失败保留输入，401/403 清除私人数据并停止新写入，404 清除失效查询结果。
- 提交结果未知时先核对真实本人列表，不自动重发；找到同目标、版本和说明的记录可恢复真实回执。未找到不视为失败，只有用户核对后明确选择才允许再次提交。
- 正式赛事详情组合 C03 `EventCorrectionPanel`，传正式 M03 `eventId/currentEvent` 与真实 `/me` 用户 ID，不传 DSH 发现卡片身份。
- 项目规则页组合 C03 `RuleChangesPanel`，读取真实 `/projects/:id/rules/changes` 并展示逐字段差异。读取失败明确说明无法判断有没有变化；确认成功后重新读取当前规则、变化与公开版本，不自动改任务计划。
- 三处 EventRulesPanel 使用 `/me.profile.timezone`；账号时区读取完成前不先显示错误的“你的时间”。游客明确浏览器时区；浏览器时区不可确定时明确北京时间。`localTimeLabel` 区分账号时间、浏览器时间和北京时间，原始时区与日期精度由 C03 Panel 保留。
- 私人收藏与空间列表读取在 401/403/404 时清除缓存结果，避免权限失效后仍显示先前的私人内容。

## 已验证

- `node --experimental-strip-types --test src/modules/resources/feedback-client.test.ts`：14/14 通过。覆盖匿名禁写、状态与回复、跨账号晚到结果、退出期间晚到回执、其他用户伪造结果、401/403/404 缓存清除、准确版本、错误回执、未知请求恢复/明确重提及依据链接边界。
- `node --experimental-strip-types --test src/components/resource-feedback.test.ts`：2/2 通过。使用全新隔离真实 PGlite、根 createApplication/dispatch 和实际 M09→M08 审核发布流程，验证根资源反馈、运营处理、本人详情、其他账号 404、查询参数不能改数据主体、匿名与错误 Origin 拒绝、撤销真实会话后的客户端清除。反馈不修改资源，也不产生 AI job。
- 最后一次 `npm run typecheck` 本次文件无错误；全局尚有其他会话正在修复的 `src/modules/space-workflow/service.test.ts` 新交付字段夹具错误，已向主会话报告，未越界修改。

## 验收边界

- 控制器测试使用注入传输；根接口测试使用隔离真实 SQL，未连接生产数据库、外部网站、邮箱或模型。
- 未构建、重启、执行生产迁移或安装依赖。新版实际浏览器、375px、读屏/键盘及生产构建由主会话在交还后统一验收。
- 本人反馈详情保留在 M08；依据链接只是服务器存储的原始参考，不因提交触发抓取或可用性确认。

## NEEDS_INTERFACE

无新增根接口或环境变量。已使用 C03 公共 UI 的准确 props：

- `EventCorrectionPanel({eventId,currentEvent,viewerId})`
- `RuleChangesPanel({comparison,currentRules,latestRules,timeZone})`
- `EventRulesPanel({rules,userTimeZone,localTimeLabel})`

根新增 `ResourceFeedback({resource,identityKey,identityLoading,loginHref,open,onToggle})` 与 `ResourceFeedbackHistory({identityKey,identityLoading,loginHref})` 均已在本次独占 discovery-client 内组合。主会话请将新 `src/components/resource-feedback.test.ts` 纳入本次验收命令；当前模块脚本会发现资源模块下的控制器测试，根 server 通配符不会自动包含该组件目录测试。
