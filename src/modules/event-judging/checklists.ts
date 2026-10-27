import type { IntakeReceipt, PublishedResults } from "./model.ts";

/**
 * 赛前自检与赛后只读复用清单（都是**只读派生**，不建立第二套完成状态或打勾记录）。
 *
 * 依据：竞品一边把"提交前/赛前检查"做成派生提示（HackerTrip 的字段级自检），一边把"作品与素材"
 * 做成发布到个人主页的第二套事实（publish-work）。我们只吸收前者：**能看、能对、能复制**，
 * 不新增任何状态、不打勾、不导出他人的材料，也不替队伍判断许可与署名。
 */

export interface ChecklistItem { id: string; label: string; state: "done" | "todo" | "info"; detail: string }
export interface PreEventChecklist { items: readonly ChecklistItem[]; ready: number; total: number; notice: string; limitations: readonly string[] }

const minDescription = 40;

/** 赛前自检：只看本人队伍已有的事实（报名、队伍、正式交件、材料、截止、公布状态）。 */
export function preEventReadiness(input: { registration: { status: string } | null; memberUserIds: readonly string[]; receipts: readonly IntakeReceipt[]; published: PublishedResults | null; now: string }): PreEventChecklist {
  const { registration, memberUserIds, receipts, published } = input;
  const latest = [...receipts].sort((left, right) => right.version - left.version)[0] ?? null;
  const items: ChecklistItem[] = [];
  const approved = registration?.status === "approved";
  items.push({ id: "registration", label: "本场报名已通过", state: approved ? "done" : "todo",
    detail: approved ? "报名状态为已通过，可以继续组队与交件。" : `当前报名状态：${registration?.status ?? "尚未报名"}。请先完成报名并通过审核。` });
  items.push({ id: "team", label: "队伍已建立", state: memberUserIds.length ? "done" : "todo",
    detail: memberUserIds.length ? `当前队伍有 ${memberUserIds.length} 位成员。` : "还没有队伍成员记录；邀请队友后这里会显示人数。" });
  items.push({ id: "team_size", label: "人数符合本场公开规则", state: "info",
    detail: "本站不替你判断最少/最多人数，请按主办方公开规则确认；确认后再决定是否继续邀请。" });
  items.push({ id: "receipt", label: "已经正式交件", state: latest ? "done" : "todo",
    detail: latest ? `最新一版是第 ${latest.version} 版（回执 ${latest.receiptNumber}）。` : "还没有正式交件；填写材料后先预览再确认提交。" });
  const materialsReady = !!latest && latest.materials.links.length > 0 && latest.materials.description.trim().length >= minDescription;
  items.push({ id: "materials", label: "材料齐备（可访问链接与足够说明）", state: latest ? (materialsReady ? "done" : "todo") : "todo",
    detail: !latest ? "交件后会自动核对：是否有可访问链接、说明是否达到 40 字。" :
      materialsReady ? `已包含 ${latest.materials.links.length} 条链接与 ${latest.materials.files.length} 份文件元数据。` :
        `${latest.materials.links.length ? "" : "缺少可访问的作品链接。"}${latest.materials.description.trim().length < minDescription ? `作品说明只有 ${latest.materials.description.trim().length} 字，建议写到 40 字以上。` : ""}` });
  const deadline = latest?.submissionClosesAt ?? null;
  const open = deadline ? Date.parse(input.now) < Date.parse(deadline) : null;
  items.push({ id: "deadline", label: "提交截止前完成", state: open === null ? "info" : open ? "done" : "todo",
    detail: deadline ? (open ? `作品提交截止 ${deadline}，当前仍可提交。` : `作品提交截止 ${deadline} 已过；如需补交请联系主办方，历史版本保留。`) : "第一次交件时会显示本场的作品提交截止时间。" });
  items.push({ id: "published", label: "结果公布状态", state: "info",
    detail: published ? `已公布第 ${published.version} 版结果，可在结果页查看反馈；如有异议可在申诉时限内提交申诉。` : "结果尚未公布；公布后本清单会追加只读的复用清单。" });

  const ready = items.filter(item => item.state === "done").length;
  const total = items.filter(item => item.state !== "info").length;
  return { items, ready, total,
    notice: `共 ${total} 项可核对，其中 ${ready} 项已完成。这里只是把已有事实列出来，不会自动打勾或改变任何状态。`,
    limitations: ["不建立第二套完成状态：这里不写入任何打勾记录，刷新后按当时事实重新计算。", "不替主办方判断资格与人数规则；以公开规则为准。", "不对作品质量、完成度或获奖可能做任何评价。"] };
}

export interface ReuseEntry { kind: "receipt" | "rules" | "link" | "file" | "feedback"; label: string; detail: string; url: string | null }
export interface PostEventReuse { published: boolean; version: number | null; entries: readonly ReuseEntry[]; notice: string; limitations: readonly string[] }

/** 赛后只读复用清单：只列**本队自己的**材料、反馈与规则版本，供之后复盘或复用。 */
export function postEventReuse(input: { receipts: readonly IntakeReceipt[]; published: PublishedResults | null }): PostEventReuse {
  const latest = [...input.receipts].sort((left, right) => right.version - left.version)[0] ?? null;
  if (!latest) return { published: false, version: null, entries: [],
    notice: "还没有正式交件，因此没有可复用的材料清单。",
    limitations: ["只列出你们自己的材料；不包含其他队伍内容。", "复用他人素材前请自行确认许可与署名要求，本站不代你判断。"] };
  const entries: ReuseEntry[] = [
    { kind: "receipt", label: `第 ${latest.version} 版正式收件`, detail: `回执号 ${latest.receiptNumber} · 提交于 ${latest.submittedAt}`, url: null },
    { kind: "rules", label: `适用正式规则 v${latest.ruleVersion}`, detail: `收件时的赛事版本 v${latest.eventRevision} · 队伍版本 v${latest.teamRevision}`, url: null },
  ];
  for (const link of latest.materials.links) entries.push({ kind: "link", label: link.label || "作品链接", detail: "交件时冻结的链接", url: link.url });
  for (const file of latest.materials.files) entries.push({ kind: "file", label: file.name, detail: `${file.mediaType} · ${file.sizeBytes} 字节 · SHA-256 ${file.sha256.slice(0, 12)}…`, url: file.url });
  const row = input.published?.rows.find(item => item.snapshotId === latest.id) ?? null;
  const feedback = input.published?.approvedFeedback.find(item => item.snapshotId === latest.id && (item.visibility === "public" || item.visibility === "team")) ?? null;
  if (feedback?.text) entries.push({ kind: "feedback", label: "负责人批准的反馈", detail: feedback.text, url: null });
  return { published: !!input.published, version: input.published?.version ?? null, entries,
    notice: input.published
      ? `已公布第 ${input.published.version} 版结果；下面 ${entries.length} 条都是你们自己这版材料与反馈的只读摘录${row ? `（本队名次：${row.rank === null ? "未进入排名" : `第 ${row.rank} 名`}）` : ""}。`
      : `结果尚未公布；下面 ${entries.length} 条来自你们最新一版正式收件。`,
    limitations: ["只列出你们自己的材料与反馈；不包含其他队伍内容。", "复用他人素材前请自行确认许可与署名要求，本站不代你判断。", "结果被更正后，本清单会随最新公布版本变化；历史版本仍在回执记录里。"] };
}
