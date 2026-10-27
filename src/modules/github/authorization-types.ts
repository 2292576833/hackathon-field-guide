import type { Actor, Clock, IdGenerator, ProjectAccessPort } from "../../shared/contracts.ts";
import type { DeliveryCapabilityPort, UserCredential } from "./types.ts";

export interface GitHubAppOptions {
  appId: number; clientId: string; clientSecret: string; appSlug: string; origin: string; callbackUrl: string;
  stateTtlSeconds?: number; refreshSkewSeconds?: number;
}
export interface GitHubTokenSet { accessToken: string; refreshToken: string; accessExpiresAt: string; refreshExpiresAt: string }
export interface GitHubIdentity { id: number; login: string; profileUrl: string }
export interface GitHubInstallation {
  id: number; appId: number; accountLogin: string; accountType: "User" | "Organization";
  repositorySelection: "all" | "selected"; permissions: Record<string, string>; suspended: boolean;
}
export interface DiscoveredRepository {
  repositoryId: number; owner: string; name: string; installationId: number; appId: number;
  defaultBranch: string; url: string; private: boolean; userCanPush: boolean; contentsWrite: boolean;
  pullRequestsWrite: boolean; archived: boolean; disabled: boolean;
}
export interface CreatedRepository { repositoryId: number; owner: string; name: string; url: string; private: boolean; defaultBranch: string; initialized: boolean; description: string }
export interface GitHubAuthorizationHttpPort {
  exchangeCode(input: { code: string; codeVerifier: string; redirectUri: string }): Promise<GitHubTokenSet>;
  refreshToken(refreshToken: string): Promise<GitHubTokenSet>;
  revokeGrant(accessToken: string): Promise<void>;
  revokeToken(accessToken: string): Promise<void>;
  getIdentity(accessToken: string): Promise<GitHubIdentity>;
  listInstallations(accessToken: string): Promise<GitHubInstallation[]>;
  listRepositories(accessToken: string, installation: GitHubInstallation): Promise<DiscoveredRepository[]>;
  getRepository(accessToken: string, owner: string, name: string): Promise<CreatedRepository | null>;
  createRepository(accessToken: string, input: { name: string; description: string; private: boolean }): Promise<CreatedRepository>;
}
export interface EncryptedValue { keyId: string; iv: string; tag: string; data: string }
export interface CredentialCipher {
  encrypt(value: unknown, context: string): EncryptedValue;
  decrypt<T>(value: EncryptedValue, context: string): T;
}
export interface StoredAuthorizationState {
  stateHash: string; userId: string; appId: number; browserHash: string; encryptedVerifier: EncryptedValue;
  projectId: string | null; returnTo: string; createdAt: string; expiresAt: string; authorizationEpoch: number;
  flow: "authorization" | "installation";
}
export interface StoredGitHubCredential {
  userId: string; appId: number; githubUserId: number; githubLogin: string; encryptedTokens: EncryptedValue | null;
  accessExpiresAt: string; refreshExpiresAt: string; status: "active" | "refreshing" | "revoked" | "reauthorize_required";
  revision: number; refreshLeaseUntil: string | null; checkedAt: string;
}
export interface AuthorizationStorePort {
  insertState(state: StoredAuthorizationState): Promise<void>;
  getAuthorizationEpoch(userId: string, appId: number): Promise<number>;
  consumeState(input: { stateHash: string; userId: string; appId: number; browserHash: string; now: string; flow: StoredAuthorizationState["flow"] }): Promise<StoredAuthorizationState | null>;
  getCredential(userId: string, appId: number): Promise<StoredGitHubCredential | null>;
  saveCredential(credential: StoredGitHubCredential, expectedRevision: number | null, expectedAuthorizationEpoch?: number): Promise<void>;
  revokeCredential(userId: string, appId: number, expectedRevision: number | null): Promise<number>;
  finishRevocation(userId: string, appId: number, expectedEpoch: number): Promise<void>;
  claimRefresh(userId: string, appId: number, expectedRevision: number, leaseUntil: string): Promise<StoredGitHubCredential | null>;
  purgeExpiredStates(now: string): Promise<number>;
}
export interface GitHubUserCredentialProvider {
  getAuthorizationCredential(actor: Actor): Promise<UserCredential>;
}
export interface AuthorizationDependencies {
  options: GitHubAppOptions; store: AuthorizationStorePort; cipher: CredentialCipher; http: GitHubAuthorizationHttpPort;
  access: ProjectAccessPort; clock: Clock; ids: IdGenerator;
}
export type RepositoryCreationStatus = "preview" | "creating" | "created" | "blocked" | "unknown";
export interface RepositoryCreationOperation {
  id: string; userId: string; projectId: string; appId: number; githubUserId: number; owner: string;
  name: string; description: string; private: boolean; autoInit: true; idempotencyKey: string;
  confirmationHash: string; revision: number; status: RepositoryCreationStatus; createdAt: string; expiresAt: string;
  repository: CreatedRepository | null; errorCode: string | null; leaseUntil: string | null;
}
export interface RepositoryCreationStorePort {
  findByKey(projectId: string, userId: string, key: string): Promise<RepositoryCreationOperation | null>;
  get(projectId: string, userId: string, id: string): Promise<RepositoryCreationOperation | null>;
  insert(operation: RepositoryCreationOperation): Promise<RepositoryCreationOperation>;
  update(operation: RepositoryCreationOperation, expectedRevision: number): Promise<void>;
}
export interface RepositoryCreationDependencies {
  appId: number; http: GitHubAuthorizationHttpPort; credentials: GitHubUserCredentialProvider;
  access: ProjectAccessPort; capabilities: DeliveryCapabilityPort; store: RepositoryCreationStorePort; clock: Clock; ids: IdGenerator;
}
