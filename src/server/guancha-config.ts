export interface GuanchaLoginConfiguration {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly origin: string;
  readonly redirectUri: string;
  readonly enabled: boolean;
}

/** Credentials are server-only. Activation follows registration of the exact
 * callback in the provider console, never an arbitrary request Host header. */
export function guanchaConfiguration(env: Record<string, string | undefined>, origin: string): GuanchaLoginConfiguration | undefined {
  const names = ["GUANCHA_CLIENT_ID", "GUANCHA_CLIENT_SECRET", "GUANCHA_REDIRECT_URI"] as const;
  const configured = names.some(name => Boolean(env[name]?.trim()));
  const enabled = env.GUANCHA_LOGIN_ENABLED === "true";
  if (env.GUANCHA_LOGIN_ENABLED && !["true", "false"].includes(env.GUANCHA_LOGIN_ENABLED)) throw new Error("GUANCHA_LOGIN_ENABLED must be true or false.");
  if (!configured && !enabled) return undefined;
  if (!names.every(name => env[name]?.trim())) throw new Error("Guancha client credentials and exact callback must be configured together.");
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password || env.GUANCHA_REDIRECT_URI !== `${origin}/api/v1/auth/guancha/callback`) {
    throw new Error("GUANCHA_REDIRECT_URI must match the fixed HTTPS website callback.");
  }
  return { clientId: env.GUANCHA_CLIENT_ID!, clientSecret: env.GUANCHA_CLIENT_SECRET!, redirectUri: env.GUANCHA_REDIRECT_URI!, origin, enabled };
}
