import type { IdGenerator } from "../../shared/contracts.ts";
import { DomainError, isDomainError, toErrorEnvelope } from "../../shared/errors.ts";
import type { OrganizerPrincipal } from "../../shared/organizer-contracts.ts";
import type { EventSiteService } from "./service.ts";

/**
 * 专属页 HTTP 工厂（规划 35 P1b）。与仓库既有模块同形：
 * 私有 Cache-Control: no-store、X-Content-Type-Options: nosniff、GET 只读、
 * 写请求由根做 Origin/CSRF 授权、错误统一走 DomainError 与 toErrorEnvelope。
 *
 * **路径由根注册**：本文件只产出按名调用的 handler，不注册路由、不新增导航。
 * 公开页（/s/:shortCode）不需要登录；其余全部要当前账号，且权限由服务层用注入端口判定。
 *
 * 写请求自己解析 body 并设大小上限：
 * - 规格类（保存草稿、存模板）上限 160KB：128KB 的规格加上外层信封仍放得下；
 * - 其余写请求 64KB；
 * - 不接受压缩内容（content-encoding 必须是 identity），避免绕过体积上限。
 */

/** 规格类写请求上限：128KB 规格 + 外层 JSON 信封的余量。 */
export const EVENT_SITE_SPEC_BODY_LIMIT = 160 * 1024;
/** 普通写请求上限。 */
export const EVENT_SITE_JSON_BODY_LIMIT = 64 * 1024;

const NO_STORE_HEADERS = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } as const;

export interface EventSiteHttpDependencies {
  readonly service: EventSiteService;
  /** 根解析真实账号与会话；返回 null 表示未登录。 */
  resolvePrincipal(request: Request): Promise<OrganizerPrincipal | null>;
  /** 根做 Origin/CSRF/一次性令牌等写请求授权。 */
  authorizeMutation(request: Request, principal: OrganizerPrincipal): Promise<void>;
  readonly requestIds: IdGenerator;
}

export interface EventSiteRouteParams {
  readonly eventId?: string;
  readonly shortCode?: string;
  readonly templateId?: string;
  /** P4：回退目标的历史版本号（路径参数，十进制正整数）。 */
  readonly revision?: string;
}

type Work = (principal: OrganizerPrincipal, request: Request, params: EventSiteRouteParams) => Promise<unknown>;
type PublicWork = (request: Request, params: EventSiteRouteParams) => Promise<unknown>;

export function createEventSiteHandlers(deps: EventSiteHttpDependencies) {
  async function respond(work: () => Promise<unknown>): Promise<Response> {
    const requestId = deps.requestIds.next();
    try {
      return Response.json({ data: await work(), requestId }, { headers: NO_STORE_HEADERS });
    } catch (error) {
      return Response.json(toErrorEnvelope(error, requestId), {
        status: isDomainError(error) ? error.status : 500, headers: NO_STORE_HEADERS,
      });
    }
  }

  /** 需要登录的入口：GET 只读，其余先过写授权。 */
  const handler = (method: string, work: Work) => async (request: Request, params: EventSiteRouteParams): Promise<Response> => respond(async () => {
    if (request.method !== method) throw new DomainError("METHOD_NOT_ALLOWED", "该入口不支持此请求方法。", { status: 405 });
    const principal = await deps.resolvePrincipal(request);
    if (principal === null || principal === undefined) throw new DomainError("UNAUTHENTICATED", "请先登录，再继续专属页的操作。", { status: 401 });
    if (method !== "GET") await deps.authorizeMutation(request, principal);
    return work(principal, request, params ?? {});
  });

  /** 公开入口：不解析身份，也不因为没登录而拒绝。 */
  const publicHandler = (method: string, work: PublicWork) => async (request: Request, params: EventSiteRouteParams): Promise<Response> => respond(async () => {
    if (request.method !== method) throw new DomainError("METHOD_NOT_ALLOWED", "该入口不支持此请求方法。", { status: 405 });
    return work(request, params ?? {});
  });

  return {
    /* ---------------- 1. 公开只读页（/s/:shortCode） ---------------- */
    publicPage: publicHandler("GET", async (_request, params) => deps.service.publicPage(shortCodeOf(params.shortCode))),

    /* ---------------- 2. 编辑页读取（/organizer/events/:eventId/page） ---------------- */
    getPage: handler("GET", (principal, _request, params) => deps.service.pageForOrganizer(principal, eventIdOf(params.eventId))),

    /* ---------------- 3. 保存草稿（同一路径 PUT；CAS） ---------------- */
    savePage: handler("PUT", async (principal, request, params) => {
      const input = await jsonBody(request, EVENT_SITE_SPEC_BODY_LIMIT, true);
      return deps.service.saveDraft(principal, eventIdOf(params.eventId), {
        spec: input.spec, expectedRevision: input.expectedRevision,
      });
    }),

    /* ---------------- 4. 发布（闸门 + 不可变快照） ---------------- */
    publishPage: handler("POST", async (principal, request, params) => {
      const input = await jsonBody(request, EVENT_SITE_JSON_BODY_LIMIT, true);
      return deps.service.publish(principal, eventIdOf(params.eventId), { expectedRevision: input.expectedRevision });
    }),

    /* ---------------- 5. 换短码（旧链接立即失效） ---------------- */
    rotateShortCode: handler("POST", async (principal, request, params) => {
      const input = await jsonBody(request, EVENT_SITE_JSON_BODY_LIMIT, true);
      return deps.service.rotateShortCode(principal, eventIdOf(params.eventId), { expectedRevision: input.expectedRevision });
    }),

    /* ---------------- 6. 停用（body.kind 决定主办方还是平台） ---------------- */
    suspendPage: handler("POST", async (principal, request, params) => {
      const input = await jsonBody(request, EVENT_SITE_JSON_BODY_LIMIT, true);
      return deps.service.suspend(principal, eventIdOf(params.eventId), {
        expectedRevision: input.expectedRevision, kind: input.kind, reason: input.reason,
      });
    }),

    /* ---------------- 7. 恢复（平台停用会被服务层 403 挡住） ---------------- */
    resumePage: handler("POST", async (principal, request, params) => {
      const input = await jsonBody(request, EVENT_SITE_JSON_BODY_LIMIT, true);
      return deps.service.resume(principal, eventIdOf(params.eventId), { expectedRevision: input.expectedRevision });
    }),

    /* ---------------- 8. 机构模板：列表 / 新建或更新 ---------------- */
    listTemplates: handler("GET", async (principal, request) => deps.service.listTemplates(principal, queryId(request, "organizationId", "机构"))),
    saveTemplate: handler("POST", async (principal, request) => {
      const input = await jsonBody(request, EVENT_SITE_SPEC_BODY_LIMIT, true);
      return deps.service.saveTemplate(principal, queryId(request, "organizationId", "机构"), {
        templateId: input.templateId, name: input.name, spec: input.spec, expectedRevision: input.expectedRevision,
      });
    }),

    /* ---------------- 9. 机构级只读清点（/organizer/pages） ---------------- */
    listOrganizationPages: handler("GET", async (principal, request) => deps.service.organizationPages(principal, queryId(request, "organizationId", "机构"))),

    /* ---------------- 10. 套用模板（复制快照，不建立联动） ---------------- */
    applyTemplate: handler("POST", async (principal, request, params) => {
      const input = await jsonBody(request, EVENT_SITE_JSON_BODY_LIMIT, true);
      return deps.service.applyTemplate(principal, eventIdOf(params.eventId), {
        templateId: input.templateId, expectedRevision: input.expectedRevision,
      });
    }),

    /* ---------------- 11. 删除模板 ---------------- */
    deleteTemplate: handler("DELETE", async (principal, request, params) => {
      // DELETE 允许不带 body：机构从查询串来，模板从路径来。
      await jsonBody(request, EVENT_SITE_JSON_BODY_LIMIT, false);
      return deps.service.deleteTemplate(principal, queryId(request, "organizationId", "机构"), routeId(params.templateId, "模板"));
    }),

    /* ---------------- 12. 平台只读清点（/admin/hosted-sites） ---------------- */
    listHostedSites: handler("GET", (principal) => deps.service.platformPages(principal)),

    /* ---------------- 13. 平台停用（固定 kind=platform） ---------------- */
    adminSuspendPage: handler("POST", async (principal, request, params) => {
      const input = await jsonBody(request, EVENT_SITE_JSON_BODY_LIMIT, true);
      return deps.service.suspend(principal, eventIdOf(params.eventId), {
        expectedRevision: input.expectedRevision, kind: "platform", reason: input.reason,
      });
    }),

    /* ---------------- 14. 平台恢复（可解平台停用） ---------------- */
    adminResumePage: handler("POST", async (principal, request, params) => {
      const input = await jsonBody(request, EVENT_SITE_JSON_BODY_LIMIT, true);
      return deps.service.resumeByPlatform(principal, eventIdOf(params.eventId), { expectedRevision: input.expectedRevision });
    }),

    /* ---------------- 15. 草稿历史列表（只读；不含 spec 正文） ---------------- */
    listRevisions: handler("GET", (principal, _request, params) => deps.service.listRevisions(principal, eventIdOf(params.eventId))),

    /* ---------------- 16. 回退到某一版（只写草稿，不动 published） ---------------- */
    restoreRevision: handler("POST", async (principal, request, params) => {
      const input = await jsonBody(request, EVENT_SITE_JSON_BODY_LIMIT, true);
      return deps.service.restoreRevision(principal, eventIdOf(params.eventId), {
        revision: revisionParam(params.revision), expectedRevision: input.expectedRevision,
      });
    }),
  };
}

export type EventSiteHandlers = ReturnType<typeof createEventSiteHandlers>;

/* ------------------------------------------------------------------ *
 * 参数与 body
 * ------------------------------------------------------------------ */

function routeId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 160) {
    throw new DomainError("INVALID_ROUTE", "缺少有效的" + label + "地址。", { status: 400 });
  }
  return value;
}

function eventIdOf(value: unknown): string {
  return routeId(value, "赛事");
}

function shortCodeOf(value: unknown): string {
  return routeId(value, "短码");
}

/**
 * 路径里的版本号：只接受十进制非负整数串（"0"、"12" 合法，"1.5"、"-1"、"abc" 一律 400）。
 * 服务层还会再按 revisionOf 校验一次；这里只负责把路径文本变成数字，不判断版本是否存在。
 */
function revisionParam(value: unknown): number {
  const raw = routeId(value, "版本");
  if (!/^[0-9]{1,10}$/.test(raw)) {
    throw new DomainError("INVALID_ROUTE", "版本号必须是十进制整数。", { status: 400 });
  }
  return Number(raw);
}

function queryId(request: Request, name: string, label: string): string {
  const raw = new URL(request.url).searchParams.get(name);
  return routeId(raw, label);
}

/** 读 JSON body：先看声明的长度，再按 8KB 分块累计，绝不把超限内容读进内存。 */
async function jsonBody(request: Request, limit: number, required: boolean): Promise<Record<string, unknown>> {
  const encoding = request.headers.get("content-encoding");
  if (encoding !== null && encoding.trim().toLowerCase() !== "identity") {
    throw new DomainError("JSON_REQUIRED", "请提交未压缩的 JSON 内容。", { status: 415 });
  }
  const contentType = request.headers.get("content-type");
  const mediaType = contentType === null ? "" : (contentType.split(";", 1)[0] ?? "").trim().toLowerCase();
  const lengthHeader = request.headers.get("content-length");
  const declared = lengthHeader !== null && /^\d+$/.test(lengthHeader.trim()) ? Number(lengthHeader.trim()) : null;
  if (declared !== null && declared > limit) throw payloadTooLarge(limit);
  if (mediaType !== "application/json") {
    if (!required && (mediaType === "" || declared === 0)) return {};
    throw new DomainError("JSON_REQUIRED", "请提交未压缩的 JSON 内容。", { status: 415 });
  }
  const reader = request.body === null ? null : request.body.getReader();
  if (reader === null) {
    if (!required) return {};
    throw new DomainError("INVALID_JSON", "请提交有效 JSON 内容。", { status: 400 });
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => undefined);
        throw payloadTooLarge(limit);
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (size === 0) {
    if (!required) return {};
    throw new DomainError("INVALID_JSON", "请提交有效 JSON 内容。", { status: 400 });
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new DomainError("INVALID_JSON", "请提交有效 JSON 内容。", { status: 400 });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DomainError("EVENT_SITE_INVALID_INPUT", "请求内容必须是一个 JSON 对象。", { status: 422 });
  }
  return value as Record<string, unknown>;
}

function payloadTooLarge(limit: number): DomainError {
  return new DomainError("PAYLOAD_TOO_LARGE", "输入超过 " + String(Math.floor(limit / 1024)) + "KB，请缩短后继续。", { status: 413 });
}
