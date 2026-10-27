import type { AuthHandlers } from "../modules/auth/index.ts";

/** Explicit configuration only; no arbitrary Host or forwarded-header origin is permitted. */
export function validateLocalTestOrigin(mode: string, value?: string): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (mode !== "local" || value !== "http://localhost:3000") throw new Error("AUTH_LOCAL_TEST_ORIGIN only supports http://localhost:3000 in local mode.");
  return value;
}

/** Next binds 127.0.0.1 and constructs its URL with that hostname. Require the
 * original browser Host as well as the fixed server URL. This is a browser
 * origin boundary, not a claim about the TCP peer behind a tunnel. */
export function matchesLocalTestRequest(request: Request, localOrigin?: string): boolean {
  if (!localOrigin || request.headers.get("host") !== "localhost:3000") return false;
  const actualOrigin = new URL(request.url).origin;
  return actualOrigin === localOrigin || actualOrigin === "http://127.0.0.1:3000";
}

/** A second cookie boundary on the same application/database, without another server or database owner. */
export function withLocalTestHandlers<T extends object>(publicHandlers: T, localHandlers: T | null, localOrigin?: string): T {
  if (!localHandlers || !localOrigin) return publicHandlers;
  return new Proxy(publicHandlers, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (request: Request) => {
        const selected = matchesLocalTestRequest(request, localOrigin) ? localHandlers : publicHandlers;
        const operation = Reflect.get(selected, property);
        if (typeof operation !== "function") throw new Error("Invalid local auth handler.");
        return Reflect.apply(operation, selected, [request]);
      };
    },
  });
}

export function withLocalTestAuth(publicHandlers: AuthHandlers, localHandlers: AuthHandlers | null, localOrigin?: string): AuthHandlers {
  return withLocalTestHandlers(publicHandlers, localHandlers, localOrigin);
}

export function matchesLocalTestMutation(request: Request, localOrigin?: string): boolean {
  return Boolean(matchesLocalTestRequest(request, localOrigin) && request.headers.get("origin") === localOrigin);
}
