import { expect, type Browser, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import { createDatabase } from "../../src/server/database.ts";
import { createApplication } from "../../src/server/application.ts";
import { dispatch } from "../../src/server/router.ts";

export interface FixtureIdentity { userId: string; cookie: string; email: string }

// Next.js catch-all params decode each URL segment before calling dispatch.
const routeSegments = (path: string) => path.split("/").map(segment => decodeURIComponent(segment));

/** The rendered application uses real handlers and migrations, while every API
 * request is served from an owned in-memory PostgreSQL fixture. No credentials,
 * persistent directory, model worker or outbound mail transport is loaded. */
export async function isolatedWorkspace(browser: Browser, info: TestInfo) {
  const origin = new URL(String(info.project.use.baseURL ?? "http://localhost:3000")).origin;
  if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname)) throw new Error("Isolated browser tests require a loopback page server");
  const database = await createDatabase({});
  const contexts: BrowserContext[] = [];
  try {
    const app = await createApplication({ mode: "local", origin, codePepper: "ux-browser-fixture-only-pepper-32bytes", emailFrom: "fixture@localhost.invalid" }, database);
    const externalRequests: string[] = [], apiReads: string[] = [];
    async function raw(path: string, method = "GET", body?: unknown, identity?: FixtureIdentity) {
      const url = new URL(`/api/v1/${path}`, origin);
      const headers = new Headers({ origin, "content-type": "application/json" });
      if (identity) headers.set("cookie", identity.cookie);
      return dispatch(app, new Request(url, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), routeSegments(url.pathname.slice("/api/v1/".length)));
    }
    async function request<T>(path: string, method = "GET", body?: unknown, identity?: FixtureIdentity, expectedStatus = 200): Promise<T> {
      const response = await raw(path, method, body, identity);
      const envelope = await response.json() as { data: T; error?: { code: string } };
      // Failure messages intentionally exclude URL tokens, cookies and bodies.
      expect(response.status, `Fixture ${method} response: ${envelope.error?.code ?? "success"}`).toBe(expectedStatus);
      return envelope.data;
    }
    async function challengeCode(email: string) {
      const mail = await database.query<{ body: string }>("SELECT body FROM development_mailbox WHERE recipient=$1 ORDER BY created_at DESC LIMIT 1", [email]);
      const code = mail.rows[0]?.body.match(/\b\d{8}\b/)?.[0];
      if (!code) throw new Error("Isolated development challenge was not available");
      return code;
    }
    async function login(email: string, displayName: string): Promise<FixtureIdentity> {
      const challenge = await request<{ challengeId: string }>("auth/login-challenges", "POST", { email });
      const response = await raw("auth/login-challenges/verify", "POST", { challengeId: challenge.challengeId, code: await challengeCode(email) });
      expect(response.ok, "Fixture session verification must succeed").toBeTruthy();
      const { data } = await response.json();
      const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
      if (!cookie) throw new Error("Isolated session was not created");
      const identity = { email, cookie, userId: data.profile.id as string };
      await request("me", "PATCH", { displayName, timezone: "Asia/Shanghai", expectedRevision: data.profile.revision }, identity);
      return identity;
    }
    async function attach(context: BrowserContext, rememberIntroduction = true) {
      contexts.push(context);
      if (rememberIntroduction) await context.addInitScript(version => localStorage.setItem("hackathon-navigator-intro-" + version, "seen"), app.navigator.intro().version);
      // Guard all pages in this context, including redirects and popup windows.
      await context.route("**/*", async route => {
        const browserRequest = route.request(), url = new URL(browserRequest.url());
        if (["http:", "https:"].includes(url.protocol) && url.origin !== origin) {
          externalRequests.push(url.origin); await route.abort("blockedbyclient"); return;
        }
        if (url.pathname.startsWith("/api/v1/")) {
          const path = url.pathname.slice("/api/v1/".length);
          apiReads.push(`${browserRequest.method()} ${path.replace(/invitations\/[^/]+/, "invitations/[token]")}`);
          const data = browserRequest.postData();
          const headers = await browserRequest.allHeaders();
          let response = await dispatch(app, new Request(browserRequest.url(), { method: browserRequest.method(), headers, ...(data === null ? {} : { body: data }) }), routeSegments(path));
          // Existing regression cases represent users who already took the tour.
          // First-login suites opt out with attach(context, false) and exercise it normally.
          if (rememberIntroduction && path === "me/onboarding" && browserRequest.method() === "GET" && response.ok) {
            const state = (await response.clone().json()).data;
            if (!state.completedAt) response = await dispatch(app, new Request(browserRequest.url(), {
              method: "POST", headers: { ...headers, origin },
              body: JSON.stringify({ expectedRevision: state.revision, stepIndex: 5, completed: true }),
            }), ["me", "onboarding"]);
          }
          await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
          return;
        }
        await route.continue();
      });
      return context;
    }
    async function page(identity?: FixtureIdentity, width = 1280): Promise<Page> {
      // These regression identities have already learned the website. Prepare
      // that fixture fact before a test takes its business-state fingerprint.
      if (identity) {
        const state = await request<{ revision: number; completedAt: string | null }>("me/onboarding", "GET", undefined, identity);
        if (!state.completedAt) await request("me/onboarding", "POST", { expectedRevision: state.revision, stepIndex: 5, completed: true }, identity);
      }
      const context = await attach(await browser.newContext({ baseURL: origin, viewport: { width, height: 900 } }));
      if (identity) {
        const separator = identity.cookie.indexOf("=");
        await context.addCookies([{ name: identity.cookie.slice(0, separator), value: identity.cookie.slice(separator + 1), domain: new URL(origin).hostname, path: "/", httpOnly: true, sameSite: "Lax" }]);
      }
      return context.newPage();
    }
    return { origin, app, database, raw, request, login, challengeCode, attach, page, externalRequests, apiReads,
      async close() { for (const context of contexts) await context.close(); await database.close(); } };
  } catch (error) { for (const context of contexts) await context.close(); await database.close(); throw error; }
}

export type IsolatedWorkspace = Awaited<ReturnType<typeof isolatedWorkspace>>;
