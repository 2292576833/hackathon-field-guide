# 主办方自配发信邮箱 UI交付

2026-10-11追加授权。仅新 `src/modules/organizer-mail-settings/` 与此新交付。已交还 selection-notices 保持停止，不改根文件/配置/迁移/旧模块，不发送邮件或安装依赖/构建/启动。

## NEEDS_INTERFACE

根已确认并只读对照 `src/server/organizer-mail-accounts.ts`，实际采用 `GET/PUT /organizer/organizations/:id/mail-account`、`POST .../mail-account/disable`，没有猜造DELETE接口。GET/PUT/disable都返回 `{organizationId,revision,state,provider,maskedEmail,verifiedAt,updatedAt,profiles}`，PUT输入 `{expectedRevision,provider,email,authorizationCode}`，停用输入 `{expectedRevision}`。

GET不得含密码/授权码/密文。保存仅SMTP验证与当前manager权限成功才生效，不能发送选手邮件。非secret字段失败保留，secret只在控件内存，不写浏览器存储/日志；认证失败给官方帮助入口。

根最新修订：provider只支持 `qq/163/126/gmail`，Outlook需ModernAuth/OAuth2，不列为密码方式已支持。此设置仅本机构赛事官方通知/入选通知，登录验证码仍使用网站邮箱。

所需根接入：在当前主办方管理区展示 `SenderSettings({organizationId})`，机构名称/当前身份由根工作台上下文提供；GET/PUT/POST权限必须根当前 organization_admin+approved 和同机构CAS。没有其它必需新接口。

## 已完成

- `ui.ts` 导出 `SenderSettings({organizationId})`，`index.ts` 导出纯类型/安全projection/校验/固定帮助，README记录根入口与HTTP契约。
- 四种固定SMTP服务、手工完整邮箱与password控件。根只读safe metadata显示脱敏账号、状态、版本/时间；不会把mask回填email，不保存额外secret/cipher字段。
- 明确说明仅本机构官方通知/入选通知，验证码仍网站发信；未配置或停用采用网站邮箱，并说明实际可发性取决于平台配置；Outlook不冒充已支持。
- 保存前说明仅SMTP连接与认证验证，不给选手发测试邮件，确认后PUT；正确同机构verified/provider/expectedRevision+1才显示成功。停用需明确确认，POST /disable CAS成功后才显示停用。GET/刷新不会验证或发信。
- 授权码只在当前密码控件内存，不写浏览器存储/日志；更改邮箱/provider、实际提交、权限失效清除。失败保留完整邮箱/provider；已知认证失败503说明未保存/原配置保留，网络未知/版本冲突说明读取核对，不自动重试。固定code生成安全错误，不打印原始SMTP异常。
- 20秒读取、30秒提交有限等待；未知或任何服务端变更失败必须先明确GET核对再填授权码/确认。根60秒间隔/每天10次验证上限有恢复说明。需要核对时旧metadata标为上次读取，不把未知结果写成当前已生效。
- 未保存切组织支持验证保存/放弃/继续原组织，忙时禁切；浏览器关闭/内部导航提示；key/alive/cleared/read-generation 防晚响应串机构。401/403/404与unauthenticated事件清meta、输入、成功提示并锁定。
- 暖白橙红、44px控件、390px换行/100%表单/min-width:0及可见焦点。

## 官方帮助来源（只读）

- [QQ邮箱官方帮助](https://service.mail.qq.com/) 根入口可读，授权码旧深链正文未取得且只读浏览器尝试未成功，首版使用入口＋搜索SMTP/授权码，不假装已验证具体深链。
- [网易客户端授权码说明](https://help.mail.126.com/faqDetail.do?code=d7a5dc8471cd0c0e8b4b8f4f8e49998b374173cfe9171305fa1ce630d7f67ac286624f309a1a7089) 官方正文已读取，163/126共用。
- [Google应用专用密码说明](https://support.google.com/accounts/answer/185833?hl=zh-Hans) 中文官方正文已读取，先两步验证并提示账号限制。

## 已验证 / 模拟与实际边界

2026-10-11：`node --experimental-strip-types --test src/modules/organizer-mail-settings/model.test.ts` 6/6通过，覆盖固定provider/邮箱格式/secret不进错误文本、安全projection去除额外secret/cipher、跨机构与错误版本拒绝、CAS完整输入、已知认证失败与网络未知/频控说明。

`node node_modules/typescript/bin/tsc --noEmit --incremental false` 完成，exit 0。独立只读复审未发现阻断交付的明确缺陷；390px仅静态复审，未运行真实浏览器。

没有读取.env/实际凭据、登录真实邮箱、SMTP验证/发信、生产数据库/迁移、构建/重启/部署或安装依赖。根页面与真实API/SMTP/权限数据库/手机浏览器仍由主会话验收。本模块没有新环境变量或依赖。

## 交还

已完成并停止编辑。仅本次新 `src/modules/organizer-mail-settings/` 与此交付文件交还主会话；旧 selection-notices 全程未修改。后续编辑须新明确授权。
