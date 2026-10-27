# 主办方发信邮箱设置

客户端入口 `SenderSettings({organizationId})`，从 `ui.ts` 导入；`index.ts` 仅导出纯类型、校验与固定官方帮助目录。根办赛工作台负责提供机构名称/当前管理身份，并仅向可管理机构展示入口；最终授权由服务端当前 approved 机构的 organization_admin 执行。

```tsx
import { SenderSettings } from "../modules/organizer-mail-settings/ui.ts";
<SenderSettings organizationId={organization.id}/>
```

仅本机构赛事官方通知/专属入选通知使用此设置；认证验证码始终由网站邮箱发送。没有自配设置或明确停用后采用网站发信配置，网站配置不可用时不能宣称已发出。

## 根已确认API

全部复用 `components/client-api.ts`，自动加 `/api/v1`，same-origin凭据与只读GET no-store。

- `GET /organizer/organizations/:id/mail-account` 返回 `SenderAccountMetadata`：`organizationId,revision,state:'unconfigured'|'verified'|'disabled',provider:null|'qq'|'163'|'126'|'gmail',maskedEmail,verifiedAt,updatedAt,profiles:[{id,label,note}]`。仅显示安全脱敏信息，不把mask回填完整邮箱，不保存额外字段。
- 同路径 `PUT {expectedRevision,provider,email,authorizationCode}`。需要手工完整地址/授权码和明确确认；保存仅验证SMTP连接/认证，绝不向选手发测试邮件。只有正确机构、verified、同provider、expectedRevision+1回执才显示保存成功。
- `POST /organizer/organizations/:id/mail-account/disable {expectedRevision}`。二次明确确认，正确机构/disabled/expectedRevision+1后才显示停用成功。

provider固定为 QQ/163/126/Gmail，与根固定SMTP主机一致，不开放自定义host/port/TLS或OAuth配置。前端邮箱格式与authorizationCode<=4096和根一致，不额外添加根未要求的邮箱domain限制；有效性以真实SMTP认证为准。Outlook本轮不提供此授权码方式，明确可继续使用网站邮箱。

## 状态恢复与秘密处理

授权码仅当前密码控件的React内存，`type=password`、`autoComplete=new-password`；不写localStorage/sessionStorage、日志、通知摘要或存储草稿。更改邮箱/服务、实际提交、权限失败都清授权码。完整邮箱/provider在失败后保留；GET永远不会回填完整邮箱或授权码。

CAS冲突、网络未知、认证失败都阻止继续提交，先显式读取最新metadata再填写授权码和重新确认。GET读取失败保留输入和上一份metadata；不会自动验证/保存/停用。已知 `ORGANIZER_MAIL_VERIFICATION_FAILED`(503)与网络结果未知分别解释，错误内容按固定code生成，不渲染未经处理的SMTP异常或secret值。根实际60秒间隔/每天10次验证上限也有相应恢复说明。

未保存输入切机构时提示验证保存/放弃/继续原机构；有请求在途禁切换。关闭页面/内部链接离开均提示，存活/清除标记及读取generation阻止晚响应污染新机构。401/403/404与全站会话失效事件清metadata、邮箱、授权码及成功提示，并要求重新打开当前有权限机构。

GET20秒、mutation30秒有限客户端等待；超时不暗示已撤销远端保存，先刷新核对，不自动重试。根SMTP验证有自己的有限时间与当前权限/CAS复核。

## 官方认证帮助

固定链接来自官方资料，本轮只读查阅，不由服务器note或输入邮箱拼接URL：

- [QQ邮箱官方帮助](https://service.mail.qq.com/)：使用SMTP/授权码主题搜索；旧深链未取得可验证正文，首版不假装深链已核验。
- [网易客户端授权码说明](https://help.mail.126.com/faqDetail.do?code=d7a5dc8471cd0c0e8b4b8f4f8e49998b374173cfe9171305fa1ce630d7f67ac286624f309a1a7089)：已读到官方网页，163/126共用开启服务并新增客户端授权密码说明。
- [Google应用专用密码说明](https://support.google.com/accounts/answer/185833?hl=zh-Hans)：已读到中文官方正文，提示先开启两步验证，账号可能存在限制。

## 验证与范围

```powershell
node --experimental-strip-types --test src/modules/organizer-mail-settings/model.test.ts
node node_modules/typescript/bin/tsc --noEmit --incremental false
```

受控测试仅本地规则与安全projection，不访问真实账号/数据库或发信。390px布局采用100%控件、44px操作、按钮换行、min-width:0与长字串换行；根页面实际嵌入、浏览器和真实SMTP验证须由主会话验收。没有新依赖/环境变量/迁移，未改selection-notices或根文件。
