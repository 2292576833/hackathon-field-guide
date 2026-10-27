/** All types in this module are server-side boundaries, never public JSON models. */
export interface GuanchaProviderConfiguration {
  /** Exact trusted identity namespace, independent of a display name/email. */
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly redirectUri: string;
  readonly documentationUrl: string;
  /** A changed protocol/client configuration must invalidate outstanding attempts. */
  readonly configurationId: string;
  readonly pkce: "S256" | "documented-unsupported";
  readonly useNonce: boolean;
}

export interface GuanchaVerifiedIdentity {
  readonly issuer: string;
  readonly subject: string;
  readonly displayName?: string;
  /**
   * 观猹头像地址（官方 userinfo 在用户有头像时才返回）。
   *
   * 它只是**待下载的候选地址**，不是已核验的头像：字节类型与大小必须在服务端下载时再校验，
   * 绝不能直接把第三方地址当成本站头像展示。
   */
  readonly avatarUrl?: string;
}

export interface GuanchaAttemptSecrets {
  readonly codeVerifier: string | null;
  readonly nonce: string | null;
}

export interface GuanchaLoginAttempt {
  readonly stateHash: string;
  readonly browserBindingHash: string;
  readonly issuer: string;
  readonly configurationId: string;
  readonly redirectUri: string;
  readonly returnTo: string;
  readonly secretCiphertext: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface GuanchaBeginResult {
  readonly authorizationUrl: string;
  /** Only place in an HttpOnly browser cookie; never in URL/localStorage/JSON. */
  readonly browserBinding: string;
  readonly expiresAt: string;
}

export interface GuanchaCallbackInput {
  readonly state: unknown;
  /** Read solely from the server-controlled browser cookie. */
  readonly browserBinding: unknown;
  readonly code?: unknown;
  readonly error?: unknown;
}
