"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Actor } from "../shared/contracts.ts";
import type { SkillCandidate, SkillCandidateDocument, SkillPublicationTarget, SkillReviewSnapshot } from "../modules/skills/publication-types.ts";
import type { SkillReviewPanelApi, SkillReviewPanelExactTarget, SkillReviewPanelRecord } from "../modules/skills/ui.ts";
import { SkillReviewPanel } from "../modules/skills/ui.ts";
import { ApiError, api, useApi } from "./client-api.ts";
import { Feedback, Loading, type Me } from "./site-shell.tsx";

export interface SkillsAdministrationClientProps { actor?: Actor; }
const candidatePath = (target: SkillPublicationTarget) => `/admin/skill-candidates/${encodeURIComponent(target.kind)}/${encodeURIComponent(target.id)}/${encodeURIComponent(target.versionId)}`;
const expectation = (target: SkillReviewPanelExactTarget) => ({ expectedCandidateRevision: target.expectedRevision, expectedContentHash: target.expectedContentHash, expectedManifestHash: target.expectedManifestHash });
const sameTarget = (left: SkillPublicationTarget, right: SkillPublicationTarget) => left.kind === right.kind && left.id === right.id && left.versionId === right.versionId;
function documentTarget(document: SkillCandidateDocument): SkillPublicationTarget {
  if (document.kind === "skill") {
    if (!document.skill || !Array.isArray(document.skill.versions) || document.skill.versions.length !== 1 || !document.skill.versions[0]?.id) throw new Error("候选技能必须填写一个明确固定版本。");
    return { kind: "skill", id: document.skill.id, versionId: document.skill.versions[0].id };
  }
  if (!document.bundle?.id || !document.bundle.version) throw new Error("候选技能包必须填写明确 ID 和版本。");
  return { kind: "bundle", id: document.bundle.id, versionId: `${document.bundle.id}@${document.bundle.version}` };
}

export function SkillsAdministrationClient({ actor }: SkillsAdministrationClientProps) {
  const identity = useApi<Me>("/me");
  const accountId = identity.data?.profile.id ?? "";
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === "visible") void identity.reload(); };
    window.addEventListener("focus", refresh); document.addEventListener("visibilitychange", refresh);
    return () => { window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [identity.reload]);
  const assertCurrent = useCallback(async () => {
    const current = await api<Me>("/me");
    if (!accountId || current.profile.id !== accountId || (actor && actor.userId !== current.profile.id)) {
      identity.setData(current);
      throw new Error("账号已变化，旧技能审核页面已清空。请重新打开当前账号的审核页面。");
    }
  }, [accountId, actor?.userId, identity.setData]);
  if (!identity.data) return <><Feedback error={identity.error}/>{identity.loading && <Loading/>}</>;
  if (actor && actor.userId !== accountId) return <Feedback error="账号已变化，请重新打开当前账号的技能审核页面。"/>;
  return <><Feedback error={identity.error}/><p>当前核验人网站 ID：<code>{accountId}</code>。证据中的核验人和日期仅在实际核验后填写。</p><SkillsAdministrationForAccount key={accountId} assertCurrent={assertCurrent}/></>;
}

function SkillsAdministrationForAccount({ assertCurrent }: { assertCurrent: () => Promise<void> }) {
  const permissions = useApi<{ platformRoles: string[] }>("/me/permissions");
  const [blocked, setBlocked] = useState("");
  const canReview = Boolean(permissions.data?.platformRoles.some(role => role === "reviewer" || role === "admin"));
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === "visible") void permissions.reload(); };
    window.addEventListener("focus", refresh); document.addEventListener("visibilitychange", refresh);
    return () => { window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [permissions.reload]);
  const request = useCallback(async <T,>(path: string, options: Parameters<typeof api<T>>[1] = {}): Promise<T> => {
    try { await assertCurrent(); const result = await api<T>(path, options); await assertCurrent(); return result; }
    catch (problem) { if (problem instanceof ApiError && [401, 403].includes(problem.status)) setBlocked(problem.message); throw problem; }
  }, [assertCurrent]);
  const panelApi = useMemo<SkillReviewPanelApi>(() => {
    const rereadCandidate = async (target: SkillPublicationTarget): Promise<SkillReviewSnapshot> => {
      const snapshot = await request<SkillReviewSnapshot | null>(candidatePath(target));
      if (!snapshot) throw new Error("候选保存后无法读取对应固定版本，请刷新记录。");
      if (!sameTarget(snapshot, target)) throw new Error("服务器返回了不同的候选版本，请重新读取记录。");
      return snapshot;
    };
    return {
      listCandidates: () => request<readonly SkillCandidate[]>("/admin/skill-candidates"),
      listReviews: target => {
        const query = new URLSearchParams({ kind: target.kind, id: target.id, versionId: target.versionId, limit: "100" });
        return request<readonly SkillReviewPanelRecord[]>(`/admin/skill-reviews?${query}`);
      },
      getSnapshot: async target => {
        const snapshot = await request<SkillReviewSnapshot | null>(candidatePath(target));
        if (snapshot && !sameTarget(snapshot, target)) throw new Error("服务器返回了不同的候选版本，请重新读取记录。");
        return snapshot;
      },
      createCandidate: async input => {
        const saved = await request<SkillCandidate>("/admin/skill-candidates", { method: "POST", body: { expectedRevision: 0, document: input.document, evidence: input.evidence } });
        return rereadCandidate(saved);
      },
      updateCandidate: async input => {
        if (!sameTarget(documentTarget(input.document), input)) throw new Error("编辑不能更改候选身份或固定版本。请使用新增候选保存新版本；本地输入保留。");
        const saved = await request<SkillCandidate>("/admin/skill-candidates", { method: "POST", body: { expectedRevision: input.expectedRevision, document: input.document, evidence: input.evidence } });
        if (!sameTarget(saved, input)) throw new Error("保存结果对应不同候选身份，请重新读取并核对固定版本。");
        return rereadCandidate(saved);
      },
      registerReview: input => request<SkillReviewPanelRecord>(`${candidatePath(input)}/reviews`, { method: "POST", body: expectation(input) }),
      decideReview: input => request<SkillReviewPanelRecord>(`/admin/skill-reviews/${encodeURIComponent(input.reviewId)}/decide`, { method: "POST", body: { ...expectation(input), expectedRevision: input.expectedReviewRevision, decision: input.decision, reason: input.reason, ...(input.verification ? { verification: input.verification } : {}) } }),
      publishReview: input => request(`/admin/skill-reviews/${encodeURIComponent(input.reviewId)}/publish`, { method: "POST", body: { ...expectation(input), expectedRevision: input.expectedReviewRevision } }),
      withdraw: input => request(`${candidatePath(input)}/withdraw`, { method: "POST", body: { ...expectation(input), operationId: input.operationId, reason: input.reason } }),
    };
  }, [request]);
  if (blocked) return <Feedback error={blocked}/>;
  if (!permissions.data) return <><Feedback error={permissions.error}/>{permissions.loading && <Loading/>}</>;
  if (!canReview) return <Feedback error="当前账号没有技能审核权限。请使用有运营审核权限的账号。"/>;
  return <><Feedback error={permissions.error}/><SkillReviewPanel api={panelApi}/></>;
}
