import { createConnection, type Socket } from "node:net";
import { connect as connectTls } from "node:tls";
import nodemailer, { type SMTPTransportOptions } from "nodemailer";
import type { TransactionalEmailTransportPort } from "../modules/auth/email-adapter.ts";
import { DomainError } from "../shared/errors.ts";

export interface SmtpMailConfiguration {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly user: string;
  readonly password: string;
}

type LoginMessage = Parameters<TransactionalEmailTransportPort["send"]>[0];
type SmtpMessage = LoginMessage & { readonly envelope: { readonly from: string; readonly to: string[] } };

export interface SmtpAcknowledgement {
  readonly accepted?: readonly (string | { readonly address: string })[];
  readonly rejected?: readonly (string | { readonly address: string })[];
  readonly pending?: readonly (string | { readonly address: string })[];
}

/** One independent, non-pooling transport per delivery; mocks do not contact SMTP. */
export interface SmtpTransportInstance {
  sendMail(message: SmtpMessage): Promise<SmtpAcknowledgement>;
  close(): void;
}

export interface SmtpMailDependencies {
  readonly createTransport?: (options: SMTPTransportOptions) => SmtpTransportInstance;
  readonly createSocket?: (configuration: SmtpMailConfiguration, signal: AbortSignal) => Socket;
  /** Must remain below the auth adapter's default 10-second deadline. */
  readonly deliveryTimeoutMs?: number;
}

const MAILBOX = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i;
const HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;

function failure() {
  // Raw SMTP errors can include addresses, credentials and message content.
  return new DomainError("EMAIL_SEND_FAILED", "验证码邮件未完成发送，请稍后重试或联系网站管理员。", { status: 503 });
}

function normalizedAddress(value: string | { readonly address: string }): string {
  return (typeof value === "string" ? value : value.address).trim().toLowerCase();
}

function defaultSocket(configuration: SmtpMailConfiguration, signal: AbortSignal): Socket {
  if (configuration.secure) return connectTls({
    host: configuration.host, port: configuration.port, servername: configuration.host,
    rejectUnauthorized: true, minVersion: "TLSv1.2",
  });
  // Nodemailer performs mandatory STARTTLS before authentication on this socket.
  return createConnection({ host: configuration.host, port: configuration.port, signal });
}

/** SMTP acknowledgement means accepted by the server, not arrival in the inbox. */
export function createSmtpMailTransport(configuration: SmtpMailConfiguration, dependencies: SmtpMailDependencies = {}): TransactionalEmailTransportPort {
  if (!HOSTNAME.test(configuration.host) || configuration.host.length > 253
    || !MAILBOX.test(configuration.user) || configuration.user.length > 254
    || !configuration.password || configuration.password.length > 4096 || /[\r\n\0]/.test(configuration.password)
    || !((configuration.port === 465 && configuration.secure === true) || (configuration.port === 587 && configuration.secure === false))) {
    throw new DomainError("EMAIL_CONFIGURATION_INVALID", "邮件发送配置无效，请联系网站管理员。", { status: 503 });
  }
  const deliveryTimeoutMs = dependencies.deliveryTimeoutMs ?? 9_000;
  if (!Number.isSafeInteger(deliveryTimeoutMs) || deliveryTimeoutMs < 1 || deliveryTimeoutMs > 9_500) {
    throw new DomainError("EMAIL_CONFIGURATION_INVALID", "邮件发送超时配置无效，请联系网站管理员。", { status: 503 });
  }
  const createTransport = dependencies.createTransport ?? (options => nodemailer.createTransport(options));
  const createSocket = dependencies.createSocket ?? defaultSocket;

  return {
    async send(message, { signal }) {
      const recipient = message.to.trim().toLowerCase();
      const sender = message.from.match(/<([^<>]+)>$/)?.[1] ?? message.from;
      if (signal.aborted || !MAILBOX.test(recipient) || recipient.length > 254
        || /[\r\n]/.test(message.from) || sender.toLowerCase() !== configuration.user.toLowerCase()
        || /[\r\n\0]/.test(message.subject) || message.subject.length > 998
        || message.text.length > 100_000 || message.text.includes("\0") || (message.html!==undefined && (message.html.length>200_000||message.html.includes("\0")))) throw failure();

      const deadline = new AbortController();
      const deliverySignal = AbortSignal.any([signal, deadline.signal]);
      let transport: SmtpTransportInstance | undefined;
      let socket: Socket | undefined;
      let connectTimer: ReturnType<typeof setTimeout> | undefined;
      let rejectAborted: (error: Error) => void = () => {};
      const aborted = new Promise<never>((_, reject) => { rejectAborted = reject; });
      // A factory can fail before the race is installed; cancellation still stays handled.
      void aborted.catch(() => {});
      const closeTransport = () => { try { transport?.close(); } catch { /* Never expose a provider cleanup error. */ } };
      const abort = () => {
        // Non-pooling Nodemailer.close() does not terminate an in-flight connection.
        // Destroy the owned socket too, including a socket wrapped by STARTTLS.
        socket?.destroy();
        closeTransport();
        rejectAborted(failure());
      };
      deliverySignal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => deadline.abort(), deliveryTimeoutMs);
      const networkTimeoutMs = Math.min(6_000, deliveryTimeoutMs);

      try {
        transport = createTransport({
          host: configuration.host, port: configuration.port, secure: configuration.secure,
          pool: false, requireTLS: !configuration.secure, ignoreTLS: false, opportunisticTLS: false,
          auth: { user: configuration.user, pass: configuration.password },
          tls: { servername: configuration.host, rejectUnauthorized: true, minVersion: "TLSv1.2" },
          connectionTimeout: networkTimeoutMs, greetingTimeout: networkTimeoutMs,
          socketTimeout: networkTimeoutMs, dnsTimeout: networkTimeoutMs,
          logger: false, debug: false, transactionLog: false,
          disableFileAccess: true, disableUrlAccess: true,
          getSocket(_options, callback) {
            if (deliverySignal.aborted) return callback(failure());
            try {
              socket = createSocket(configuration, deliverySignal);
              const ownedSocket = socket;
              // Keep late socket errors handled even when cancellation wins the race.
              ownedSocket.on("error", () => {});
              if (deliverySignal.aborted) { ownedSocket.destroy(); callback(failure()); return; }
              let returned = false;
              const complete = (error: Error | null) => {
                if (returned) return;
                returned = true;
                if (connectTimer !== undefined) clearTimeout(connectTimer);
                ownedSocket.removeListener(configuration.secure ? "secureConnect" : "connect", connected);
                ownedSocket.removeListener("error", socketError);
                ownedSocket.removeListener("close", socketError);
                if (error || deliverySignal.aborted) { ownedSocket.destroy(); callback(failure()); }
                else callback(null, { connection: ownedSocket, secured: configuration.secure });
              };
              const connected = () => complete(null);
              const socketError = () => complete(failure());
              ownedSocket.once(configuration.secure ? "secureConnect" : "connect", connected);
              ownedSocket.once("error", socketError);
              ownedSocket.once("close", socketError);
              connectTimer = setTimeout(() => complete(failure()), networkTimeoutMs);
              ownedSocket.setTimeout(networkTimeoutMs, () => ownedSocket.destroy(failure()));
            } catch { callback(failure()); }
          },
        });
        if (deliverySignal.aborted) throw failure();
        const acknowledgement = await Promise.race([
          transport.sendMail({ from: message.from, to: recipient, subject: message.subject, text: message.text, ...(message.html===undefined?{}:{html:message.html}),
            envelope: { from: configuration.user, to: [recipient] } }),
          aborted,
        ]);
        if (deliverySignal.aborted || !acknowledgement.accepted?.some(address => normalizedAddress(address) === recipient)
          || acknowledgement.rejected?.some(address => normalizedAddress(address) === recipient)
          || acknowledgement.pending?.some(address => normalizedAddress(address) === recipient)) throw failure();
      } catch { throw failure(); }
      finally {
        clearTimeout(timer);
        if (connectTimer !== undefined) clearTimeout(connectTimer);
        deliverySignal.removeEventListener("abort", abort);
        socket?.destroy();
        closeTransport();
      }
    },
  };
}
