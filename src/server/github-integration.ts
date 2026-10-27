import type { Actor, Clock, IdGenerator, ProjectAccessPort } from "../shared/contracts.ts";
import type { DatabasePort } from "../shared/persistence.ts";
import { DomainError } from "../shared/errors.ts";
import {
  AesGcmCredentialCipher,
  GitHubAppAuthorizationHttpAdapter,
  GitHubAuthorizationService,
  PostgresAuthorizationStore,
  PostgresRepositoryCreationStore,
  RepositoryCreationService,
  createGitHubAuthorizationHandler,
  type AuthorizationHandlerPort,
  type DeliveryCapabilityPort,
  type GitHubAuthorizationAction,
  type GitHubAuthorizationHttpAdapterOptions,
  type GitHubCredentialPort,
} from "../modules/github/index.ts";
import type { ApplicationConfig } from "./config.ts";

export interface GitHubIntegrationDependencies {
  config: Pick<ApplicationConfig, "github" | "origin">;
  database: DatabasePort;
  projectRepository: ProjectAccessPort;
  clock: Clock;
  ids: IdGenerator;
  capabilities: DeliveryCapabilityPort;
  resolveActor(request: Request): Promise<Actor | null>;
  assertMutationAllowed(request: Request, actor: Actor): Promise<void>;
  /** Overrides only HTTP transport, so tests still exercise the production adapter and vault. */
  httpTransport?: Omit<GitHubAuthorizationHttpAdapterOptions, "clock">;
}

export type GitHubIntegrationHandler = (
  request: Request,
  params?: { projectId?: string; operationId?: string },
) => Promise<Response>;

export interface GitHubIntegration {
  authorization: GitHubAuthorizationService | null;
  creation: RepositoryCreationService | null;
  /** Server-only credential provider, passed to GitService; never serialized into the client. */
  credentials: GitHubCredentialPort;
  handler(action: GitHubAuthorizationAction): GitHubIntegrationHandler;
}

function notConfigured(): never {
  throw new DomainError("GITHUB_NOT_CONFIGURED", "GitHub App 尚未配置，请联系网站管理员完成配置。", { status: 503 });
}

/** Compose the actual GitHub App user authorization; website login remains the M01 session. */
export function createGitHubIntegration(d: GitHubIntegrationDependencies): GitHubIntegration {
  let authorization: GitHubAuthorizationService | null = null;
  let creation: RepositoryCreationService | null = null;
  let credentials: GitHubCredentialPort = { async getUserCredential() { return notConfigured(); } };

  if (d.config.github) {
    const config = d.config.github;
    if (config.options.origin !== d.config.origin || config.options.callbackUrl !== `${d.config.origin}/api/v1/github/authorization/callback`) {
      throw new DomainError("GITHUB_INVALID_CONFIG", "GitHub App 回调地址与网站地址不一致。", { status: 500 });
    }
    const cipher = new AesGcmCredentialCipher({ activeKeyId: config.keyId, keyring: { ...config.previousKeys, [config.keyId]: config.credentialKey } });
    const http = new GitHubAppAuthorizationHttpAdapter(config.options, { ...d.httpTransport, clock: d.clock });
    authorization = new GitHubAuthorizationService({ options: config.options, store: new PostgresAuthorizationStore(d.database), cipher,
      http, access: d.projectRepository, clock: d.clock, ids: d.ids });
    creation = new RepositoryCreationService({ appId: config.options.appId, http, credentials: authorization,
      access: d.projectRepository, capabilities: d.capabilities, store: new PostgresRepositoryCreationStore(d.database), clock: d.clock, ids: d.ids });
    credentials = authorization;
  }

  // The normal module handler still enforces method, session, CSRF/Origin and body limits when disabled.
  const unavailableAuthorization: AuthorizationHandlerPort = {
    async start() { return notConfigured(); }, async complete() { return notConfigured(); },
    async status() { return notConfigured(); }, async revoke() { return notConfigured(); },
    async startInstallation() { return notConfigured(); }, async completeInstallation() { return notConfigured(); },
    async listInstallations() { return notConfigured(); }, async listRepositories() { return notConfigured(); },
  };
  const unavailableCreation: Pick<RepositoryCreationService, "preview" | "get" | "confirm" | "reconcile"> = {
    async preview() { return notConfigured(); }, async get() { return notConfigured(); },
    async confirm() { return notConfigured(); }, async reconcile() { return notConfigured(); },
  };
  const handlerDependencies = { authorization: authorization ?? unavailableAuthorization, creation: creation ?? unavailableCreation,
    resolveActor: d.resolveActor, assertMutationAllowed: d.assertMutationAllowed, requestId: d.ids.next };
  return { authorization, creation, credentials, handler: action => createGitHubAuthorizationHandler(action, handlerDependencies) };
}
