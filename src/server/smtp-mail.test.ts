import assert from "node:assert/strict";
import { createConnection, createServer, Socket, type AddressInfo } from "node:net";
import { once } from "node:events";
import test from "node:test";
import type { SMTPTransportOptions } from "nodemailer";
import { DomainError } from "../shared/errors.ts";
import { createSmtpMailTransport, type SmtpAcknowledgement, type SmtpMailConfiguration, type SmtpTransportInstance } from "./smtp-mail.ts";

const configuration: SmtpMailConfiguration = { host: "smtp.qq.com", port: 465, secure: true, user: "sender@qq.com", password: "fixture-authorization-code" };
const message = { from: "黑客松情报局 <sender@qq.com>", to: "user@example.com", subject: "登录验证码", text: "fixture-only-message" };
const safeFailure = (error: unknown) => error instanceof DomainError && error.code === "EMAIL_SEND_FAILED"
  && !error.message.includes("fixture") && !error.message.includes("@") && !error.message.includes("provider raw");

function fixture(input: { acknowledgement?: SmtpAcknowledgement; failure?: Error; never?: boolean; deliveryTimeoutMs?: number; secure?: boolean; closeThrows?: boolean } = {}) {
  let created = 0;
  let closed = 0;
  let deliveries = 0;
  let smtpOptions: SMTPTransportOptions | undefined;
  let sentMessage: Parameters<SmtpTransportInstance["sendMail"]>[0] | undefined;
  let socket: Socket | undefined;
  const config = input.secure === false ? { ...configuration, port: 587, secure: false } : configuration;
  const transport = createSmtpMailTransport(config, {
    deliveryTimeoutMs: input.deliveryTimeoutMs ?? 500,
    createSocket(_config, signal) {
      assert.equal(signal.aborted, false);
      socket = new Socket();
      const ownedSocket = socket;
      queueMicrotask(() => ownedSocket.emit(config.secure ? "secureConnect" : "connect"));
      return ownedSocket;
    },
    createTransport(options) {
      smtpOptions = options;
      created++;
      return {
        async sendMail(value) {
          sentMessage = value;
          deliveries++;
          await new Promise<void>((resolve, reject) => options.getSocket!({}, error => error ? reject(error) : resolve()));
          if (input.never) await new Promise<void>(() => {});
          if (input.failure) throw input.failure;
          return input.acknowledgement ?? { accepted: [message.to], rejected: [] };
        },
        close() { closed++; if (input.closeThrows) throw new Error("provider raw cleanup"); },
      };
    },
  });
  return { transport, get created() { return created; }, get closed() { return closed; }, get deliveries() { return deliveries; },
    get smtpOptions() { return smtpOptions; }, get socket() { return socket; }, get sentMessage() { return sentMessage; } };
}

test("SMTP preserves login content and sends one explicit envelope recipient", async () => {
  const subject = fixture();
  await subject.transport.send({ ...message, to: " USER@example.com " }, { signal: new AbortController().signal });
  assert.deepEqual(subject.sentMessage, { ...message, envelope: { from: configuration.user, to: [message.to] } });
  assert.equal(subject.created, 1);
  assert.equal(subject.deliveries, 1);
  assert.equal(subject.closed, 1);
  assert.equal(subject.socket?.destroyed, true);
});
test("SMTP forwards the server-rendered notice HTML and rejects oversized HTML before sending",async()=>{
  const subject=fixture(),html="<h1>本站安全生成的通知</h1>";
  await subject.transport.send({...message,html},{signal:new AbortController().signal});assert.equal(subject.sentMessage?.html,html);
  await assert.rejects(subject.transport.send({...message,html:"x".repeat(200001)},{signal:new AbortController().signal}),safeFailure);assert.equal(subject.deliveries,1);
});

test("465 requires strict implicit TLS, no pooling, logging or content fetches", async () => {
  const subject = fixture();
  await subject.transport.send(message, { signal: new AbortController().signal });
  const options = subject.smtpOptions!;
  assert.equal(options.secure, true);
  assert.equal(options.pool, false);
  assert.equal(options.ignoreTLS, false);
  assert.equal(options.opportunisticTLS, false);
  assert.deepEqual(options.tls, { servername: configuration.host, rejectUnauthorized: true, minVersion: "TLSv1.2" });
  assert.deepEqual(options.auth, { user: configuration.user, pass: configuration.password });
  assert.equal(options.logger, false);
  assert.equal(options.debug, false);
  assert.equal(options.transactionLog, false);
  assert.equal(options.disableFileAccess, true);
  assert.equal(options.disableUrlAccess, true);
  for (const key of ["connectionTimeout", "greetingTimeout", "socketTimeout", "dnsTimeout"] as const) assert.equal(options[key], 500);
});

test("587 requires STARTTLS and valid certificates before authentication", async () => {
  const subject = fixture({ secure: false });
  await subject.transport.send(message, { signal: new AbortController().signal });
  assert.equal(subject.smtpOptions?.secure, false);
  assert.equal(subject.smtpOptions?.requireTLS, true);
  assert.equal(subject.smtpOptions?.ignoreTLS, false);
  assert.equal(subject.smtpOptions?.opportunisticTLS, false);
  assert.equal(subject.smtpOptions?.tls?.rejectUnauthorized, true);
});

for (const [label, acknowledgement] of [
  ["recipient missing", { accepted: [] }],
  ["another recipient only", { accepted: ["other@example.com"] }],
  ["target also rejected", { accepted: [message.to], rejected: [message.to] }],
  ["target still pending", { accepted: [message.to], pending: [message.to] }],
] as const) {
  test(`SMTP acknowledgement refuses ${label}`, async () => {
    const subject = fixture({ acknowledgement });
    await assert.rejects(subject.transport.send(message, { signal: new AbortController().signal }), safeFailure);
    assert.equal(subject.deliveries, 1);
    assert.equal(subject.created, 1);
    assert.equal(subject.socket?.destroyed, true);
  });
}

test("accepted addresses represented as objects are checked against the target", async () => {
  const subject = fixture({ acknowledgement: { accepted: [{ address: "USER@example.com" }] } });
  await subject.transport.send(message, { signal: new AbortController().signal });
  assert.equal(subject.deliveries, 1);
});

test("provider rejection is safe, closes its socket and never retries", async () => {
  const subject = fixture({ failure: new Error(`provider raw ${message.to} fixture-authorization-code`) });
  await assert.rejects(subject.transport.send(message, { signal: new AbortController().signal }), safeFailure);
  assert.equal(subject.created, 1);
  assert.equal(subject.deliveries, 1);
  assert.equal(subject.closed, 1);
  assert.equal(subject.socket?.destroyed, true);
});

test("an already cancelled send creates no transport or socket", async () => {
  const subject = fixture();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(subject.transport.send(message, { signal: controller.signal }), safeFailure);
  assert.equal(subject.created, 0);
  assert.equal(subject.deliveries, 0);
  assert.equal(subject.socket, undefined);
});

test("cancellation destroys the actual owned socket even when sendMail never returns", async () => {
  const subject = fixture({ never: true, closeThrows: true });
  const controller = new AbortController();
  const result = subject.transport.send(message, { signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(result, safeFailure);
  assert.equal(subject.socket?.destroyed, true);
  assert.equal(subject.deliveries, 1);
  assert.equal(subject.created, 1);
});

test("a total deadline rejects a hanging send and closes its actual socket", async () => {
  const subject = fixture({ never: true, deliveryTimeoutMs: 15 });
  await assert.rejects(subject.transport.send(message, { signal: new AbortController().signal }), safeFailure);
  assert.equal(subject.socket?.destroyed, true);
  assert.equal(subject.deliveries, 1);
});

test("successful acknowledgement is retained even if transport cleanup throws", async () => {
  const subject = fixture({ closeThrows: true });
  await subject.transport.send(message, { signal: new AbortController().signal });
  assert.equal(subject.socket?.destroyed, true);
});

test("each send owns an independent transport and connection", async () => {
  const subject = fixture();
  await subject.transport.send(message, { signal: new AbortController().signal });
  const firstSocket = subject.socket;
  await subject.transport.send(message, { signal: new AbortController().signal });
  assert.equal(subject.created, 2);
  assert.equal(subject.deliveries, 2);
  assert.equal(subject.closed, 2);
  assert.notEqual(subject.socket, firstSocket);
  assert.equal(firstSocket?.destroyed, true);
  assert.equal(subject.socket?.destroyed, true);
});

test("unsafe SMTP configurations are rejected before opening connections", () => {
  for (const changes of [{ port: 25 }, { secure: false }, { host: "smtp.qq.com\r\nX: bad" }, { user: "bad-address" }, { password: "" }, { password: "bad\nsecret" }]) {
    assert.throws(() => createSmtpMailTransport({ ...configuration, ...changes }), (error: unknown) => error instanceof DomainError && error.code === "EMAIL_CONFIGURATION_INVALID");
  }
  for (const deliveryTimeoutMs of [0, 10_000, NaN]) assert.throws(() => createSmtpMailTransport(configuration, { deliveryTimeoutMs }));
});

test("header injection, multiple recipients and a mismatched sender never reach SMTP", async () => {
  const subject = fixture();
  for (const changes of [{ to: "one@example.com,two@example.com" }, { to: "one@example.com\r\nBcc:two@example.com" }, { from: "other@example.com" }, { from: "sender@qq.com\r\nX: bad" }, { subject: "login\nBcc:two@example.com" }]) {
    await assert.rejects(subject.transport.send({ ...message, ...changes }, { signal: new AbortController().signal }), safeFailure);
  }
  assert.equal(subject.created, 0);
});

test("real Nodemailer cancellation closes a local SMTP connection before any message is sent", { timeout: 3_000 }, async t => {
  const connections = new Set<Socket>();
  let receivedBytes = 0;
  const server = createServer(socket => {
    connections.add(socket);
    socket.on("data", data => { receivedBytes += data.length; });
    socket.on("close", () => connections.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { for (const socket of connections) socket.destroy(); server.close(); });
  const port = (server.address() as AddressInfo).port;
  const controller = new AbortController();
  let ownedSocket: Socket | undefined;
  const transport = createSmtpMailTransport({ ...configuration, port: 587, secure: false }, {
    deliveryTimeoutMs: 1_000,
    createSocket(_config, signal) {
      ownedSocket = createConnection({ host: "127.0.0.1", port, signal });
      return ownedSocket;
    },
  });
  const connection = once(server, "connection");
  const delivery = transport.send(message, { signal: controller.signal });
  const [serverSocket] = await connection as [Socket];
  const disconnected = once(serverSocket, "close");
  controller.abort();
  await assert.rejects(delivery, safeFailure);
  await disconnected;
  assert.equal(ownedSocket?.destroyed, true);
  assert.equal(receivedBytes, 0);
});

test("real Nodemailer refuses an SMTP peer without STARTTLS before exposing credentials", { timeout: 3_000 }, async t => {
  const commands: string[] = [];
  const connections = new Set<Socket>();
  const server = createServer(socket => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
    socket.write("220 fixture SMTP\r\n");
    let buffer = "";
    socket.on("data", data => {
      buffer += data.toString("utf8");
      let separator: number;
      while ((separator = buffer.indexOf("\r\n")) !== -1) {
        const command = buffer.slice(0, separator).split(" ")[0];
        buffer = buffer.slice(separator + 2);
        commands.push(command);
        if (command === "EHLO") socket.write("250-fixture\r\n250 AUTH LOGIN PLAIN\r\n");
        else if (command === "STARTTLS") socket.write("454 TLS unavailable\r\n");
        else socket.write("500 unexpected fixture command\r\n");
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { for (const socket of connections) socket.destroy(); server.close(); });
  const port = (server.address() as AddressInfo).port;
  const transport = createSmtpMailTransport({ ...configuration, port: 587, secure: false }, {
    deliveryTimeoutMs: 1_000,
    createSocket(_config, signal) { return createConnection({ host: "127.0.0.1", port, signal }); },
  });
  await assert.rejects(transport.send(message, { signal: new AbortController().signal }), safeFailure);
  assert.equal(commands[0], "EHLO");
  assert.equal(commands.includes("STARTTLS"), true);
  assert.equal(commands.includes("AUTH"), false);
  assert.equal(commands.includes("MAIL"), false);
  assert.equal(commands.includes("DATA"), false);
});
