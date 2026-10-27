import type { SenderProvider } from "./model.ts";

export interface SenderAuthenticationHelp { title: string; text: string; label: string; href: string }
const netease: SenderAuthenticationHelp = {
  title: "获取网易客户端授权码",
  text: "先在网易邮箱的设置中开启 SMTP 服务并新增客户端授权码。这里填写授权码，不填邮箱登录密码。认证失败时，请核对邮箱地址、SMTP 开关与授权码。",
  label: "网易官方授权码说明",
  href: "https://help.mail.126.com/faqDetail.do?code=d7a5dc8471cd0c0e8b4b8f4f8e49998b374173cfe9171305fa1ce630d7f67ac286624f309a1a7089"
};
/** Fixed official links only; never turn server notes or typed email addresses into URLs. */
export const senderAuthenticationHelp: Record<SenderProvider, SenderAuthenticationHelp> = {
  qq: { title: "获取 QQ 邮箱授权码", text: "请在 QQ 邮箱设置中启用 SMTP 并生成授权码。这里填写授权码，不填 QQ 登录密码；官方帮助中可搜索“SMTP”或“授权码”。", label: "QQ 邮箱官方帮助", href: "https://service.mail.qq.com/" },
  "163": netease, "126": netease,
  gmail: { title: "获取 Gmail 应用专用密码", text: "先开启 Google 两步验证，再创建应用专用密码；这里不用 Google 登录密码。若账号没有应用密码选项，请按官方说明核对账号限制。", label: "Google 官方应用密码说明", href: "https://support.google.com/accounts/answer/185833?hl=zh-Hans" }
};
