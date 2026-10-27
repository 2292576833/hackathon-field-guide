"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { api, message as errorMessage } from "./client-api.ts";
import styles from "./ai-workbench.module.css";
import { SpecialistAvatar } from "./specialist-avatar.tsx";

interface Account { readonly id: string; readonly displayName: string; readonly email: string }

/**
 * AI 工作台：整页对话界面（左侧网站入口 + AI 工作情况，中间对话）。
 *
 * 对话走既有导航员通道（/navigator/conversation 与 /navigator/messages），
 * 记录本来就持久化在个人会话里，刷新不丢。
 *
 * 「多个 AI 互相讨论」是编排而不是模型互调：由代码依次调用不同助手，
 * 界面把每条发言当作一条消息展示。本版先接导航员；专员讨论是下一步。
 */
interface Message {
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly speaker?: string;
  /** 专员回复附带结构化清单（一条一条的建议），供折叠展示。 */
  readonly items?: readonly string[];
  /** 这次读了什么、缺什么；只展示，不参与回答。 */
  readonly notes?: readonly string[];
  /** 发言专员的 key，用来画头像。 */
  readonly avatarKey?: string;
  /** 命中框架卡时给出的提醒；空表示没有发现偏离。 */
  readonly drift?: string;
}
interface ThreadSummary { readonly id: string; readonly title: string; readonly createdAt: string; readonly size: number }
interface ThreadDetail { readonly id: string; readonly title: string; readonly messages: readonly Message[] }
interface Reply { readonly reply: string; readonly action?: { readonly kind: string; readonly title: string; readonly dueAt?: string; readonly charter?: { readonly goal: string; readonly deliverables: readonly string[]; readonly nonGoals: readonly string[]; readonly timebox: string } }; readonly links: readonly { readonly title: string; readonly href: string }[] }
interface Specialist { readonly key: string; readonly label: string; readonly audience: "staff" | "participant"; readonly reads: string; readonly available?: boolean }
interface MyEvent { readonly eventId: string; readonly title: string; readonly registrationStatus: string }
interface SpaceProject { readonly id: string; readonly name: string }
interface Charter { readonly version: number; readonly goal: string; readonly deliverables: readonly string[]; readonly acceptance: string; readonly nonGoals: readonly string[]; readonly timebox: string; readonly locked: boolean }
interface AssistantOutput { readonly title?: string; readonly body?: string; readonly items?: readonly { readonly text: string }[]; readonly notes?: readonly string[] }

/**
 * 防跑偏检测：纯规则，不调模型、不花钱。先看是否撞上「明确不做」，再看是否与框架卡任何主题都不沾边。
 * 只做提醒，不拦截。
 */
function driftOf(text: string, charter: Charter | null): string {
  if (charter === null) return "";
  const body = text.trim();
  if (body.length < 8) return "";
  const nonGoal = charter.nonGoals.find(word => word.length >= 2 && body.includes(word));
  if (nonGoal !== undefined) return "这轮碰到了框架卡里的「明确不做」：" + nonGoal;
  const topics = [charter.goal, ...charter.deliverables, ...charter.nonGoals, charter.timebox].join(" ")
    .split(/[\s，。；、,.;:：()（）\[\]【】/|]+/).map(word => word.trim()).filter(word => word.length >= 2);
  if (topics.length === 0) return "";
  return topics.some(word => body.includes(word)) ? "" : "这轮话题在框架卡里没有对应项，可能偏离主线。";
}

/** 选手最常问的几件事：点一下就把问题写好，不用自己想措辞。 */
const QUICK_PROMPTS: readonly { readonly label: string; readonly prompt: string; readonly specialist?: string }[] = [
  { label: "报名还差什么", prompt: "我的报名还差什么？", specialist: "enroll" },
  { label: "报名表怎么填", prompt: "报名表每一栏该怎么填？", specialist: "enroll" },
  { label: "队伍还缺谁", prompt: "我的队伍还缺哪些角色？", specialist: "teamup" },
  { label: "怎么找队友", prompt: "我该怎么在组队大厅找人？", specialist: "teamup" },
  { label: "材料交齐了吗", prompt: "我的提交材料齐了吗？", specialist: "submit" },
  { label: "结果什么时候出", prompt: "结果什么时候公布？", specialist: "results" },
  { label: "不满结果怎么申诉", prompt: "我对结果有异议，该怎么申诉？", specialist: "results" },
  { label: "赛后怎么复盘", prompt: "帮我复盘这次参赛。", specialist: "retro" },
];

const ENTRIES: readonly { readonly href: string; readonly label: string; readonly group: string }[] = [
  { href: "/competitions", label: "找比赛", group: "参与" },
  { href: "/me/competitions", label: "我的参赛", group: "参与" },
  { href: "/app", label: "我的工作台", group: "参与" },
  { href: "/app/teams", label: "我的团队", group: "参与" },
  { href: "/recruiting", label: "找队友", group: "参与" },
  { href: "/journey", label: "参赛路线图", group: "参与" },
  { href: "/organizers/workspace", label: "我的比赛", group: "主办" },
  { href: "/organizers", label: "主办方入驻", group: "主办" },
  { href: "/resources", label: "工具与资料", group: "平台" },
  { href: "/library", label: "新人指南", group: "平台" },
];

export function AiWorkbench() {
  const [messages, setMessages] = useState<readonly Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [links, setLinks] = useState<readonly { title: string; href: string }[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [threads, setThreads] = useState<readonly ThreadSummary[]>([]);
  const [viewing, setViewing] = useState<ThreadDetail | null>(null);
  const [specialists, setSpecialists] = useState<readonly Specialist[]>([]);
  const [mention, setMention] = useState<Specialist | null>(null);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [events, setEvents] = useState<readonly MyEvent[]>([]);
  const [eventId, setEventId] = useState("");
  const [account, setAccount] = useState<Account | null>(null);
  const [projects, setProjects] = useState<readonly SpaceProject[]>([]);
  const [space, setSpace] = useState<SpaceProject | null>(null);
  const [spaceRevision, setSpaceRevision] = useState(0);
  const [spaceMessages, setSpaceMessages] = useState<readonly Message[]>([]);
  const [spaceConfigured, setSpaceConfigured] = useState(true);
  const [charter, setCharter] = useState<Charter | null>(null);
  const [draft, setDraft] = useState({ open: false, goal: "", deliverables: "", nonGoals: "", timebox: "" });
  const bottom = useRef<HTMLDivElement | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api<{ messages?: readonly Message[] }>("/navigator/conversation");
      setMessages(Array.isArray(data.messages) ? data.messages : []);
      const list = await api<{ threads?: readonly ThreadSummary[] }>("/ai/threads").catch(() => ({ threads: [] as readonly ThreadSummary[] }));
      setThreads(Array.isArray(list.threads) ? list.threads : []);
    } catch (problem) {
      const text = errorMessage(problem);
      setError(/401|登录|会话/.test(text) ? "登录后才能和 AI 助手对话。请先登录，再回到这里。" : text);
    } finally { setLoaded(true); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    void (async () => {
      const sp = await api<{ specialists?: readonly Specialist[] }>("/ai/specialists").catch(() => ({ specialists: [] as readonly Specialist[] }));
      setSpecialists(Array.isArray(sp.specialists) ? sp.specialists : []);
      const mine = await api<{ items?: readonly MyEvent[] }>("/me/competitions").catch(() => ({ items: [] as readonly MyEvent[] }));
      const list = Array.isArray(mine.items) ? mine.items : [];
      setEvents(list);
      setEventId(list.find(item => item.registrationStatus === "approved")?.eventId ?? list[0]?.eventId ?? "");
      const spaceList = await api<{ items?: readonly SpaceProject[] }>("/projects").catch(() => ({ items: [] as readonly SpaceProject[] }));
      setProjects(Array.isArray(spaceList.items) ? spaceList.items.slice(0, 8) : []);
      const me = await api<{ profile?: Account }>("/me").catch(() => ({ profile: undefined }));
      setAccount(me.profile && typeof me.profile.displayName === "string" ? me.profile : null);
    })();
  }, []);
  useEffect(() => { bottom.current?.scrollIntoView({ block: "end" }); }, [messages, busy]);
  // 铺满视口：高度取「视口高 − 卡片实际顶边」，避免页头高度变化时上下留白。
  useEffect(() => {
    const element = shellRef.current;
    if (element === null) return;
    const fit = () => {
      const top = element.getBoundingClientRect().top;
      element.style.height = Math.max(560, Math.round(window.innerHeight - top)) + "px";
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  async function newSession() {
    if (busy) return;
    setBusy(true); setError("");
    try {
      await api("/ai/threads", { method: "POST", body: {} }).catch(() => null);
      await api("/navigator/conversation", { method: "DELETE" });
      setMessages([]);
      setLinks([]);
      setViewing(null);
      const list = await api<{ threads?: readonly ThreadSummary[] }>("/ai/threads").catch(() => ({ threads: [] as readonly ThreadSummary[] }));
      setThreads(Array.isArray(list.threads) ? list.threads : []);
    } catch (problem) { setError(errorMessage(problem)); }
    finally { setBusy(false); }
  }

  async function openThread(id: string) {
    try { setViewing(await api<ThreadDetail>("/ai/threads/" + encodeURIComponent(id))); }
    catch (problem) { setError(errorMessage(problem)); }
  }
  async function deleteThread(id: string) {
    try {
      await api("/ai/threads/" + encodeURIComponent(id), { method: "DELETE" });
      setThreads(current => current.filter(item => item.id !== id));
      if (viewing?.id === id) setViewing(null);
    } catch (problem) { setError(errorMessage(problem)); }
  }

  async function openSpace(project: SpaceProject) {
    try {
      const data = await api<{ messages?: readonly { role: "user" | "assistant"; content: string }[]; revision?: number; configured?: boolean }>("/projects/" + encodeURIComponent(project.id) + "/assistant/conversation");
      setSpace(project);
      setSpaceMessages(Array.isArray(data.messages) ? data.messages.map(item => ({ role: item.role, content: item.content })) : []);
      setSpaceRevision(Number(data.revision ?? 0));
      setSpaceConfigured(data.configured !== false);
      setViewing(null);
      const charterData = await api<{ charter?: Charter | null }>("/projects/" + encodeURIComponent(project.id) + "/charter").catch(() => ({ charter: null }));
      setCharter(charterData.charter ?? null);
      setDraft({ open: false, goal: "", deliverables: "", nonGoals: "", timebox: "" });
    } catch (problem) { setError(errorMessage(problem)); }
  }

  /** 打开工作台时算一次提醒，不后台推送：只用已经拿到的数据，不额外请求。 */
  const reminders = (() => {
    const list: { specialist: string; text: string }[] = [];
    const active = events.find(item => item.eventId === eventId) ?? null;
    if (active !== null && active.registrationStatus !== "approved")
      list.push({ specialist: "enroll", text: "「" + active.title + "」的报名还不是已通过状态，先补齐再等审核。" });
    const approved = events.filter(item => item.registrationStatus === "approved").length;
    if (approved === 0) list.push({ specialist: "teamup", text: "你还没有任何已通过报名的赛事；组队大厅要报名通过后才能用。" });
    return list;
  })();

  async function saveCharter() {
    if (space === null || draft.goal.trim() === "") return;
    setBusy(true); setError("");
    try {
      const result = await api<{ charter: Charter }>("/projects/" + encodeURIComponent(space.id) + "/charter", { method: "PUT", body: {
        goal: draft.goal.trim(),
        deliverables: draft.deliverables,
        nonGoals: draft.nonGoals,
        timebox: draft.timebox.trim(),
        locked: true,
        ...(charter === null ? {} : { expectedVersion: charter.version }),
      } });
      setCharter(result.charter);
      setDraft({ open: false, goal: "", deliverables: "", nonGoals: "", timebox: "" });
    } catch (problem) { setError(errorMessage(problem)); }
    finally { setBusy(false); }
  }

  async function send() {
    const text = input.trim();
    if (text === "" || busy) return;
    setBusy(true); setError(""); setLinks([]);
    const append = space === null ? setMessages : setSpaceMessages;
    const drift = driftOf(text, space === null ? null : charter);
    append(current => [...current, { role: "user", content: text, ...(drift === "" ? {} : { drift }) }]);
    setInput("");
    try {
      if (space !== null) {
        const data = await api<{ message?: { content?: string }; revision?: number }>("/projects/" + encodeURIComponent(space.id) + "/assistant/messages",
          { method: "POST", body: { message: text, requestId: crypto.randomUUID(), expectedRevision: spaceRevision } });
        setSpaceMessages(current => [...current, { role: "assistant", content: data.message?.content ?? "（没有返回内容）", speaker: "团队空间助手" }]);
        setSpaceRevision(Number(data.revision ?? spaceRevision + 1));
        setLinks([]);
      } else if (mention !== null && eventId !== "") {
        const out = await api<AssistantOutput>("/organizer/events/" + encodeURIComponent(eventId) + "/module-assistants/" + encodeURIComponent(mention.key),
          { method: "POST", body: { instruction: text, eventId } });
        const items = (out.items ?? []).map(item => "· " + item.text).join("\n");
        const body = [out.body ?? "", items].filter(part => part.trim() !== "").join("\n\n");
        setMessages(current => [...current, {
          role: "assistant",
          content: body === "" ? "这个环节暂时没有可给的建议。" : (out.title ?? ""),
          speaker: mention.label,
          avatarKey: mention.key,
          items: [body === "" ? "" : body].filter(part => part.trim() !== ""),
          notes: [...(out.notes ?? [])],
        }]);
        setLinks([]);
      } else {
        const result = await api<Reply>("/navigator/messages", { method: "POST", body: { message: text, pagePath: "/ai" } });
        // charter_fill：AI 抽好的四栏直接预填到框架卡表单，用户改完点保存才写。
        if (result.action?.kind === "charter_fill" && result.action.charter !== undefined && space !== null) {
          setDraft({ open: true, goal: result.action.charter.goal, deliverables: result.action.charter.deliverables.join("\n"), nonGoals: result.action.charter.nonGoals.join("\n"), timebox: result.action.charter.timebox });
        }
        const suggested = result.action === undefined ? ""
          : (result.action.kind === "plan_task" ? "创建任务：" : result.action.kind === "team_note" ? "发团队说明：" : "写复盘条目：") + result.action.title + (result.action.dueAt === undefined ? "" : "（截止 " + result.action.dueAt.slice(0, 16).replace("T", " ") + "）");
        setMessages(current => [...current, { role: "assistant", content: suggested === "" ? result.reply : result.reply + "\n\n建议动作：" + suggested }]);
        setLinks(result.links ?? []);
      }
    } catch (problem) {
      setError(errorMessage(problem));
      setMessages(current => current.slice(0, -1));
      setInput(text);
    } finally { setBusy(false); }
  }

  return (
    <div className={styles.shell} ref={shellRef}>
      <aside className={styles.side}>
        <button type="button" className={styles.newSession} disabled={busy} onClick={() => void newSession()}>＋ 新会话</button>
        <div className={styles.sideScroll}>
          <p className={styles.sideTitle}>快捷入口</p>
          <ul className={styles.entries}>
            {ENTRIES.map(entry => (
              <li key={entry.href}>
                <Link className={styles.entry} href={entry.href}>
                  <span className={styles.entryGroup}>{entry.group}</span>{entry.label}
                </Link>
              </li>))}
          </ul>
          <p className={styles.sideTitle}>团队空间</p>
          <ul className={styles.entries}>
            {projects.length === 0 ? <li className={styles.agentState} style={{ padding: "2px 8px" }}>还没有团队空间</li> : projects.map(project => (
              <li key={project.id} className={styles.entry} style={{ cursor: "pointer" }} onClick={() => void openSpace(project)}>
                <span className={styles.entryGroup}>{space?.id === project.id ? "●" : ""}</span>
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{project.name}</span>
              </li>))}
          </ul>
          <p className={styles.sideTitle}>会话</p>
          <ul className={styles.entries}>
            {threads.length === 0 ? (
              <li className={styles.agentState} style={{ padding: "2px 8px" }}>还没有归档会话</li>) : threads.map(thread => (
              <li key={thread.id} className={styles.entry} style={{ cursor: "pointer" }} onClick={() => void openThread(thread.id)}>
                <span className={styles.entryGroup}>{thread.size}</span>
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{thread.title}</span>
                <button type="button" aria-label="删除会话" style={{ border: "none", background: "none", cursor: "pointer", color: "inherit" }}
                  onClick={event => { event.stopPropagation(); void deleteThread(thread.id); }}>✕</button>
              </li>))}
          </ul>
          <p className={styles.sideTitle}>AI 工作情况</p>
          <ul className={styles.agents}>
            <li className={styles.agent}>
              <span className={styles.dot} data-on="true" aria-hidden="true"/>
              <span>导航员</span>
              <span className={styles.agentState}>{busy ? "正在回答" : loaded ? "待命" : "读取中"}</span>
            </li>
            <li className={styles.agent}>
              <span className={styles.dot} aria-hidden="true"/>
              <span>专员 12 个</span>
              <span className={styles.agentState}>按环节待命</span>
            </li>
          </ul>
          <p className={styles.sideHint}>专员参与讨论是下一步：由代码依次调用，界面按发言展示。</p>
        </div>
        <div className={styles.account}>
          {account === null ? (
            <Link className={styles.loginLink} href={"/login?returnTo=" + encodeURIComponent("/ai")}>登录 / 注册</Link>) : (
            <>
              <span className={styles.accountAvatar} aria-hidden="true">{account.displayName.slice(0, 1)}</span>
              <span className={styles.accountName} title={account.email}>{account.displayName}</span>
            </>) }
        </div>
      </aside>

      <section className={styles.main}>
        <div className={styles.topbar}>
          <strong className={styles.title}>AI 工作台</strong>
          <span className={styles.chip}>导航员</span>
          <span className={styles.chip}>专员 0 / 12 参与</span>
          <span className={styles.chipMuted}>{busy ? "工作中" : "待命"}</span>
          <span className={styles.grow}/>
          <span className={styles.chipMuted}>DeepSeek Harness</span>
        </div>

        {space === null ? null : (
          <div className={styles.charterCard}>
            {charter === null && !draft.open ? (
              <div className={styles.charterRow}>
                <span>这个项目还没有框架卡。先定主线，之后的对话才能判断有没有跑偏。</span>
                <button type="button" className={styles.chip} onClick={() => setDraft(value => ({ ...value, open: true }))}>定框架</button>
              </div>) : null}
            {charter !== null && !draft.open ? (
              <div className={styles.charterBody}>
                <p className={styles.charterGoal}>目标：{charter.goal}</p>
                {charter.deliverables.length === 0 ? null : <p className={styles.charterMeta}>交付物：{charter.deliverables.join(" · ")}</p>}
                {charter.nonGoals.length === 0 ? null : <p className={styles.charterMeta}>明确不做：{charter.nonGoals.join(" · ")}</p>}
                {charter.timebox === "" ? null : <p className={styles.charterMeta}>时间盒：{charter.timebox}</p>}
                <p className={styles.charterMeta}>v{charter.version}{charter.locked ? " · 已锁定" : " · 未锁定"}</p>
                <button type="button" className={styles.chip} onClick={() => setDraft({ open: true, goal: charter.goal, deliverables: charter.deliverables.join("\n"), nonGoals: charter.nonGoals.join("\n"), timebox: charter.timebox })}>改框架</button>
              </div>) : null}
            {draft.open ? (
              <div className={styles.charterForm}>
                <label>目标（一句话）<textarea rows={2} maxLength={400} value={draft.goal} onChange={event => setDraft(value => ({ ...value, goal: event.target.value }))}/></label>
                <label>交付物（一行一条）<textarea rows={2} value={draft.deliverables} onChange={event => setDraft(value => ({ ...value, deliverables: event.target.value }))}/></label>
                <label>明确不做（一行一条）<textarea rows={2} value={draft.nonGoals} onChange={event => setDraft(value => ({ ...value, nonGoals: event.target.value }))}/></label>
                <label>时间盒<input value={draft.timebox} maxLength={60} placeholder="例如 周六 18:00 前" onChange={event => setDraft(value => ({ ...value, timebox: event.target.value }))}/></label>
                <div className={styles.charterRow}>
                  <button type="button" className={styles.chip} onClick={() => setDraft({ open: false, goal: "", deliverables: "", nonGoals: "", timebox: "" })}>取消</button>
                  <button type="button" className={styles.chip} disabled={busy || draft.goal.trim() === ""} onClick={() => void saveCharter()}>保存并锁定</button>
                </div>
              </div>) : null}
          </div>)}
        {space === null ? null : (
          <div className={styles.spaceBanner}>
            <span>正在和「{space.name}」的团队空间助手对话{spaceConfigured ? "" : "（该助手未配置模型）"}</span>
            <button type="button" className={styles.chip} onClick={() => { setSpace(null); setSpaceMessages([]); }}>回到导航员</button>
            <nav className={styles.spaceNav} aria-label="团队空间入口">
              <Link href={"/app/projects/" + encodeURIComponent(space.id) + "/team"}>成员</Link>
              <Link href={"/app/projects/" + encodeURIComponent(space.id) + "/plan"}>计划</Link>
              <Link href={"/app/projects/" + encodeURIComponent(space.id) + "/delivery"}>交付</Link>
              <Link href={"/app/projects/" + encodeURIComponent(space.id) + "/resources"}>资料</Link>
              <Link href={"/app/projects/" + encodeURIComponent(space.id) + "/rules"}>规则</Link>
              <Link href={"/app/projects/" + encodeURIComponent(space.id) + "/retrospective"}>复盘</Link>
            </nav>
          </div>)}
        <div className={styles.thread}>
          {viewing === null ? null : (
            <div className={styles.links}>
              <span className={styles.chip}>正在查看归档：{viewing.title}</span>
              <button type="button" className={styles.example} onClick={() => setViewing(null)}>回到当前对话</button>
            </div>) }
          {viewing === null && space === null && messages.length === 0 && loaded ? (
            <div className={styles.welcome}>
              <h2>想做什么？</h2>
              <p className={styles.thinking}>可以问：这场比赛怎么报名、我该准备什么、队伍还缺谁、材料怎么填。</p>
              <div className={styles.examples}>
                {["我该从哪开始", "报名要填什么", "队伍缺前端怎么办"].map(example => (
                  <button type="button" key={example} className={styles.example} onClick={() => setInput(example)}>{example}</button>))}
              </div>
            </div>) : (viewing !== null ? viewing.messages : space !== null ? spaceMessages : messages).map((message, index) => (
            <div key={index} className={message.role === "user" ? styles.userRow : styles.aiRow}>
              <div className={message.role === "user" ? styles.userBubble : (message.items ? styles.specialistCard : styles.aiBubble)}>
                <span className={styles.cardHead}>
                  {message.avatarKey === undefined ? <span className={styles.avatarDot} aria-hidden="true"/> : <SpecialistAvatar specialistKey={message.avatarKey} size={18}/>}
                  <span className={styles.speaker}>{message.role === "user" ? "你" : message.speaker ?? "导航员"}</span>
                  {message.items ? <span className={styles.tag}>专员回复</span> : null}
                </span>
                {message.items && message.content !== "" ? <p className={styles.cardTitle}>{message.content}</p> : null}
                {message.items ? message.items.map((item, i) => <p key={i} className={styles.cardItem}>{item}</p>) : <p>{message.content}</p>}
                {message.drift === undefined ? null : <p className={styles.drift}>{message.drift}</p>}
                {message.notes && message.notes.length > 0 ? (
                  <details className={styles.cardDetails}>
                    <summary>这次读了什么 / 缺什么（{message.notes.length}）</summary>
                    <ul>{message.notes.map(note => <li key={note}>{note}</li>)}</ul>
                  </details>) : null}
              </div>
            </div>))}
          {busy ? <p className={styles.thinking}>导航员正在读资料…</p> : null}
          {links.length > 0 ? (
            <div className={styles.links}>
              {links.map(link => <Link key={link.href} className={styles.link} href={link.href}>{link.title}</Link>)}
            </div>) : null}
          {error === "" ? null : <p role="alert" className={styles.error}>{error}</p>}
          <div ref={bottom}/>
        </div>

        {viewing === null ? (<div className={styles.composerWrap}>
          {reminders.length === 0 ? null : (
            <div className={styles.reminders}>
              {reminders.map(item => {
                const target = specialists.find(candidate => candidate.key === item.specialist);
                return (
                  <button type="button" key={item.text} className={styles.reminder}
                    onClick={() => { if (target !== undefined) { setMention(target); setInput("帮我看看：" + item.text); } }}>
                    <span className={styles.reminderDot}/>
                    <strong>{target?.label ?? "提醒"}</strong>
                    <span>{item.text}</span>
                  </button>);
              })}
            </div>)}
          <div className={styles.toolbar}>
            <button type="button" className={styles.chip} onClick={() => setMentionOpen(value => !value)}>
              {mention === null ? null : <SpecialistAvatar specialistKey={mention.key} size={16}/>}
              ＠专员{mention === null ? "" : "：" + mention.label}
            </button>
            {mention === null ? null : <button type="button" className={styles.chip} onClick={() => setMention(null)}>清除</button>}
            <span className={styles.grow}/>
            {events.length === 0 ? null : (
              <select className={styles.eventSelect} value={eventId} onChange={event => setEventId(event.target.value)} aria-label="选择赛事">
                {events.map(item => <option key={item.eventId} value={item.eventId}>{item.title}</option>)}
              </select>)}
          </div>
          {mentionOpen ? (
            <ul className={styles.mentionList}>
              {specialists.map(item => (
                <li key={item.key}>
                  <button type="button" onClick={() => { setMention(item); setMentionOpen(false); }}>
                    <SpecialistAvatar specialistKey={item.key} size={20}/>
                    <strong>{item.label}{reminders.some(reminder => reminder.specialist === item.key) ? <span className={styles.reminderBadge}>!</span> : null}</strong>
                    {item.available === false ? <span className={styles.unavailable}>需报名通过</span> : null}
                    <span>{item.audience === "participant" ? "选手端" : "主办方"}</span>
                  </button>
                </li>))}
              {specialists.length === 0 ? <li className={styles.agentState} style={{ padding: "6px 8px" }}>专员目录暂时读不到，请刷新。</li> : null}
            </ul>) : null}
          <div className={styles.quickRow}>
            {QUICK_PROMPTS.map(item => (
              <button type="button" key={item.label} className={styles.example} onClick={() => {
                setInput(item.prompt);
                const target = specialists.find(candidate => candidate.key === item.specialist);
                if (target !== undefined) setMention(target);
              }}>{item.label}</button>))}
          </div>
          <div className={styles.composer}>
            <button type="button" className={styles.plus} aria-label="快捷问题" onClick={() => setInput("帮我看看报名还差什么")}>＋</button>
            <textarea
              rows={1}
              value={input}
              placeholder="说一句你想做的事，例如「帮我看看报名还差什么」"
              onChange={event => setInput(event.target.value)}
              onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }}/>
            <button type="button" className={styles.send} disabled={busy || input.trim() === ""} onClick={() => void send()} aria-label="发送">↑</button>
          </div>
          <div className={styles.composerMeta}>
            <span>只读 · 不代提交</span>
            <span className={styles.grow}/>
            <span>DeepSeek Harness</span>
          </div>
          <p className={styles.disclaimer}>AI 只提供建议与草稿，不会代替你提交任何资料。</p>
        </div>) : <p className={styles.disclaimer} style={{ padding: "10px 14px" }}>这是归档会话，只读；点「回到当前对话」继续聊。</p>}
      </section>
    </div>);
};