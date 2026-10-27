# P05 新人材料与名片入口交付

日期：2026-10-11。范围仅为 `src/components/roadshow-client.tsx`、`src/components/ppt-client.tsx`、`src/components/recruiting-client.tsx` 与本交付文档；P03 已交还文件未继续修改。

## 已完成

- 路演首屏提供“填写我的作品”主入口，真实项目来源、本人输入、生成状态、结果及历史先于教程。原创案例、时间分配与排练提示按需展开；有内容的选填输入保持展开，避免收起尚待提交内容。当前输入、真实错误、请求结果未知、预算回执及已保存来源仍就地可见。
- PPT 首屏提供“准备或继续我的大纲”主入口，本人工作区先于模板讲解和工具列表。工作区直接选择原有大纲结构与时长，保留当前真实来源、历史、编辑区和生成回执；原创模板说明、逐页讲解、下载与工具按需展开。原有模板、主办方要求、官方链接、适用条件和核验信息均保留。
- 路演案例与 PPT 教程/工具的原有页内链接打开目标 details，并将焦点放到 summary。页面初始 hash、hash 变化及同一 hash 重复点击均支持就地展开。
- 招募大厅的“准备我的名片”沿用原有 `profileHref` 参数，改为本页 `#recruiting-profile`。本人资料载入后打开原有名片 details 并聚焦 summary；再次点击同一锚点仍可展开。未修改模块 Lobby/Editor，也未更改本人资料、确认发布、邀请或加入流程。

本轮只改变展示顺序、折叠和页面入口。生成、持久化、共享、来源采纳、本人/会话隔离、未知请求 hold、权限和真实链接逻辑保留；不新增完成状态，不按阶段推定完成，不新增 AI 记忆或业务事实。

## 已验证

- `C:\Program Files\nodejs\node.exe node_modules\typescript\bin\tsc --noEmit --incremental false`：退出 0。
- Node 既有行为测试：roadshow 的 roadshow/content/project-context、ppt 的 ppt/templates/generation、recruiting 的 service/handlers，合计 97 个测试通过，0 失败。使用注入模型与内存数据库测试夹具，未调用真实 DSH、邮件或生产数据库。
- 源码核对：教程折叠不包含本人编辑区、错误、未知请求或真实回执；PPT 主按钮使用现有 actions/button 样式，避免 jumpLinks 链接颜色覆盖按钮文字；同页锚点保留 URL 上的项目上下文并聚焦目标 summary。

## 未验证边界

未执行构建、启停服务、生产迁移、生产数据库访问、真实付费模型/邮件调用或浏览器新版本走查。新构建与隔离页面服务的视觉和焦点验收由主会话组合执行，本文不表示部署或实体设备已通过。

## NEEDS_INTERFACE

无。无新增环境变量或依赖。

## STOP 与交还

P05 已完成并停止修改，上述三个组件及本交付文档全部交还主会话。本轮临时授权结束；后续修订须由主会话再次授权。
