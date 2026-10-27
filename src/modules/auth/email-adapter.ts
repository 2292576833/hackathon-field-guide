import type { LoginEmailPort } from "./ports.ts";

export interface TransactionalEmailTransportPort {
  /** Adapter must use the signal and resolve only on provider acknowledgement. */
  send(message: {
    readonly from: string; readonly to: string; readonly subject: string; readonly text: string; readonly html?: string;
  }, options: { readonly signal: AbortSignal }): Promise<void>;
}

/** Provider-independent email template/timeout adapter; no credentials are stored here. */
export function createLoginEmailAdapter(options: {
  readonly transport: TransactionalEmailTransportPort;
  readonly from: string;
  readonly timeoutMs?: number;
}): LoginEmailPort {
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!options.from || /[\r\n]/.test(options.from)) throw new Error("A valid configured email sender is required.");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("Email timeout must be a positive safe integer.");
  return {
    async sendLoginCode(input) {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("Login email delivery timed out."));
        }, timeoutMs);
      });
      try {
        await Promise.race([
          options.transport.send({
            from: options.from, to: input.email, subject: "黑客松情报局 · 登录验证码",
            text: `你的本站登录验证码为：${input.code}\n\n有效期至 ${input.expiresAt}。请勿将验证码告诉他人。\n如果这不是你本人发起的登录，请忽略本邮件。\n本站登录与 GitHub 授权分别进行。`,
          }, { signal: controller.signal }),
          timeout,
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  };
}
