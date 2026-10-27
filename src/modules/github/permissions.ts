import type { Actor, ProjectAccessPort } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";

export async function requireProjectAccess(access: ProjectAccessPort, actor: Actor, projectId: string, manager = false): Promise<void> {
  if (!actor?.userId) throw new DomainError("UNAUTHENTICATED", "请先登录。", { status: 401 });
  const membership = await access.getMembership(projectId, actor.userId);
  if (!membership || membership.projectId !== projectId || membership.userId !== actor.userId || membership.status !== "active") {
    throw new DomainError("PROJECT_NOT_FOUND", "项目不存在或你已不能访问。", { status: 404 });
  }
  if (manager && membership.role !== "manager") throw new DomainError("PROJECT_MANAGER_REQUIRED", "请由项目管理员操作。", { status: 403 });
}
