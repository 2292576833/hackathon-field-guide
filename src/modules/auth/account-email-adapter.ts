import type { AccountEmailPort } from "./account-ports.ts";
import type { TransactionalEmailTransportPort } from "./email-adapter.ts";

/** Provider-independent mailbox-change delivery. A rejection never means confirmed delivery. */
export function createAccountEmailAdapter(options: {
  readonly transport: TransactionalEmailTransportPort;
  readonly from: string;
  readonly timeoutMs?: number;
}): AccountEmailPort {
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!options.from || /[\r\n]/.test(options.from)) throw new Error("A valid configured email sender is required.");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("Email timeout must be a positive safe integer.");
  return {
    async sendEmailChangeCode(input) {
      if (!/^[^\s@\r\n]+@[^\s@\r\n]+\.[^\s@\r\n]+$/.test(input.email) || input.email.length > 254) {
        throw new Error("A valid recipient is required.");
      }
      if (!/^\d{8}$/.test(input.code) || !Number.isFinite(Date.parse(input.expiresAt))
        || !["current_email", "new_email"].includes(input.purpose)) {
        throw new Error("A valid mailbox change challenge is required.");
      }
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("Account email delivery timed out."));
        }, timeoutMs);
      });
      const current = input.purpose === "current_email";
      try {
        await Promise.race([
          options.transport.send({
            from: options.from, to: input.email,
            subject: `黑客松情报局 · ${current ? "确认更换登录邮箱" : "验证新的登录邮箱"}`,
            text: `${current ? "你正在更换本站登录邮箱。当前邮箱的确认验证码" : "你正在将本邮箱设为本站新的登录邮箱。新邮箱的验证码"}为：${input.code}\n\n有效期至 ${input.expiresAt}。请在本人账号页填写，不要将验证码告诉他人。\n邮箱更换需要当前邮箱和新邮箱同时验证；完成后所有旧登录会话退出，参赛记录仍归同一个账号。\n${current ? "如果这不是你本人发起的操作，请勿提供验证码，并检查本站登录设备。" : "如果这不是你本人发起的操作，请忽略本邮件。"}`,
          }, { signal: controller.signal }),
          timeout,
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  };
}
