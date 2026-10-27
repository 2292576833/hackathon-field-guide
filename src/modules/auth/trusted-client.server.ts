import "server-only";

/** Production Next.js entry. Test/server CLI harnesses use the Node-only implementation. */
export {
  createClientKeyProvider, createSignedProxyClientKeyProvider,
  signProxyClientAttestation,
  type ClientKeyPolicy, type ProxyClientAttestation, type SignedProxyClientKeyOptions,
} from "./client-key.ts";
export type { AuthClientKeyPort, ClientConnectionPort } from "./ports.ts";
