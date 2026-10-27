import { randomUUID } from "node:crypto";
import type { Actor } from "../../shared/contracts.ts";
import { DomainError, toErrorEnvelope } from "../../shared/errors.ts";
import type { ProjectRole } from "../../shared/contracts.ts";
import type { ProjectStage, TeamRole } from "./model.ts";
import type { AvailabilityInput, BookmarkInput, CreateProjectInput, EditProjectInput, InvitationInput, ManagementTransferInput } from "./service.ts";
import { ProjectsService } from "./service.ts";
import { assertKnownFields, revisionField } from "./validation.ts";

export type ProjectsHttpRoute =
  | { kind: "projects" }
  | { kind: "project"; projectId: string }
  | { kind: "projectTeam"; projectId: string }
  | { kind: "projectInvitations"; projectId: string }
  | { kind: "projectInvitation"; projectId: string; invitationId: string }
  | { kind: "invitationAccept"; token: string }
  | { kind: "invitationPreview"; token: string }
  | { kind: "publicInvitationPreview"; token: string }
  | { kind: "projectMembers"; projectId: string }
  | { kind: "projectMember"; projectId: string; userId: string }
  | { kind: "projectManagementTransfer"; projectId: string }
  | { kind: "projectLeave"; projectId: string }
  | { kind: "projectAvailability"; projectId: string }
  | { kind: "projectStage"; projectId: string }
  | { kind: "projectClone"; projectId: string }
  | { kind: "projectActivity"; projectId: string }
  | { kind: "projectResources"; projectId: string }
  | { kind: "projectResource"; projectId: string; bookmarkId: string }
  | { kind: "teams" }
  | { kind: "team"; teamId: string }
  | { kind: "teamInvitations"; teamId: string }
  | { kind: "teamInvitation"; teamId: string; invitationId: string }
  | { kind: "teamMember"; teamId: string; userId: string }
  | { kind: "teamMembers"; teamId: string }
  | { kind: "teamCaptainTransfer"; teamId: string }
  | { kind: "teamLeave"; teamId: string };

export interface ProjectsHttpDependencies {
  service: ProjectsService;
  /** M01 resolves a verified session; request JSON can never supply this Actor. */
  resolveActor(request: Request): Promise<Actor | null>;
  /** Required integration guard: verify CSRF/origin for cookie-authenticated mutations. */
  authorizeMutation(request: Request): Promise<void>;
  requestId?(): string;
}

const allowedMethods: Record<ProjectsHttpRoute["kind"], readonly string[]> = {
  projects: ["GET", "POST"], project: ["GET", "PATCH"], projectTeam: ["PUT"],
  projectInvitations: ["GET", "POST"], projectInvitation: ["DELETE"], invitationAccept: ["POST"],
  invitationPreview: ["GET"], publicInvitationPreview: ["GET"], projectMembers: ["GET"], projectManagementTransfer: ["POST"],
  projectMember: ["PATCH", "DELETE"], projectLeave: ["POST"], projectAvailability: ["GET", "PUT"],
  projectStage: ["POST"], projectClone: ["POST"], projectActivity: ["GET"], projectResources: ["GET", "POST"], projectResource: ["DELETE"],
  teams: ["GET", "POST"], team: ["GET", "PATCH", "DELETE"], teamInvitations: ["GET", "POST"], teamInvitation: ["DELETE"], teamMember: ["PATCH", "DELETE"], teamMembers: ["GET"], teamCaptainTransfer: ["POST"], teamLeave: ["POST"],
};

async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) throw new DomainError("JSON_REQUIRED", "请发送 JSON 格式的请求。", { status: 415 });
  const reader = request.body?.getReader();
  if (!reader) throw new DomainError("INVALID_INPUT", "请求内容为空。", { status: 422 });
  const chunks: Uint8Array[] = []; let total = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > 64 * 1024) {
        // A transport's cancellation promise may never settle. Reject the body immediately.
        void reader.cancel().catch(() => {});
        throw new DomainError("REQUEST_TOO_LARGE", "请求内容超过 64 KiB，请缩减后重试。", { status: 413 });
      }
      chunks.push(result.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let result: unknown;
  try { result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new DomainError("INVALID_JSON", "请求内容不是有效的 JSON，请检查后重试。", { status: 422 }); }
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new DomainError("INVALID_INPUT", "请求内容必须是一个对象。", { status: 422 });
  return result as Record<string, unknown>;
}

function expected(body: Record<string, unknown>): number {
  assertKnownFields(body, ["expectedRevision"]); return revisionField(body.expectedRevision);
}

function includeHistory(request: Request): boolean {
  const value = new URL(request.url).searchParams.get("history");
  if (value !== null && value !== "true" && value !== "false") throw new DomainError("INVALID_INPUT", "历史成员筛选只能为 true 或 false。", { status: 422 });
  return value === "true";
}

/** Next.js route files remain coordinator-owned; map one explicit route descriptor to this handler. */
export function createProjectsHttpHandlers(dependencies: ProjectsHttpDependencies) {
  return {
    async handle(request: Request, route: ProjectsHttpRoute): Promise<Response> {
      const requestId = dependencies.requestId?.() ?? randomUUID();
      const headers: Record<string, string> = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };
      try {
        const methods = allowedMethods[route.kind];
        if (!methods.includes(request.method)) { headers.Allow = methods.join(", "); throw new DomainError("METHOD_NOT_ALLOWED", "此接口不支持该请求方法。", { status: 405 }); }
        if (route.kind === "publicInvitationPreview") {
          const data = await dependencies.service.previewPublicSpaceInvitation(route.token);
          return Response.json({ data, requestId }, { headers });
        }
        const actor = await dependencies.resolveActor(request);
        if (!actor) throw new DomainError("UNAUTHENTICATED", "请登录后继续。", { status: 401 });
        if (request.method !== "GET") await dependencies.authorizeMutation(request);
        const service = dependencies.service;
        let data: unknown; let status = 200;
        switch (route.kind) {
          case "projects":
            if (request.method === "GET") data = await service.listProjects(actor);
            else { data = await service.createProject(actor, await jsonBody(request) as unknown as CreateProjectInput); status = 201; }
            break;
          case "project":
            data = request.method === "GET" ? await service.getProject(actor, route.projectId) : await service.editProject(actor, route.projectId, await jsonBody(request) as unknown as EditProjectInput);
            break;
          case "projectTeam":
            data = await service.associateTeam(actor, route.projectId, await jsonBody(request) as unknown as { expectedRevision: number; teamId: string | null; confirmNoAutomaticMembers: true }); break;
          case "projectInvitations":
            if (request.method === "GET") data = await service.listProjectInvitations(actor, route.projectId);
            else { data = await service.createProjectInvitation(actor, route.projectId, await jsonBody(request) as unknown as InvitationInput); status = 201; }
            break;
          case "projectInvitation": data = await service.revokeProjectInvitation(actor, route.projectId, route.invitationId, expected(await jsonBody(request))); break;
          case "invitationAccept":
            // Accept is an explicit authenticated action. There is no auto-join on GET.
            data = await service.acceptInvitation(actor, route.token); break;
          case "invitationPreview": data = await service.previewInvitation(actor, route.token); break;
          case "projectMembers": data = await service.getProjectMembers(actor, route.projectId, includeHistory(request)); break;
          case "projectManagementTransfer": data = await service.transferProjectManagement(actor, route.projectId, await jsonBody(request) as unknown as ManagementTransferInput); break;
          case "projectMember":
            data = request.method === "PATCH" ? await service.changeProjectRole(actor, route.projectId, route.userId, await jsonBody(request) as unknown as { expectedRevision: number; role: ProjectRole }) : await service.removeProjectMember(actor, route.projectId, route.userId, expected(await jsonBody(request))); break;
          case "projectLeave": data = await service.leaveProject(actor, route.projectId, expected(await jsonBody(request))); break;
          case "projectAvailability": data = request.method === "GET" ? await service.getMyAvailability(actor, route.projectId) : await service.updateMyAvailability(actor, route.projectId, await jsonBody(request) as unknown as AvailabilityInput); break;
          case "projectStage": data = await service.transitionStage(actor, route.projectId, await jsonBody(request) as unknown as { expectedRevision: number; stage: ProjectStage; reason: string }); break;
          case "projectClone": data = await service.cloneProject(actor, route.projectId, await jsonBody(request) as unknown as { name: string; copyGoal?: boolean; copyMinimumDeliverable?: boolean }); status = 201; break;
          case "projectActivity": {
            const parameter = new URL(request.url).searchParams.get("limit");
            data = await service.getActivity(actor, route.projectId, parameter === null ? 50 : Number(parameter)); break;
          }
          case "projectResources":
            if (request.method === "GET") data = await service.listResources(actor, route.projectId);
            else { data = await service.addResource(actor, route.projectId, await jsonBody(request) as unknown as BookmarkInput); status = 201; }
            break;
          case "projectResource": data = await service.removeResource(actor, route.projectId, route.bookmarkId, expected(await jsonBody(request))); break;
          case "teams":
            if (request.method === "GET") data = await service.listTeams(actor);
            else { data = await service.createTeam(actor, await jsonBody(request) as unknown as { name: string }); status = 201; }
            break;
          case "team":
            if (request.method === "GET") data = await service.getTeam(actor, route.teamId);
            else if (request.method === "PATCH") data = await service.editTeam(actor, route.teamId, await jsonBody(request) as unknown as { expectedRevision: number; name: string });
            else data = await service.dissolveTeam(actor, route.teamId, expected(await jsonBody(request)));
            break;
          case "teamInvitations":
            if (request.method === "GET") data = await service.listTeamInvitations(actor, route.teamId);
            else { data = await service.createTeamInvitation(actor, route.teamId, await jsonBody(request) as unknown as InvitationInput); status = 201; }
            break;
          case "teamInvitation": data = await service.revokeTeamInvitation(actor, route.teamId, route.invitationId, expected(await jsonBody(request))); break;
          case "teamMember": data = request.method === "PATCH" ? await service.changeTeamRole(actor, route.teamId, route.userId, await jsonBody(request) as unknown as { expectedRevision: number; role: TeamRole }) : await service.removeTeamMember(actor, route.teamId, route.userId, expected(await jsonBody(request))); break;
          case "teamMembers": data = await service.getTeamMembers(actor, route.teamId, includeHistory(request)); break;
          case "teamCaptainTransfer": data = await service.transferTeamCaptain(actor, route.teamId, await jsonBody(request) as unknown as ManagementTransferInput); break;
          case "teamLeave": data = await service.leaveTeam(actor, route.teamId, expected(await jsonBody(request))); break;
        }
        return Response.json({ data, requestId }, { status, headers });
      } catch (error) {
        return Response.json(toErrorEnvelope(error, requestId), { status: error instanceof DomainError ? error.status : 500, headers });
      }
    },
  };
}
