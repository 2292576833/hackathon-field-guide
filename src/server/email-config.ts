import type { SmtpMailConfiguration } from "./smtp-mail.ts";

/** Mail credentials stay on the server. An unfinished SMTP setup remains visibly unavailable. */
export function emailConfiguration(env: Record<string, string | undefined>) {
  const selected = env.AUTH_EMAIL_PROVIDER?.trim() || (env.RESEND_API_KEY?.trim() ? "resend" : env.SMTP_PASSWORD?.trim() ? "smtp" : undefined);
  if (selected && selected !== "resend" && selected !== "smtp") throw new Error("AUTH_EMAIL_PROVIDER must be resend or smtp.");
  let smtp: SmtpMailConfiguration | undefined;
  let resendKey: string | undefined;
  let emailFrom = env.AUTH_EMAIL_FROM?.trim() || "development@localhost.invalid";
  if (selected === "resend" && env.RESEND_API_KEY?.trim()) {
    resendKey = env.RESEND_API_KEY.trim();
    if (!env.AUTH_EMAIL_FROM?.trim() || /[\r\n]/.test(emailFrom) || emailFrom.includes("localhost.invalid")) throw new Error("Configured Resend delivery requires a verified AUTH_EMAIL_FROM.");
  }
  if (selected === "smtp" && env.SMTP_PASSWORD?.trim()) {
    const user = env.SMTP_USER?.trim().toLowerCase();
    if (!user || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(user)) throw new Error("SMTP_USER must be the sending mailbox address.");
    const host = env.SMTP_HOST?.trim() || "smtp.qq.com";
    const port = Number(env.SMTP_PORT || "465");
    if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(host)) throw new Error("SMTP_HOST must be a mail server hostname.");
    if (port !== 465 && port !== 587) throw new Error("SMTP_PORT must be 465 (TLS) or 587 (required STARTTLS).");
    const secure = env.SMTP_SECURE === undefined || env.SMTP_SECURE === "" ? port === 465 : env.SMTP_SECURE === "true";
    if (env.SMTP_SECURE && !["true", "false"].includes(env.SMTP_SECURE)) throw new Error("SMTP_SECURE must be true or false.");
    if (secure !== (port === 465)) throw new Error("SMTP_SECURE must match the selected encrypted mail port.");
    emailFrom = env.AUTH_EMAIL_FROM?.trim() || `黑客松情报局 <${user}>`;
    const sender = emailFrom.match(/<([^<>]+)>$/)?.[1] ?? emailFrom;
    if (/[\r\n]/.test(emailFrom) || sender.toLowerCase() !== user) throw new Error("SMTP AUTH_EMAIL_FROM must use the SMTP_USER mailbox.");
    smtp = { host, port, secure, user, password: env.SMTP_PASSWORD.trim() };
  }
  return { emailFrom, resendKey, smtp, emailProvider: selected as "resend" | "smtp" | undefined };
}
