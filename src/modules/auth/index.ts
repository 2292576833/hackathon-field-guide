export { AuthService, normalizeLoginEmail, safeAuthReturnTo, type AuthServiceDependencies } from "./service.ts";
export { PostgresAuthStore } from "./postgres.ts";
export { createNodeAuthCrypto } from "./crypto.ts";
export { createLoginEmailAdapter, type TransactionalEmailTransportPort } from "./email-adapter.ts";
export { createAuthHandlers, type AuthHandlers, type AuthHttpHandler, type AuthHttpOptions, type AuthHttpService } from "./http.ts";
// Node service/CLI public entry. Next production callers can use the protected
// trusted-client.server.ts entry; client-key.ts never reads environment secrets.
export { createClientKeyProvider, createSignedProxyClientKeyProvider, signProxyClientAttestation, normalizeClientAddress } from "./client-key.ts";
export { DEFAULT_AUTH_POLICY } from "./types.ts";
export type {
  AccountStatus, AuthPolicy, AuthUserRecord, LoginChallengeReceipt,
  LoginChallengeRecord, ProfileUpdate, SessionContext, SessionGrant,
  SessionRecord, SessionSummary, UserProfile, AccountSettings, OwnAccountSnapshot, SessionRevocationReceipt,
} from "./types.ts";
export type {
  AuthCryptoPort, AuthQueryPort, AuthStorePort, LoginEmailPort,
  ConsumeChallengeResult, ProfileUpdateResult, RevokeSessionsResult, AuthClientKeyPort, ClientConnectionPort,
} from "./ports.ts";
export type { ClientKeyPolicy, ProxyClientAttestation, SignedProxyClientKeyOptions } from "./client-key.ts";
export { AccountCompletionService, type AccountCompletionDependencies } from "./account-service.ts";
export { PostgresAccountStore } from "./account-postgres.ts";
export { createAccountCompletionHandlers, type AccountCompletionHandlers, type AccountCompletionHttpOptions, type AccountCompletionHttpService } from "./account-http.ts";
export { createAccountEmailAdapter } from "./account-email-adapter.ts";
export { DEFAULT_ACCOUNT_COMPLETION_POLICY } from "./account-types.ts";
export type {
  AccountCompletionPolicy, AccountDataOverview, AccountDeletionRequest, AccountDeletionSummary,
  DataExportRequest, DataExportSummary, DeletionImpact, DeletionBlockingProject, EmailChangeReceipt, EmailChangeResult,
  JsonValue, OwnDataBundle, OwnDataDocument, OwnDataRecord, ExportProjectSummary,
} from "./account-types.ts";
export type { AccountEmailPort, AccountStorePort, OwnDataExportPort, AccountDeletionImpactPort } from "./account-ports.ts";
