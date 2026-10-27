# 专属入选通知 UI

按规划22提供本场模板编辑、已通过报名行的定向发布确认、本人通知查看。只操作根提供的 API；本模块不拥有通知数据库或邮件发送器。

## 接入

从 `ui.ts` 导入三个客户端组件：

```tsx
<SelectionNoticeTemplateEditor eventId={eventId} />
<RegistrationManager eventId={eventId} renderApprovedActions={registration =>
  <SelectionNoticeAction eventId={registration.eventId} registration={registration} />
} />
<MySelectionNotices eventId={eventId} />
```

根页面负责提供当前比赛/主办方上下文与登录状态。行 slot 应使用报名记录的 `registration.eventId`，避免报名编辑器保留旧赛草稿时，外部闭包将旧行配上新赛ID。本模块不导入报名模块私有代码，也不替代服务器权限复核。

`index.ts` 导出类型、纯验证函数和受控发布请求状态；UI 独立从 `ui.ts` 导入，避免 Node 服务导入 CSS/React 组件。

## API（`components/client-api.ts` 自动添加 `/api/v1`）

- `GET/PUT /organizer/events/:id/selection-notice-template`：模板 `{eventId,revision,subject,body,accent,theme,preview:{subject,body}}`，PUT 发送 `{expectedRevision,subject,body,accent,theme}`。标题最多200字符且单行，正文最多12000字符，仅允许 `{name}/{event}/{organizer}` 三种变量。
- `GET /organizer/events/:id/selection-notices?recipientUserId=...`：`{items,recipient:{userId,label},registrationRevision}`，用于已通过者预览与已有版本读取。可选 `registrationId,event:{title,organizationName},preview:{templateRevision,subject,body,accent,theme}` 支持更明确上下文和服务端定向预览。
- `POST /organizer/events/:id/selection-notices`：首发 `{recipientUserId,expectedRegistrationRevision,templateRevision,expectedNoticeVersion:0}`。已有通知时先显示版本、预览和两项确认，再发送 `expectedNoticeVersion,confirmNewVersion:true,newOperationKey`；一次操作的失败重试沿用原始完整输入。
- `GET /competitions/:id/selection-notices`：仅当前账号本场 `{items}`。通知字段见 `model.ts`，不展示邮箱/答卷，不把历史入选通知当作当前资格。

staff接口目前的模板预览姓名是示例，UI单独显示服务器返回的真实收件人，并明确发布时姓名由服务端替换。若根返回与模板版本一致的定向 preview 则显示该内容。实际发出的标题/正文始终来自服务器回执，不在客户端构造发送结果。

## 恢复、状态和边界

- 保存模板/读取最新失败均保留草稿；CAS冲突不会静默采用新revision。点击“载入最新”明确放弃草稿，成功读取后才替换，读取失败仍保留；首次读取失败后显式恢复可以继续保存。
- eventId切换时，未保存模板提示保存/放弃/继续原赛；保存进行中禁切。离开页面有未保存提示；component key 与存活/权限标记阻止晚响应污染新赛。
- 401/403/404及全站会话失效事件清独立草稿/预览/收件人/回执和useApi缓存。重新打开页面后重新取权限。
- 通知发布需要明确确认；GET/刷新不会POST。首发0版本重放只得到旧回执，不把模板更新当作新通知。未知结果保留本次参数并只允许相同操作重试，不另造key。刷新成功后使用GET最新邮件状态；刷新失败保留上次回执并显示错误。
- `unconfigured/queued/leased/sending/accepted/unknown_hold/failed/cancelled` 单独显示；accepted不宣称送达或已读，unknown_hold没有自动重发入口。
- pending操作在组件内存中。busy/unknown有关闭浏览器/内部链接离开提示；父级在操作中卸载approved行（切赛/筛选）需要根协调。服务器的CAS/幂等是最终保障，根可保留待核对行或提示先完成核对。
- 390px样式使用单列布局、控件100%、最小44px操作、长字符串换行、文本正文和可见键盘焦点。真实根页面嵌入与手机浏览器由根验收，本模块没有实际浏览器/生产构建/数据库/邮件测试。

## 受控验证

```powershell
node --experimental-strip-types --test src/modules/selection-notices/model.test.ts src/modules/selection-notices/publication.test.ts src/modules/selection-notices/preview.test.ts
node node_modules/typescript/bin/tsc --noEmit --incremental false
```

`preview.test.ts` 在Node测试进程内读取并转译实际预览组件，CSS仅映射类名，不输出构建产物；验证React文本转义和状态文案，不能替代浏览器布局检查。发布测试使用注入的受控函数，没有连接真实服务。

无新依赖、环境变量、数据库迁移、模型调用或真实发送权限。
