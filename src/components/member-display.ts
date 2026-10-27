/** Safe roster metadata supplied only by an authorized project/team response. */
export interface DisplayMember { membershipId: string; userId: string; displayName?: string | null }
function name(member: DisplayMember): string {
  return typeof member.displayName === "string" ? member.displayName.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) : "";
}
function stableCode(member: DisplayMember): string {
  // Browser-safe FNV-1a; the same user keeps their label after rejoining or sorting.
  let hash = 14695981039346656037n;
  for (const character of member.userId || member.membershipId) hash = BigInt.asUintN(64, (hash ^ BigInt(character.codePointAt(0)!)) * 1099511628211n);
  return hash.toString(36).padStart(13, "0").slice(-7).toUpperCase();
}
/** Pass the full roster as allMembers, even when rendering a filtered selector. */
export function memberLabel(member: DisplayMember, currentUserId?: string, allMembers: readonly DisplayMember[] = []): string {
  if (currentUserId && member.userId === currentUserId) return "你";
  const displayName = name(member), suffix = stableCode(member);
  if (!displayName) return `队友 · ${suffix}`;
  const duplicate = allMembers.some(other => other.userId !== member.userId && name(other).toLocaleLowerCase("zh-CN") === displayName.toLocaleLowerCase("zh-CN"));
  return duplicate ? `${displayName} · ${suffix}` : displayName;
}
