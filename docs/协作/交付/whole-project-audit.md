# 全项目定向审计交付

审计时间：2026-10-11（Asia/Shanghai）  
范围：公开赛事列表与分页、导航员入口、聊天 HTTP 错误映射。  
边界：只读审计；未启动服务、未构建、未读取生产数据库、未调用真实 DSH。

## 定向测试结果

在独立内存数据库和测试替身上运行：

- `src/server/navigator.test.ts`
- `src/server/discovery-live.test.ts`
- `src/server/project-discovery.test.ts`
- `src/server/discovery.test.ts`
- `src/server/native-discovery.test.ts`
- `src/server/discovery-sources.test.ts`
- `src/server/dsh-chat.test.ts`
- `src/server/onboarding.integration.test.ts`
- `src/server/navigator-site-search.test.ts`
- `src/server/team-mission-integration.test.ts`

两轮合计 **105 项通过，0 项失败**。覆盖了公开赛事卡片保留（包括报名未知/已结束）、游标分页、实时元数据只读、来源证据边界、导航搜索权限、DSH 未配置拒绝、聊天来源固定为 DSH、Origin/会话/项目权限校验和安全错误封装。

## 发现与建议

### P2：游客打开“向 AI 提问”后，“清空保存的对话”仍可点击

`src/components/navigator.tsx` 中清空按钮只根据 `action.busy` 禁用，没有同时判断 `identity.data`。游客虽然不能输入或发送，但仍可点击该按钮，随后请求 `DELETE /navigator/conversation`，服务端返回 401，页面显示“请先登录”。这会让首次使用者误以为清空功能异常。

最小修复：将按钮禁用条件改为 `action.busy || !identity.data`；同时可在游客状态显示“登录后可清空保存的对话”，避免无效请求。

### P1（部署配置项）：公网访问地址必须与 `AUTH_ORIGIN` 完全一致

路由在所有非 GET 请求进入具体处理器前执行 Origin 校验。通过内网穿透域名访问时，如果 `AUTH_ORIGIN` 仍是本机地址或旧端口，导航员、团队助手和个人生成请求都会返回 `403 ORIGIN_FORBIDDEN`。这不是 DSH 调用失败，应在部署验收中先检查 `/api/v1/system/status`、`/api/v1/me` 和浏览器实际 Origin。

修复方式是配置完整的公网来源（协议、域名、端口均一致）后重启；不要放宽为通配 Origin，也不要信任未经验证的转发头。

## HTTP 映射核对

`toErrorEnvelope` 不泄露堆栈或供应商响应，并保留 DomainError 的 `code`、安全消息、恢复提示和最新版本号。公开赛事 GET 不要求登录；无效游标/筛选条件进入明确的 4xx 错误。聊天常见错误映射如下：401 未登录、403 来源/项目权限、409 DSH 会话占用或未知请求、429 导航员限流、503 DSH 未配置或严格 JSON 输出失败。

## 未执行项

本次未运行 Playwright 浏览器实机回归，因为该回归需要已运行的预览/生产 HTTP 服务；也未验证真实 DSH、公网 FRP、生产数据库或外部邮件。应由主会话在其已授权的隔离预览中补做真实浏览器检查。
