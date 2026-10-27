import type { Actor, Clock, IdGenerator } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { FreshSessionGuard, PersonalAiPort } from "../../shared/personal-ai.ts";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import type { AvatarContent, CardSummaryPreview, OwnApplication, OwnCardState, PrivateRecruitingContext, PublicRecruitingCard, RecruitingApplication, RecruitingListFilter, RecruitingPage, RecruitingPost, RecruitingProfileView } from "./model.ts";
import type { RecruitingIdentityPort, RecruitingParticipantPort, RecruitingProjectsPort } from "./ports.ts";
import { recruitingSummaryRequest } from "./summary.ts";
import { verifyDecodedAvatar } from "./avatar.ts";
import { emptyProfile, id, invalid, object, revision, text, validateAvatar, validateCardDraft, validateFilter, validatePostData, validateProfileData } from "./validation.ts";
import { gapView, type GapCard, type GapView } from "./gap.ts";

interface ProfileRow { user_id: string; revision: number; data: ReturnType<typeof emptyProfile>; avatar_revision: number; avatar_mime: AvatarContent["mimeType"] | null; avatar_bytes: Uint8Array | null; updated_at: Date | string | null }
interface CardRow { id: string; user_id: string; revision: number; status: "published" | "withdrawn"; body: PublicRecruitingCard | null; avatar_mime: AvatarContent["mimeType"] | null; avatar_bytes: Uint8Array | null }
interface PostRow { id: string; project_id: string; publisher_user_id: string; revision: number; status: RecruitingPost["status"]; body: RecruitingPost }
interface ApplicationRow { id: string; post_id: string; project_id: string; applicant_user_id: string; revision: number; status: RecruitingApplication["status"]; request_id: string; body: RecruitingApplication }
export interface RecruitingDependencies { database: DatabasePort; identity: RecruitingIdentityPort; participant: RecruitingParticipantPort; projects: RecruitingProjectsPort; ai: PersonalAiPort; clock: Clock; ids: IdGenerator }
function conflict(latestRevision: number): never { throw new DomainError("RECRUITING_CHANGED", "资料已有更新，输入已保留，请重新读取后核对并保存。", { status: 409, latestRevision }); }
function missing(): never { throw new DomainError("RECRUITING_NOT_FOUND", "这条招募记录已不可用。", { status: 404 }); }
function deny(): never { throw new DomainError("RECRUITING_FORBIDDEN", "你现在没有这项操作的权限。", { status: 403 }); }
function iso(value: Date | string | null): string | null { return value === null ? null : new Date(value).toISOString(); }

export function createRecruitingService(deps: RecruitingDependencies) {
  const { database, identity, participant, projects, clock, ids, ai } = deps;
  const now = () => clock.now().toISOString();
  async function authorize(sql: SqlExecutor, actor: Actor, guard?: FreshSessionGuard) { const account = await identity.requireActive(sql, actor); await guard?.(sql); return account; }
  async function profileRow(sql: SqlExecutor, actor: Actor): Promise<ProfileRow> {
    await sql.query("INSERT INTO recruiting_profiles(user_id,data) VALUES($1,$2::jsonb) ON CONFLICT(user_id) DO NOTHING", [actor.userId, JSON.stringify(emptyProfile())]);
    return (await sql.query<ProfileRow>("SELECT * FROM recruiting_profiles WHERE user_id=$1 FOR UPDATE", [actor.userId])).rows[0];
  }
  async function cardRow(sql: SqlExecutor, userId: string) { return (await sql.query<CardRow>("SELECT * FROM recruiting_cards WHERE user_id=$1 FOR UPDATE", [userId])).rows[0]; }
  function ownCard(row: CardRow | undefined): OwnCardState { return { id: row?.id ?? null, revision: row?.revision ?? 0, status: row?.status ?? "private", card: row?.status === "published" ? row.body : null }; }
  async function view(sql: SqlExecutor, actor: Actor): Promise<RecruitingProfileView> {
    const account = await identity.requireActive(sql, actor), original = await participant.readOwn(sql, actor), row = await profileRow(sql, actor), card = await cardRow(sql, actor.userId);
    return { displayName: account.displayName, profile: { ...row.data, userId: actor.userId, revision: row.revision, updatedAt: iso(row.updated_at), avatarRevision: row.avatar_revision, hasAvatar: !!row.avatar_bytes }, participant: original, card: ownCard(card) };
  }
  async function history(sql: SqlExecutor, type: string, entityId: string, nextRevision: number, actor: Actor, action: string, body: unknown) {
    await sql.query("INSERT INTO recruiting_history(id,entity_type,entity_id,revision,actor_user_id,action,body,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::timestamptz)", [ids.next(), type, entityId, nextRevision, actor.userId, action, JSON.stringify(body), now()]);
  }
  async function project(sql: SqlExecutor, projectId: string, userId: string, manager: boolean, writing: boolean) {
    const state = await projects.inspect(sql, projectId, userId);
    if (!state || !state.membership || state.membership.status !== "active" || (manager && state.membership.role !== "manager")) deny();
    if (writing && state.archived) throw new DomainError("PROJECT_ARCHIVED", "空间已归档，不能修改招募或加入。", { status: 409 });
    return state;
  }
  async function publicPost(sql: SqlExecutor, row: PostRow): Promise<boolean> {
    if (row.status === "withdrawn" || !await identity.isActive(sql, row.publisher_user_id)) return false;
    const state = await projects.inspect(sql, row.project_id, row.publisher_user_id);
    return !!state && !state.archived && state.membership?.status === "active" && state.membership.role === "manager";
  }
  async function readPost(sql: SqlExecutor, postId: string, lock = true) { const row = (await sql.query<PostRow>(`SELECT * FROM recruiting_posts WHERE id=$1${lock ? " FOR UPDATE" : ""}`, [postId])).rows[0]; if (!row) missing(); return row; }
  async function readApplication(sql: SqlExecutor, applicationId: string, lock = true) { const row = (await sql.query<ApplicationRow>(`SELECT * FROM recruiting_applications WHERE id=$1${lock ? " FOR UPDATE" : ""}`, [applicationId])).rows[0]; if (!row) missing(); return row; }
  async function storeApplication(sql: SqlExecutor, application: RecruitingApplication, requestId: string, actor: Actor, action: string) {
    await sql.query("INSERT INTO recruiting_applications(id,post_id,project_id,applicant_user_id,revision,status,request_id,body,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::timestamptz) ON CONFLICT(post_id,applicant_user_id) DO UPDATE SET revision=excluded.revision,status=excluded.status,request_id=excluded.request_id,body=excluded.body,updated_at=excluded.updated_at", [application.id, application.postId, application.projectId, application.applicantUserId, application.revision, application.status, requestId, JSON.stringify(application), application.updatedAt]);
    await history(sql, "application", application.id, application.revision, actor, action, application);
    return application;
  }
  async function reservations(sql: SqlExecutor, postId: string) { return Number((await sql.query<{ count: string | number }>("SELECT count(*) AS count FROM recruiting_applications WHERE post_id=$1 AND status IN ('approved','joined')", [postId])).rows[0].count); }

  return {
    /** 招募帖还缺哪些声明的职责、谁的名片声明了这些职责：只读派生，不评分也不自动邀请。 */
    postGaps(actor: Actor, projectId: string, guard?: FreshSessionGuard): Promise<GapView> {
      return database.transaction(async sql => {
        await authorize(sql, actor, guard);
        await project(sql, projectId, actor.userId, true, false);
        const post = (await sql.query<PostRow>("SELECT * FROM recruiting_posts WHERE project_id=$1", [projectId])).rows[0];
        if (!post) missing();
        const applications = (await sql.query<ApplicationRow>("SELECT * FROM recruiting_applications WHERE post_id=$1 ORDER BY updated_at,id", [post.id])).rows.map(row => row.body);
        const cards = (await sql.query<CardRow>("SELECT * FROM recruiting_cards WHERE status='published' ORDER BY updated_at DESC, user_id LIMIT 200")).rows
          .map(row => ({ userId: row.user_id, card: row.body })).filter((entry): entry is GapCard => !!entry.card);
        const takenSeats = await reservations(sql, post.id);
        await guard?.(sql);
        return gapView({ post: post.body, publisherUserId: post.publisher_user_id, applications, cards, takenSeats });
      });
    },
    /** Pure read for personal assistant context; never creates a row and excludes optional sensitive attributes. */
    async readPrivateProfile(actor: Actor, guard?: FreshSessionGuard): Promise<PrivateRecruitingContext | null> {
      return database.transaction(async sql => { await authorize(sql, actor, guard); const row = (await sql.query<ProfileRow>("SELECT user_id,revision,data,updated_at FROM recruiting_profiles WHERE user_id=$1 FOR SHARE", [actor.userId])).rows[0]; await guard?.(sql); if (!row) return null;
        const { primaryRoles, supportingRoles, purposes, purposeNote, resume, workLinks } = row.data; return { userId: actor.userId, revision: row.revision, primaryRoles, supportingRoles, purposes, purposeNote, resume, workLinks, updatedAt: iso(row.updated_at) };
      });
    },
    async getProfile(actor: Actor, guard?: FreshSessionGuard): Promise<RecruitingProfileView> { return database.transaction(async sql => { await authorize(sql, actor, guard); const result = await view(sql, actor); await guard?.(sql); return result; }); },
    async saveProfile(actor: Actor, value: unknown, guard?: FreshSessionGuard): Promise<RecruitingProfileView> {
      const input = object(value, ["expectedRevision", "profile"]), expected = revision(input.expectedRevision), data = validateProfileData(input.profile);
      return database.transaction(async sql => { await authorize(sql, actor, guard); await participant.readOwn(sql, actor); const row = await profileRow(sql, actor); if (row.revision !== expected) conflict(row.revision);
        await sql.query("UPDATE recruiting_profiles SET revision=$2,data=$3::jsonb,updated_at=$4::timestamptz WHERE user_id=$1", [actor.userId, expected + 1, JSON.stringify(data), now()]);
        await history(sql, "profile", actor.userId, expected + 1, actor, "save_private_profile", data); const result = await view(sql, actor); await guard?.(sql); return result;
      });
    },
    async saveAvatar(actor: Actor, value: unknown, guard?: FreshSessionGuard): Promise<RecruitingProfileView> {
      const input = object(value, ["expectedRevision", "avatar"]), expected = revision(input.expectedRevision), avatar = await verifyDecodedAvatar(validateAvatar(input.avatar));
      return database.transaction(async sql => { await authorize(sql, actor, guard); await participant.readOwn(sql, actor); const row = await profileRow(sql, actor); if (row.avatar_revision !== expected) conflict(row.avatar_revision);
        await sql.query("UPDATE recruiting_profiles SET avatar_revision=$2,avatar_mime=$3,avatar_bytes=$4,updated_at=$5::timestamptz WHERE user_id=$1", [actor.userId, expected + 1, avatar.mimeType, avatar.bytes, now()]);
        await history(sql, "avatar", actor.userId, expected + 1, actor, "save_private_avatar", { mimeType: avatar.mimeType, byteLength: avatar.bytes.length }); const result = await view(sql, actor); await guard?.(sql); return result;
      });
    },
    async removeAvatar(actor: Actor, value: unknown, guard?: FreshSessionGuard): Promise<RecruitingProfileView> {
      const input = object(value, ["expectedRevision"]), expected = revision(input.expectedRevision);
      return database.transaction(async sql => { await authorize(sql, actor, guard); await participant.readOwn(sql, actor); const row = await profileRow(sql, actor); if (row.avatar_revision !== expected) conflict(row.avatar_revision);
        if (row.avatar_bytes) { await sql.query("UPDATE recruiting_profiles SET avatar_revision=$2,avatar_mime=NULL,avatar_bytes=NULL,updated_at=$3::timestamptz WHERE user_id=$1", [actor.userId, expected + 1, now()]); await history(sql, "avatar", actor.userId, expected + 1, actor, "remove_private_avatar", {}); }
        const result = await view(sql, actor); await guard?.(sql); return result;
      });
    },
    async getOwnAvatar(actor: Actor, guard?: FreshSessionGuard): Promise<AvatarContent> { return database.transaction(async sql => { await authorize(sql, actor, guard); const row = await profileRow(sql, actor); if (!row.avatar_bytes || !row.avatar_mime) missing(); await guard?.(sql); return { bytes: row.avatar_bytes, mimeType: row.avatar_mime }; }); },
    async generateSummary(actor: Actor, value: unknown, guard?: FreshSessionGuard): Promise<CardSummaryPreview> {
      const input = object(value, ["expectedRevision"]), expected = revision(input.expectedRevision);
      const before = await database.transaction(async sql => { await authorize(sql, actor, guard); const data = await view(sql, actor); if (data.profile.revision !== expected) conflict(data.profile.revision); return data; });
      const request = recruitingSummaryRequest(before.profile, before.participant), artifact = await ai.generate(actor, request, guard);
      if (artifact.provider !== "dsh" || artifact.kind !== "profile_summary") throw new DomainError("RECRUITING_AI_UNAVAILABLE", "尚未获得可用的DSH名片，请保留资料或手动编写。", { status: 503 });
      const draft = request.validate(artifact.data);
      return database.transaction(async sql => { await authorize(sql, actor, guard); const after = await view(sql, actor); if (after.profile.revision !== before.profile.revision || after.participant.revision !== before.participant.revision || after.profile.avatarRevision !== before.profile.avatarRevision) conflict(after.profile.revision);
        await guard?.(sql); return { id: artifact.id, provider: "dsh", createdAt: artifact.createdAt, profileRevision: before.profile.revision, participantRevision: before.participant.revision, avatarRevision: before.profile.avatarRevision, draft };
      });
    },
    async publishCard(actor: Actor, value: unknown, guard?: FreshSessionGuard): Promise<OwnCardState> {
      const input = object(value, ["expectedRevision", "profileRevision", "participantRevision", "avatarRevision", "draft", "confirmed"]), expected = revision(input.expectedRevision), profileRevision = revision(input.profileRevision), participantRevision = revision(input.participantRevision), avatarRevision = revision(input.avatarRevision), draft = validateCardDraft(input.draft); if (input.confirmed !== true) invalid("请预览名片并明确确认公开发布。");
      return database.transaction(async sql => { const account = await authorize(sql, actor, guard), original = await participant.readOwn(sql, actor), profile = await profileRow(sql, actor), stored = await cardRow(sql, actor.userId);
        if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(account.displayName)) invalid("你的账户昵称含邮箱，请先修改账户昵称，再预览发布名片。");
        if ((stored?.revision ?? 0) !== expected) conflict(stored?.revision ?? 0); if (profile.revision !== profileRevision || original.revision !== participantRevision || profile.avatar_revision !== avatarRevision) conflict(profile.revision);
        const cardId = stored?.id ?? ids.next(), nextRevision = expected + 1, at = now(), includeAvatar = draft.showAvatar && !!profile.avatar_bytes;
        const { showAge, showMbti, showAvatar: _showAvatar, ...content } = draft;
        const card: PublicRecruitingCard = { ...content, id: cardId, displayName: account.displayName, revision: nextRevision, publishedAt: at, age: showAge ? profile.data.age : null, mbti: showMbti ? profile.data.mbti || null : null, avatarUrl: includeAvatar ? `/api/v1/recruiting/cards/${encodeURIComponent(cardId)}/avatar?revision=${nextRevision}` : null };
        await sql.query("INSERT INTO recruiting_cards(id,user_id,revision,status,body,avatar_mime,avatar_bytes,updated_at) VALUES($1,$2,$3,'published',$4::jsonb,$5,$6,$7::timestamptz) ON CONFLICT(user_id) DO UPDATE SET revision=excluded.revision,status='published',body=excluded.body,avatar_mime=excluded.avatar_mime,avatar_bytes=excluded.avatar_bytes,updated_at=excluded.updated_at", [cardId, actor.userId, nextRevision, JSON.stringify(card), includeAvatar ? profile.avatar_mime : null, includeAvatar ? profile.avatar_bytes : null, at]);
        await history(sql, "card", cardId, nextRevision, actor, "publish_card", { card, source: { profileRevision, participantRevision, avatarRevision } }); await guard?.(sql); return { id: cardId, revision: nextRevision, status: "published", card };
      });
    },
    async withdrawCard(actor: Actor, value: unknown, guard?: FreshSessionGuard): Promise<OwnCardState> {
      const input = object(value, ["expectedRevision"]), expected = revision(input.expectedRevision);
      return database.transaction(async sql => { await authorize(sql, actor, guard); await profileRow(sql, actor); const stored = await cardRow(sql, actor.userId); if ((stored?.revision ?? 0) !== expected) conflict(stored?.revision ?? 0); if (!stored || stored.status === "withdrawn") { await guard?.(sql); return ownCard(stored); }
        await sql.query("UPDATE recruiting_cards SET revision=$2,status='withdrawn',body=NULL,avatar_mime=NULL,avatar_bytes=NULL,updated_at=$3::timestamptz WHERE id=$1", [stored.id, expected + 1, now()]); await history(sql, "card", stored.id, expected + 1, actor, "withdraw_card", {}); await guard?.(sql); return { id: stored.id, revision: expected + 1, status: "withdrawn", card: null };
      });
    },
    async getPublicAvatar(cardId: string, expectedRevision?: number): Promise<AvatarContent> {
      id(cardId); if (expectedRevision !== undefined) revision(expectedRevision);
      return database.transaction(async sql => { const meta = (await sql.query<CardRow>("SELECT * FROM recruiting_cards WHERE id=$1", [cardId])).rows[0]; if (!meta || !await identity.isActive(sql, meta.user_id)) missing(); const row = (await sql.query<CardRow>("SELECT * FROM recruiting_cards WHERE id=$1 FOR SHARE", [cardId])).rows[0]; if (!row || row.status !== "published" || !row.avatar_bytes || !row.avatar_mime || (expectedRevision !== undefined && expectedRevision !== row.revision)) missing(); return { bytes: row.avatar_bytes, mimeType: row.avatar_mime }; });
    },
    async listCards(filter: RecruitingListFilter = {}): Promise<RecruitingPage<PublicRecruitingCard>> {
      const f = validateFilter(filter);
      return database.transaction(async sql => { const rows = (await sql.query<CardRow>("SELECT * FROM recruiting_cards WHERE status='published' AND ($1::text IS NULL OR id>$1) AND ($2::text IS NULL OR body->'primaryRoles' ? $2 OR body->'supportingRoles' ? $2) AND ($3::text IS NULL OR body->'purposes' ? $3) AND ($4::text='' OR position(lower($4) in lower(concat_ws(' ',body->>'displayName',body->>'headline',body->>'introduction',body->>'purposeNote',body->>'city',body->>'skills',body->>'workLinks')))>0) ORDER BY id LIMIT $5", [f.cursor ?? null, f.role ?? null, f.purpose ?? null, f.keyword, f.limit + 1])).rows;
        const scanned = rows.slice(0, f.limit), items: PublicRecruitingCard[] = []; for (const row of scanned) if (row.body && await identity.isActive(sql, row.user_id)) { const current = (await sql.query<CardRow>("SELECT * FROM recruiting_cards WHERE id=$1 AND status='published' AND revision=$2 FOR SHARE", [row.id, row.revision])).rows[0]; if (current?.body) items.push(current.body); }
        return { items, nextCursor: rows.length > f.limit ? scanned.at(-1)!.id : null };
      });
    },
    /**
     * 规划34 D1：按账号批量取**已发布且账号活跃**的公开名片投影，用于赛事内参赛名录。
     * 复用与 `listCards` 完全相同的公开口径（status='published' + identity.isActive + 当前 revision FOR SHARE）；
     * 只返回公开字段，不含邮箱、私人资料与头像字节。
     */
    async publishedCardsForUsers(sql: SqlExecutor, userIds: readonly string[]): Promise<{ userId: string; card: PublicRecruitingCard }[]> {
      const wanted = [...new Set(userIds)].filter(value => typeof value === "string" && value.length > 0 && value.length <= 200).slice(0, 200);
      if (!wanted.length) return [];
      const rows = (await sql.query<CardRow>("SELECT * FROM recruiting_cards WHERE status='published' AND user_id = ANY($1::text[])", [wanted])).rows;
      const output: { userId: string; card: PublicRecruitingCard }[] = [];
      for (const row of rows) {
        if (!row.body || !await identity.isActive(sql, row.user_id)) continue;
        const current = (await sql.query<CardRow>("SELECT * FROM recruiting_cards WHERE id=$1 AND status='published' AND revision=$2 FOR SHARE", [row.id, row.revision])).rows[0];
        if (current?.body) output.push({ userId: row.user_id, card: current.body });
      }
      return output.sort((left, right) => left.userId < right.userId ? -1 : left.userId > right.userId ? 1 : 0);
    },
    async getPost(actor: Actor, projectId: string, guard?: FreshSessionGuard): Promise<RecruitingPost | null> {
      id(projectId); return database.transaction(async sql => { await authorize(sql, actor, guard); await project(sql, projectId, actor.userId, true, false); const row = (await sql.query<PostRow>("SELECT * FROM recruiting_posts WHERE project_id=$1", [projectId])).rows[0]; await guard?.(sql); return row?.body ?? null; });
    },
    async savePost(actor: Actor, projectId: string, value: unknown, guard?: FreshSessionGuard): Promise<RecruitingPost> {
      id(projectId); const input = object(value, ["expectedRevision", "post"]), expected = revision(input.expectedRevision), data = validatePostData(input.post);
      return database.transaction(async sql => { await authorize(sql, actor, guard); await project(sql, projectId, actor.userId, true, true); const row = (await sql.query<PostRow>("SELECT * FROM recruiting_posts WHERE project_id=$1 FOR UPDATE", [projectId])).rows[0]; if ((row?.revision ?? 0) !== expected) conflict(row?.revision ?? 0);
        if (row && data.seats < await reservations(sql, row.id)) throw new DomainError("RECRUITING_SEATS_RESERVED", "已有批准或加入的申请，请先处理申请再减少招募人数。", { status: 409 });
        const at = now(), post: RecruitingPost = { ...data, id: row?.id ?? ids.next(), projectId, revision: expected + 1, publishedAt: row?.body.publishedAt ?? at, updatedAt: at };
        await sql.query("INSERT INTO recruiting_posts(id,project_id,publisher_user_id,revision,status,body,updated_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::timestamptz) ON CONFLICT(project_id) DO UPDATE SET publisher_user_id=excluded.publisher_user_id,revision=excluded.revision,status=excluded.status,body=excluded.body,updated_at=excluded.updated_at", [post.id, projectId, actor.userId, post.revision, post.status, JSON.stringify(post), at]);
        await history(sql, "post", post.id, post.revision, actor, `post_${post.status}`, post); await guard?.(sql); return post;
      });
    },
    async listPosts(filter: RecruitingListFilter = {}): Promise<RecruitingPage<RecruitingPost>> {
      const f = validateFilter(filter); return database.transaction(async sql => { const rows = (await sql.query<PostRow>("SELECT * FROM recruiting_posts WHERE status IN ('open','closed') AND ($1::text IS NULL OR id>$1) AND ($2::text IS NULL OR body->'neededRoles' ? $2) AND ($3::text IS NULL OR body->'purposes' ? $3) AND ($4::text='' OR position(lower($4) in lower(concat_ws(' ',body->>'spaceName',body->>'title',body->>'description')))>0) ORDER BY id LIMIT $5", [f.cursor ?? null, f.role ?? null, f.purpose ?? null, f.keyword, f.limit + 1])).rows;
        const scanned = rows.slice(0, f.limit), visible = new Map<string, RecruitingPost>();
        for (const row of [...scanned].sort((a,b) => a.project_id.localeCompare(b.project_id))) if (await publicPost(sql, row)) { const current = (await sql.query<PostRow>("SELECT * FROM recruiting_posts WHERE id=$1 AND revision=$2 AND status IN ('open','closed') FOR SHARE", [row.id, row.revision])).rows[0]; if (current) visible.set(row.id, current.body); }
        return { items: scanned.flatMap(row => visible.has(row.id) ? [visible.get(row.id)!] : []), nextCursor: rows.length > f.limit ? scanned.at(-1)!.id : null };
      });
    },
    async apply(actor: Actor, postId: string, value: unknown, guard?: FreshSessionGuard): Promise<RecruitingApplication> {
      id(postId); const input = object(value, ["expectedPostRevision", "expectedRevision", "requestId", "message", "shareCard"]), expectedPost = revision(input.expectedPostRevision), expected = revision(input.expectedRevision), requestId = id(input.requestId), message = text(input.message, 2000, true); if (typeof input.shareCard !== "boolean") invalid();
      return database.transaction(async sql => { const account = await authorize(sql, actor, guard), meta = await readPost(sql, postId, false); const applicant = await projects.inspect(sql, meta.project_id, actor.userId); const post = await readPost(sql, postId); const existing = (await sql.query<ApplicationRow>("SELECT * FROM recruiting_applications WHERE post_id=$1 AND applicant_user_id=$2 FOR UPDATE", [postId, actor.userId])).rows[0];
        if (existing?.request_id === requestId) { if (existing.body.message !== message || !!existing.body.cardSnapshot !== input.shareCard) throw new DomainError("RECRUITING_REQUEST_REUSED", "这次操作标识已用于其他内容，请核对已保存申请。", { status: 409 }); await guard?.(sql); return existing.body; }
        if (!await publicPost(sql, post) || post.status !== "open") throw new DomainError("RECRUITING_POST_CLOSED", "这条招募已停止接受申请。", { status: 409 }); if (post.revision !== expectedPost) conflict(post.revision);
        if (applicant?.membership?.status === "active") throw new DomainError("ALREADY_PROJECT_MEMBER", "你已是这个空间的成员，可以直接进入空间。", { status: 409 });
        if ((existing?.revision ?? 0) !== expected) conflict(existing?.revision ?? 0); if (existing && !["withdrawn", "rejected"].includes(existing.status)) throw new DomainError("RECRUITING_APPLICATION_EXISTS", "已有申请，请查看当前审核状态。", { status: 409 });
        let cardSnapshot: PublicRecruitingCard | null = null; if (input.shareCard) { const own = await cardRow(sql, actor.userId); if (!own || own.status !== "published" || !own.body) invalid("尚未发布名片，可取消附带名片后提交申请。"); cardSnapshot = own.body; }
        const at = now(), application: RecruitingApplication = { id: existing?.id ?? ids.next(), postId, projectId: post.project_id, applicantUserId: actor.userId, applicantDisplayName: account.displayName, message, cardSnapshot, status: "pending", revision: expected + 1, reviewNote: "", reviewedBy: null, reviewedAt: null, membershipId: null, createdAt: existing?.body.createdAt ?? at, updatedAt: at };
        await storeApplication(sql, application, requestId, actor, "apply"); await guard?.(sql); return application;
      });
    },
    async listOwnApplications(actor: Actor, guard?: FreshSessionGuard): Promise<OwnApplication[]> {
      return database.transaction(async sql => { await authorize(sql, actor, guard); const rows = (await sql.query<ApplicationRow>("SELECT * FROM recruiting_applications WHERE applicant_user_id=$1 ORDER BY updated_at DESC LIMIT 100", [actor.userId])).rows, byId = new Map<string, OwnApplication>();
        for (const meta of [...rows].sort((a,b) => a.project_id.localeCompare(b.project_id))) { await projects.inspect(sql, meta.project_id, actor.userId); const post = await readPost(sql, meta.post_id), row = await readApplication(sql, meta.id), available = await publicPost(sql, post); let canJoin = available && post.status === "open" && row.status === "approved" && !!row.body.reviewedBy;
          if (canJoin) { const approval = await projects.inspect(sql, row.project_id, row.body.reviewedBy!); canJoin = !!approval && !approval.archived && approval.membership?.status === "active" && approval.membership.role === "manager" && await identity.isActive(sql, row.body.reviewedBy!); }
          byId.set(row.id, { ...row.body, post: available ? post.body : null, canJoin });
        } await guard?.(sql); return rows.map(row => byId.get(row.id)!);
      });
    },
    async listProjectApplications(actor: Actor, projectId: string, guard?: FreshSessionGuard): Promise<RecruitingApplication[]> {
      id(projectId); return database.transaction(async sql => { await authorize(sql, actor, guard); await project(sql, projectId, actor.userId, true, false); const rows = (await sql.query<ApplicationRow>("SELECT * FROM recruiting_applications WHERE project_id=$1 ORDER BY updated_at DESC LIMIT 100", [projectId])).rows; await guard?.(sql); return rows.map(row => row.body); });
    },
    async reviewApplication(actor: Actor, applicationId: string, value: unknown, guard?: FreshSessionGuard): Promise<RecruitingApplication> {
      id(applicationId); const input = object(value, ["expectedRevision", "decision", "note"]), expected = revision(input.expectedRevision), note = text(input.note, 1000); if (input.decision !== "approve" && input.decision !== "reject") invalid(); const decision = input.decision;
      return database.transaction(async sql => { await authorize(sql, actor, guard); const meta = await readApplication(sql, applicationId, false); await project(sql, meta.project_id, actor.userId, true, true); const post = await readPost(sql, meta.post_id), row = await readApplication(sql, applicationId); if (row.revision !== expected) conflict(row.revision);
        if (!["pending", "approved", "rejected"].includes(row.status)) throw new DomainError("RECRUITING_APPLICATION_FINAL", "这条申请已撤回或已加入，不能重新审核。", { status: 409 });
        if (!await identity.isActive(sql, row.applicant_user_id)) deny(); if (input.decision === "approve" && (post.status !== "open" || !await publicPost(sql, post))) throw new DomainError("RECRUITING_POST_CLOSED", "请先公开招募，再批准申请。", { status: 409 });
        if (input.decision === "approve" && row.status !== "approved" && await reservations(sql, post.id) >= post.body.seats) throw new DomainError("RECRUITING_SEATS_FULL", "招募名额已被批准或已加入的申请占用。", { status: 409 });
        const at = now(), next: RecruitingApplication = { ...row.body, revision: row.revision + 1, status: decision === "approve" ? "approved" : "rejected", reviewNote: note, reviewedBy: actor.userId, reviewedAt: at, updatedAt: at }; await storeApplication(sql, next, row.request_id, actor, decision); await guard?.(sql); return next;
      });
    },
    async withdrawApplication(actor: Actor, applicationId: string, value: unknown, guard?: FreshSessionGuard): Promise<RecruitingApplication> {
      id(applicationId); const input = object(value, ["expectedRevision"]), expected = revision(input.expectedRevision);
      return database.transaction(async sql => { await authorize(sql, actor, guard); const meta = await readApplication(sql, applicationId, false); if (meta.applicant_user_id !== actor.userId) deny(); await projects.inspect(sql, meta.project_id, actor.userId); await readPost(sql, meta.post_id); const row = await readApplication(sql, applicationId); if (row.revision !== expected) conflict(row.revision); if (row.status === "joined") throw new DomainError("RECRUITING_ALREADY_JOINED", "你已加入空间，退出请使用成员管理。", { status: 409 }); if (row.status === "withdrawn") { await guard?.(sql); return row.body; }
        const next: RecruitingApplication = { ...row.body, revision: row.revision + 1, status: "withdrawn", updatedAt: now() }; await storeApplication(sql, next, row.request_id, actor, "withdraw_application"); await guard?.(sql); return next;
      });
    },
    async joinApproved(actor: Actor, applicationId: string, value: unknown, guard?: FreshSessionGuard): Promise<RecruitingApplication> {
      id(applicationId); const input = object(value, ["expectedRevision", "confirmed"]), expected = revision(input.expectedRevision); if (input.confirmed !== true) invalid("请明确确认加入团队空间。");
      return database.transaction(async sql => { await authorize(sql, actor, guard); const meta = await readApplication(sql, applicationId, false); if (meta.applicant_user_id !== actor.userId) deny(); const applicant = await projects.inspect(sql, meta.project_id, actor.userId);
        if (meta.status !== "joined" && meta.body.reviewedBy) { await identity.requireActive(sql, { userId: meta.body.reviewedBy, platformRoles: [] }); await project(sql, meta.project_id, meta.body.reviewedBy, true, true); }
        const post = await readPost(sql, meta.post_id), row = await readApplication(sql, applicationId);
        if (row.status === "joined") { if (!applicant || applicant.archived || applicant.membership?.status !== "active" || applicant.membership.membershipId !== row.body.membershipId) throw new DomainError("RECRUITING_MEMBERSHIP_CHANGED", "当前成员状态已改变，这条已使用申请不会重新加入，请联系管理员。", { status: 409 }); if (expected !== row.revision && expected !== row.revision - 1) conflict(row.revision); await guard?.(sql); return row.body; }
        if (row.revision !== expected) conflict(row.revision); if (row.status !== "approved" || !row.body.reviewedBy) throw new DomainError("RECRUITING_APPROVAL_REQUIRED", "请等待管理员批准后再明确加入。", { status: 409 }); if (post.status !== "open" || !await publicPost(sql, post)) throw new DomainError("RECRUITING_POST_CLOSED", "这条招募已暂停或空间不可加入，请联系管理员。", { status: 409 });
        const membership = await projects.joinApproved(sql, { actor, projectId: row.project_id, approvedBy: row.body.reviewedBy, applicationId }); if (membership.role !== "member" || membership.status !== "active" || !membership.membershipId) throw new DomainError("RECRUITING_JOIN_FAILED", "尚未确认加入结果，请重新读取申请。", { status: 503 });
        const next: RecruitingApplication = { ...row.body, revision: row.revision + 1, status: "joined", membershipId: membership.membershipId, updatedAt: now() }; await storeApplication(sql, next, row.request_id, actor, "join_space"); await guard?.(sql); return next;
      });
    },
  };
}
export type RecruitingService = ReturnType<typeof createRecruitingService>;
