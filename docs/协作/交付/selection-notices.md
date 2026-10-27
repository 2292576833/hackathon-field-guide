# O05 专属入选通知 UI交付

2026-10-11。本会话只编辑新 `src/modules/selection-notices/` 和此交付文件；根API、O02 slot、页面、实际迁移、构建、部署、真实邮件由主会话接入。

## NEEDS_INTERFACE

当前已只读对照根 `organizer-notifications.ts`。根最新消息已明确：只读 staff GET 返回 `{items,recipient:{userId,label},registrationRevision}`；模板预览姓名为示例，UI独立显示真实收件人label，正文明确姓名由服务器发布时替换，实际结果只取服务端回执。按此已实现，不因可选增强接口缺失阻塞。

可选增强：staff GET 附 `preview:{templateRevision,subject,body,accent,theme}`，用本场已保存模板与服务端当前收件人姓名/赛事/主办方替换，并复核同场报名/版本/账号/权限；只读不发送邮件。UI支持此字段，且仅接受与已读模板revision一致的预览。UI只发送模板revision与目标/报名revision，不发送替换后正文。模板revision为0时禁发。

建议附加 `registrationId` 和 `event:{title,organizationName}`，以绑定本次报名ID并在通知局部明确当前赛事/身份。`GET/PUT .../selection-notice-template` 可附 `event:{title,organizationName}` 供模板示例预览；若不附，模板草稿预览以“当前比赛/本场主办方”明确示例，已保存预览仍显示根返回的安全文本。

`SelectionNotice` 按根当前类型：`id,eventId,registrationId,registrationRevision,version,templateRevision,subject,body,accent,theme,publishedAt,mailState`，不要求或展示邮箱。本人 GET 按根收尾消息返回 `{items,registrationStatus,registrationRevision}`，UI已据此说明当前资格与历史通知的区别。邮件状态按 `unconfigured|queued|leased|sending|accepted|unknown_hold|failed|cancelled` 分别显示，不把 accepted 写成已送达。

根接入需保证 approved行slot使用报名自己的eventId；报名编辑器保留旧赛草稿时，不应让外部slot闭包用新eventId。busy/unknown发布操作在组件内存中，模块提供浏览器关闭/内部链接离开提示；父级若通过筛选或eventId变化卸载此行，建议保留待核对行或先提示核对，以免未决操作的原key因卸载丢失。

## 已完成

- `ui.ts` 导出 `SelectionNoticeTemplateEditor({eventId})`、`SelectionNoticeAction({eventId,registration:{id,userId,revision,status}})`、`MySelectionNotices({eventId})`；`index.ts` 保持纯类型/规则/受控发布导出，README提供根接入示例。
- 模板标题/正文/三种变量/两种样式/四种强调色；实际React文本节点预览，不执行HTML。PUT使用expectedRevision；冲突与网络失败保留草稿，显式读取成功后才替换；首次GET失败可恢复编辑。切赛保存/放弃/继续原赛，保存中禁切换。
- approved行点击后读取staff受限收件人/既有通知，显示真实label和明确示例姓名的安全模板预览；显式勾选确认才发布。新版本另需明确确认、匹配现版及独立operation key；失败/未知保留同一次完整输入并只以原key重试。双击禁重入，回执赛事/报名/版本不符不显示成功。
- 本人列表刷新只读；显示根最新邮件状态、发布时间及历史报名版本，当前撤回/拒绝/待审不会因历史通知被写成仍具资格。accepted明确“服务已接受，收件与已读未确认”，unknown_hold明确暂停自动重发。
- 401/403/404及会话失效事件清本模块草稿/预览/收件人/回执和useApi私有缓存，存活/清除标志拒绝采用晚响应。暖白橙红、44px操作、单列手机布局与长文字换行。

## 已验证（受控，无真实外部服务）

2026-10-11完成：

```powershell
node --experimental-strip-types --test src/modules/selection-notices/model.test.ts src/modules/selection-notices/publication.test.ts src/modules/selection-notices/preview.test.ts
```

17/17通过：白名单与文本约束、HTML安全React文本渲染、两样式四颜色、首发/新版参数、同操作双点/成功重放、未知和拒绝重试原完整输入、错误回执拒绝、模板更新不触发发布、历史通知与当前资格、邮件状态文案。preview.test在测试进程内转译实际组件，无产物或应用构建。

`node node_modules/typescript/bin/tsc --noEmit --incremental false` 完成（exit 0），不写根tsbuild缓存。只读独立复审确认修复读取恢复、邮件状态刷新、忙时禁切赛、内部导航提示及私有缓存清理，未发现阻断模块交付的明确缺陷。

## 未接入与实际验收边界

根页面/approved slot、根API组合、实际数据库迁移、生产构建/重启/部署由主会话完成。390px仅样式静态复审，真实根页面/浏览器、权限与CAS数据库并发、真实邮箱收件均未在此会话验收。未连接真实数据库、发送邮件、构建/重启应用、安装依赖或改授权范围外文件。没有新增环境变量或依赖。

## 交还

O05已完成交付并停止编辑；`src/modules/selection-notices/` 和此交付文件交还主会话统一接入/验收。后续修改须主会话重新明确授权。
