import { createHmac, timingSafeEqual } from "node:crypto";
import { BlockList, isIP } from "node:net";
import type { Clock } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { AuthClientKeyPort, ClientConnectionPort } from "./ports.ts";

/** Node-only implementation; production Next entry is trusted-client.server.ts. */
export type ClientKeyPolicy =
  | { readonly mode: "shared-budget"; readonly budgetId: string }
  | { readonly mode: "direct"; readonly connection: ClientConnectionPort }
  | {
      readonly mode: "trusted-proxy";
      readonly connection: ClientConnectionPort;
      readonly trustedProxyCidrs: readonly string[];
      readonly forwardedHeader?: "x-forwarded-for" | "x-real-ip";
      readonly maxForwardedEntries?: number;
    };

export interface SignedProxyClientKeyOptions {
  /** Explicit proxy allowlist, each with a separate private signing key. */
  readonly proxies: readonly { readonly id: string; readonly signingKey: string }[];
  /** Exact configured site Origin, bound in the signature across deployments. */
  readonly origin: string;
  readonly clock: Clock;
  readonly headerName?: string;
  readonly maxAgeMs?: number;
  readonly maxFutureSkewMs?: number;
}

export interface ProxyClientAttestation {
  readonly proxyId: string;
  readonly clientAddress: string;
  /** Unix timestamp in milliseconds, obtained by the trusted ingress. */
  readonly issuedAt: number;
  readonly method: string;
  /** URL pathname plus search, exactly as the application will receive it. */
  readonly target: string;
}

function serverRuntime(): void {
  if (typeof window !== "undefined") throw new Error("Client rate keys require a server runtime.");
}
function unavailable(): DomainError {
  return new DomainError("AUTH_CLIENT_SOURCE_UNAVAILABLE", "暂时无法确认请求来源，请稍后重试。", { status: 503, recoveryAction: "retry_later" });
}

/** Normalizes equivalent IPv6/IPv4-mapped addresses without accepting ports/zones. */
export function normalizeClientAddress(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 128 || /[%\s\[\]"'\\]/.test(value)) return null;
  const family = isIP(value);
  if (family === 4) return value;
  if (family !== 6) return null;
  const canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1).toLowerCase();
  if (canonical.startsWith("::ffff:")) {
    const words = canonical.slice(7).split(":");
    if (words.length === 2) {
      const high = Number.parseInt(words[0]!, 16); const low = Number.parseInt(words[1]!, 16);
      return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
    }
  }
  return canonical;
}

function trustedNetworks(cidrs: readonly string[]): (ip: string) => boolean {
  if (!Array.isArray(cidrs) || cidrs.length === 0 || cidrs.length > 128) throw new Error("An explicit bounded proxy IP/CIDR allowlist is required.");
  // Node's IPv6 BlockList can match mapped IPv4, including ::/80 matching all
  // IPv4. Separate families after normalization to prevent implicit cross-trust.
  const ipv4 = new BlockList(); const ipv6 = new BlockList();
  for (const cidr of cidrs) {
    if (typeof cidr !== "string" || cidr.length > 144) throw new Error("Invalid proxy IP/CIDR allowlist entry.");
    const parts = cidr.split("/"); const rawAddress = parts[0]!;
    if (parts.length > 2) throw new Error("Invalid proxy IP/CIDR allowlist entry.");
    const address = normalizeClientAddress(rawAddress);
    if (!address) throw new Error("Invalid proxy IP/CIDR allowlist entry.");
    const rawBits = isIP(rawAddress) === 4 ? 32 : 128;
    if (parts.length === 2 && !/^\d{1,3}$/.test(parts[1]!)) throw new Error("Invalid proxy CIDR prefix.");
    let prefix = parts.length === 2 ? Number(parts[1]) : rawBits;
    if (prefix <= 0 || prefix > rawBits) throw new Error("Proxy allowlists cannot include a universal or invalid CIDR.");
    if (rawBits === 128 && isIP(address) === 4) {
      if (prefix < 96) throw new Error("Mapped IPv4 proxy CIDRs must specify at least 96 bits.");
      prefix -= 96;
      if (prefix === 0) throw new Error("Proxy allowlists cannot include a universal CIDR.");
    }
    if (isIP(address) === 4) ipv4.addSubnet(address, prefix, "ipv4");
    else ipv6.addSubnet(address, prefix, "ipv6");
  }
  return (ip) => isIP(ip) === 4 ? ipv4.check(ip, "ipv4") : ipv6.check(ip, "ipv6");
}

/** No implicit header trust, random key, cookie key or fallback between modes. */
export function createClientKeyProvider(policy: ClientKeyPolicy): AuthClientKeyPort {
  serverRuntime();
  if (policy.mode === "shared-budget") {
    if (typeof policy.budgetId !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(policy.budgetId)) throw new Error("Shared client budget requires a stable configured identifier.");
    const key = `client:shared-budget:${policy.budgetId}`;
    return { getClientKey: async () => key };
  }
  if (policy.mode !== "direct" && policy.mode !== "trusted-proxy") throw new Error("Invalid client rate-key mode.");
  const connection = policy.connection;
  if (!connection || typeof connection.getPeerAddress !== "function") throw new Error("Trusted connection metadata is required.");
  const isTrusted = policy.mode === "trusted-proxy" ? trustedNetworks(policy.trustedProxyCidrs) : null;
  const header = policy.mode === "trusted-proxy" ? policy.forwardedHeader ?? "x-forwarded-for" : null;
  if (header !== null && !["x-forwarded-for", "x-real-ip"].includes(header)) throw new Error("Invalid configured proxy client header.");
  const maximum = policy.mode === "trusted-proxy" ? policy.maxForwardedEntries ?? 16 : 1;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 32) throw new Error("Proxy chain limit must be between 1 and 32.");
  return {
    async getClientKey(request) {
      let peer: string | null;
      try { peer = normalizeClientAddress(await connection.getPeerAddress(request)); }
      catch { throw unavailable(); }
      if (!peer) throw unavailable();
      if (isTrusted === null) return `client:ip:${peer}`; // Direct mode ignores every forwarded header.
      if (!isTrusted(peer)) throw unavailable(); // Proxy-only ingress cannot silently become direct.
      const raw = request.headers.get(header!);
      if (!raw || Buffer.byteLength(raw) > 2048) throw unavailable();
      const entries = raw.split(",");
      if (entries.length > maximum || (header === "x-real-ip" && entries.length !== 1)) throw unavailable();
      const addresses = entries.map((entry) => normalizeClientAddress(entry.trim()));
      if (addresses.some((address) => address === null)) throw unavailable();
      for (let index = addresses.length - 1; index >= 0; index--) {
        const address = addresses[index]!;
        if (!isTrusted(address)) return `client:ip:${address}`;
      }
      throw unavailable(); // A chain containing only proxies does not identify a client.
    },
  };
}

function fixedOrigin(value: string): string {
  let origin: URL;
  try { origin = new URL(value); } catch { throw new Error("Proxy attestation requires an exact HTTPS site Origin."); }
  if (origin.origin !== value || origin.protocol !== "https:") throw new Error("Proxy attestation requires an exact HTTPS site Origin.");
  return value;
}
function validAttestation(value: ProxyClientAttestation): boolean {
  return typeof value.proxyId === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(value.proxyId)
    && normalizeClientAddress(value.clientAddress) !== null
    && Number.isSafeInteger(value.issuedAt) && value.issuedAt >= 0
    && typeof value.method === "string" && /^[A-Z]{3,16}$/.test(value.method)
    && typeof value.target === "string" && value.target.startsWith("/") && !value.target.startsWith("//")
    && value.target.length <= 2048 && !/[\u0000-\u0020\u007f#\\]/.test(value.target);
}
function signature(input: ProxyClientAttestation, origin: string, key: string): Buffer {
  return createHmac("sha256", key).update(JSON.stringify([
    "hackathon-client-key", 1, origin, input.proxyId, input.clientAddress,
    input.issuedAt, input.method, input.target,
  ])).digest();
}

/** Trusted ingress helper. Its clientAddress must come from a verified socket chain. */
export function signProxyClientAttestation(input: ProxyClientAttestation, origin: string, signingKey: string): string {
  serverRuntime(); fixedOrigin(origin);
  if (!validAttestation(input) || typeof signingKey !== "string" || Buffer.byteLength(signingKey) < 32) throw new Error("Invalid private proxy attestation configuration.");
  return Buffer.from(JSON.stringify({
    proxyId: input.proxyId, clientAddress: input.clientAddress, issuedAt: input.issuedAt,
    method: input.method, target: input.target, signature: signature(input, origin, signingKey).toString("hex"),
  })).toString("base64url");
}

/** Private proxy attestation, not an identity token or an RFC 9421 implementation. */
export function createSignedProxyClientKeyProvider(options: SignedProxyClientKeyOptions): AuthClientKeyPort {
  serverRuntime();
  const origin = fixedOrigin(options.origin);
  if (!Array.isArray(options.proxies) || options.proxies.length === 0 || options.proxies.length > 128) throw new Error("An explicit signed-proxy allowlist is required.");
  const keys = new Map<string, string>();
  for (const proxy of options.proxies) {
    if (typeof proxy.id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(proxy.id) || keys.has(proxy.id) || typeof proxy.signingKey !== "string" || Buffer.byteLength(proxy.signingKey) < 32) throw new Error("Invalid private signed-proxy allowlist.");
    keys.set(proxy.id, proxy.signingKey);
  }
  const headerName = options.headerName ?? "x-hackathon-client-attestation";
  if (!/^[a-z][a-z0-9-]{1,79}$/.test(headerName) || ["cookie", "authorization", "x-forwarded-for", "x-real-ip", "forwarded"].includes(headerName)) throw new Error("A dedicated proxy attestation header is required.");
  const maxAgeMs = options.maxAgeMs ?? 30_000; const skew = options.maxFutureSkewMs ?? 5_000;
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1 || maxAgeMs > 120_000 || !Number.isSafeInteger(skew) || skew < 0 || skew > 30_000) throw new Error("Invalid bounded proxy attestation time window.");
  if (!options.clock || typeof options.clock.now !== "function") throw new Error("A trusted proxy-attestation Clock is required.");
  const clock = options.clock;
  return {
    async getClientKey(request) {
      const encoded = request.headers.get(headerName);
      if (!encoded || encoded.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw unavailable();
      const decoded = Buffer.from(encoded, "base64url");
      if (decoded.toString("base64url") !== encoded) throw unavailable();
      let payload: Record<string, unknown>;
      try {
        const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decoded));
        if (typeof value !== "object" || value === null || Array.isArray(value)) throw unavailable();
        payload = value as Record<string, unknown>;
      } catch { throw unavailable(); }
      const allowed = ["proxyId", "clientAddress", "issuedAt", "method", "target", "signature"];
      if (Object.keys(payload).length !== allowed.length || Object.keys(payload).some((name) => !allowed.includes(name))) throw unavailable();
      const input = payload as unknown as ProxyClientAttestation;
      if (!validAttestation(input) || typeof payload.signature !== "string" || !/^[a-f0-9]{64}$/.test(payload.signature)) throw unavailable();
      const key = keys.get(input.proxyId);
      if (!key) throw unavailable();
      const supplied = Buffer.from(payload.signature, "hex");
      if (!timingSafeEqual(signature(input, origin, key), supplied)) throw unavailable();
      const now = clock.now().getTime(); const target = new URL(request.url);
      if (!Number.isFinite(now) || now - input.issuedAt >= maxAgeMs || input.issuedAt - now > skew
          || input.method !== request.method || input.target !== target.pathname + target.search) throw unavailable();
      return `client:ip:${normalizeClientAddress(input.clientAddress)!}`;
    },
  };
}
