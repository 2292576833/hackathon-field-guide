import { DomainError } from "../../shared/errors.ts";
import type { Invitation, InvitationAcceptance } from "./model.ts";

export function invitationUsage(value: Invitation): { maxUses: number; usedUses: number; remainingUses: number; acceptances: InvitationAcceptance[] } {
  const maxUses = value.maxUses ?? 1;
  const acceptances = (value.acceptances ?? (value.status === "accepted" && value.acceptedBy && value.acceptedAt ? [{ invitationId: value.id, userId: value.acceptedBy, membershipId: null, acceptedAt: value.acceptedAt }] : []))
    .map(item => ({ ...item, membershipId: item.membershipId ?? null }));
  const usedUses = value.usedUses ?? acceptances.length;
  if (!Number.isSafeInteger(maxUses) || maxUses < 1 || maxUses > 50 || !Number.isSafeInteger(usedUses) || usedUses < 0 || usedUses > maxUses || acceptances.length !== usedUses || new Set(acceptances.map(item => item.userId)).size !== acceptances.length || acceptances.some(item => item.invitationId !== value.id || item.membershipId !== null && (typeof item.membershipId !== "string" || item.membershipId.trim().length === 0))) throw new DomainError("INVALID_INVITATION_USAGE", "邀请额度与历史记录不一致，请联系空间管理员。", { status: 409 });
  return { maxUses, usedUses, remainingUses: maxUses - usedUses, acceptances: structuredClone(acceptances) };
}
export function consumeInvitation(value: Invitation, userId: string, membershipId: string, acceptedAt: string): void {
  const usage = invitationUsage(value);
  if (typeof membershipId !== "string" || membershipId.trim().length === 0) throw new DomainError("INVALID_INVITATION_USAGE", "接受邀请必须关联本次加入的成员记录。", { status: 409 });
  if (usage.acceptances.some(item => item.userId === userId)) throw new DomainError("INVITATION_ALREADY_USED", "你已经使用过这条邀请，不能重复消费或通过它重新加入。", { status: 409 });
  if (usage.remainingUses < 1) throw new DomainError("INVITATION_ALREADY_USED", "邀请名额已用完，请索取新链接。", { status: 409 });
  value.maxUses = usage.maxUses; value.usedUses = usage.usedUses + 1;
  value.acceptances = [...usage.acceptances, { invitationId: value.id, userId, membershipId, acceptedAt }];
  value.status = value.usedUses === value.maxUses ? "accepted" : "pending";
  value.acceptedBy = value.status === "accepted" ? userId : null;
  value.acceptedAt = value.status === "accepted" ? acceptedAt : null;
  value.revision += 1;
}
