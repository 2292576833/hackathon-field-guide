# 比赛信息折叠 · 浏览器验收交付

日期：2026-10-11。执行会话：event_disclosure_acceptance。状态：已交付并 STOP，文件交还主会话。

## 已完成

- 更新 `tests/e2e/event-participation.spec.ts`：默认隐藏完整摘要、全部建议和备赛操作；报名入口仍能直接打开；Enter 展开、Space 收起；展开显示全部建议和个人计划/团队空间链接；两张卡可同时展开并独立收起；旧分析不补造参赛结论，搜索引用的未读取全文说明始终可见；不安全或无证据的报名地址没有可操作链接。
- 更新 `tests/e2e/event-analysis.spec.ts`：移除访客会自动弹出导航介绍的旧预期；按新比赛信息入口展开后读取原有依据；保留 61 条真实 SQL 夹具分页、来源类型、日期、链接及弹窗隔离验收。
- 更新 `tests/e2e/realtime-discovery.spec.ts`：新增长轮询读取保存结果后，同 ID 卡片信息及其分析依据保持展开、第二张卡保持独立展开、新卡默认收起的行为验收；更新详情改由显式展开后读取。保留已有断连、截止后仍显示、历史页位置、超时和重试验收。
- 更新 `tests/e2e/personal-workspace.spec.ts`：个人计划入口从比赛信息折叠区进入，继续核对登录跳转保留实际赛事且访客不发起模型请求。
- 在 320、390、1280 像素宽度检查默认及展开状态均无横向溢出；展开触控区域高度至少 44 像素；包含长连续英文的内容仍能换行。390/1280 默认与展开截图已生成并目视检查。

## 已验证

主会话提供 `.next-event-fold` 的无 `FIELD_GUIDE_SERVE` 隔离页面服务 `http://127.0.0.1:3012`，HTTP 返回 200 后执行：

```powershell
$env:E2E_BASE_URL='http://127.0.0.1:3012'
& 'C:\Program Files\nodejs\node.exe' node_modules/@playwright/test/cli.js test tests/e2e/event-participation.spec.ts tests/e2e/event-analysis.spec.ts tests/e2e/realtime-discovery.spec.ts tests/e2e/personal-workspace.spec.ts --output=.runtime/event-fold-results
```

结果：**24/24 通过，0 失败、0 跳过，50.2 秒，进程退出码 0**。其中赛事分析 3 项、报名建议 8 项、个人备赛 3 项、实时更新 10 项。未为同一变更追加重复测试轮次。

日志：`.runtime/event-fold-browser.log`。测试产物：`.runtime/event-fold-results`。

截图（均为明确标注的隔离赛事，不能作为真实赛事发现或生产数据截图）：

- `.runtime/previews/event-fold-390-collapsed.png`
- `.runtime/previews/event-fold-390.png`
- `.runtime/previews/event-fold-1280-collapsed.png`
- `.runtime/previews/event-fold-1280.png`

## 真实验收边界

上述测试通过拥有的浏览器上下文拦截 API，其中 SQL 场景运行独立内存 PostgreSQL 兼容数据库和真实业务路由，其余场景使用明确的 HTTP 夹具。未打开生产 PGlite 目录，未接触真实 DSH、邮件、报名站点或社交平台，未发起收费请求。弹窗中的外部赛事文档也由测试拦截提供。

本会话未运行生产构建、重启、迁移、环境配置或域名操作。构建接入、最终全局类型检查与生产部署由主会话负责；本交付不表示实体手机或普通公网 DNS 已修复。

## NEEDS_INTERFACE

无新增接口、依赖或环境变量。测试沿用 `E2E_BASE_URL` 与现有隔离测试基础。

## 文件交还

本轮仅修改以上四个授权测试文件及本交付文档；无继续编辑。所有临时文件授权现已结束。

## 2026-10-11 追加：缺失 robots 文件的运输修复

本轮根临时授权仅 `src/modules/operations/node-network.ts`、`node-network.test.ts` 及本交付追加。已在完整请求地址与实际 peer 验证之后，对精确 `/robots.txt` 的 HTTP 404/410 保留真实状态、受限响应字段和空正文，停止读取无用的错误网页；统一清理先消费结果并移除 abort 监听，再关闭代理和销毁响应/请求连接。错误监听保留，迟到错误不覆盖已确认结果。

正常 robots 响应、其它路径的 404/410、固定 IP/TLS/peer、压缩与体积限制沿用原规则。现有 `robots-policy.ts` 早已将真实 404/410 解释为 missing，本轮未改策略、缓存或数据库。

隔离验证：`node --experimental-strip-types --test src/modules/operations/node-network.test.ts src/modules/operations/robots-policy.test.ts src/modules/operations/node-proxy-transport.test.ts` 共 35 项通过。新增行为涵盖 404/410 巨大/压缩且不结束的错误体不读取、两端销毁及 abort 清理、下游 missing 语义、200 和非 robots 页面继续体积拒绝、peer 或 TLS/request 失败继续拒绝。另经独立只读安全复核，无必须修复问题。

未发起真实网络、DSH 或付费调用，未打开生产数据库、运行构建/重启或修改 DNS。根负责最终生产验证。两个代码文件已交还，停止编辑，STOP。
