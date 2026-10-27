"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { BackendDashboard } from "../server/backend-dashboard.ts";
import type { DiscoveryState } from "../modules/operations/discovery-types.ts";
import { ApiError, api, dateText, useApi } from "./client-api.ts";
import { Empty, Feedback, Loading, PageTitle, SiteShell } from "./site-shell.tsx";
import styles from "./backend-dashboard.module.css";

type Service = BackendDashboard["services"][number];
type Worker = BackendDashboard["workers"][number];
type Task = BackendDashboard["queues"]["ai"]["recent"][number];
const serviceNames: Record<Service["id"], { name: string; purpose: string; next: string }> = {
  database: { name: "数据库", purpose: "保存项目、队列、审核与调用账本。", next: "数据库无法读取时，检查进程和数据库配置。" },
  mail: { name: "登录邮件", purpose: "发送登录验证邮件。", next: "如需真实邮件，配置邮件服务与发件人。" },
  generic_ai: { name: "项目 AI 服务", purpose: "处理赛事分析、测评、职责建议、分工、规划与复盘；共用后台选择的 AI 服务。", next: "配置模型供应商和计价后，由后台进程消费任务。" },
  dsh: { name: "DeepSeek Harness", purpose: "为自动发现和来源分析提供模型运行入口。", next: "核对 DSH 运行时、模型凭据与计价配置。" },
  search: { name: "比赛搜索", purpose: "通过 Brave 搜索获取候选来源。", next: "搜索需要独立的 Brave 服务配置。" },
  github: { name: "GitHub App", purpose: "授权仓库并保存团队作品。", next: "核对 GitHub App 配置；仓库授权仍需用户完成。" },
};
const names: Record<string, string> = {
  queued: "排队", running: "执行中", succeeded: "已完成", failed: "失败", cancelled: "已取消", unknown: "状态未知", review_ready: "待审核",
  idle: "空闲", not_started: "尚无心跳", stopped: "已停止", stale: "心跳过期", paused: "已暂停", waiting: "等待下一轮", ready: "可运行",
  limited: "今日额度不足", attention: "需要检查",
  m03_analysis: "赛事分析", m04_scoring: "能力测评", m04_role_help: "职责选择建议", assignment_suggestion: "分工建议", m05_planning: "任务规划", m07_retrospective: "项目复盘",
  navigator: "导航员调用", source: "来源模型调用", other: "其他任务",
  crawl: "来源抓取", analysis: "来源分析", pending: "待审核", approved: "已批准", published: "已发布", rejected: "已拒绝", changes_requested: "待修改",
  received: "新纠错", triaging: "核查中", confirmed: "已确认", needs_more_info: "待补充", dismissed: "已驳回", resolved: "已解决",
};
const workerNames: Record<Worker["kind"], string> = { ai: "AI 任务进程", source: "来源采集进程", discovery: "自动发现进程", inspiration: "DSH 灵感更新进程", "planning-notifications":"计划风险提醒", "github-maintenance":"GitHub 临时草稿维护", "retention-maintenance":"过期私有资料清理", "resource-links":"审核资源链接检查", "organizer-notifications":"主办方邮件通知" };
const policyNames = { genericAi: "通用 AI", dshProjects: "DSH 项目调用", dshSources: "DSH 来源调用" } as const;
function name(value: string) { return names[value] ?? value; }
function diagnostic(value: string) {
  const hints: Record<string, string> = {
    OFFICIAL_SOURCE_RULES_CHANGED: "官网列表格式变化，需要检查提取规则。",
    OFFICIAL_SOURCE_LINK_REJECTED: "链接超出已批准的单场赛事范围，需要检查来源规则。",
    FETCH_UNAVAILABLE: "官网连接失败，请检查后台联网与来源状态。",
    FETCH_TIMEOUT: "官网读取超时，请检查后台联网与来源状态。",
    DISCOVERY_MODEL_REQUIRES_REVIEW: "此前模型结果未确认，该地址已停止自动调用。",
    DISCOVERY_SEARCH_REQUIRES_REVIEW: "此前原生搜索结果未确认，该查询已停止自动调用，需要人工检查。",
    DSH_SEARCH_RUNTIME_UNAVAILABLE: "DSH 原生搜索运行时无法启动，请核对本机安装版本。",
    DSH_SEARCH_CREDENTIAL_INVALID: "DSH 账号授权不可用，请在 DeepSeek Harness 中完成授权。",
  };
  return hints[value] ? `${value} · ${hints[value]}` : value;
}
function integer(value: number) { return new Intl.NumberFormat("zh-CN").format(value); }
function money(value: string | null, currency: "USD" | "CNY" = "USD") {
  if (value === null || !/^\d+$/.test(value)) return "未知";
  const micros = BigInt(value);
  const whole = (micros / 1_000_000n).toLocaleString("zh-CN");
  const fraction = (micros % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "").padEnd(2, "0");
  return `${currency === "USD" ? "$" : "¥"}${whole}.${fraction} ${currency}`;
}
function duration(milliseconds: number | null) {
  if (milliseconds === null) return "未记录";
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
  return `${Math.floor(seconds / 3600)} 小时 ${Math.floor(seconds % 3600 / 60)} 分`;
}
function sampleTime(value: string) {
  if (!Number.isFinite(Date.parse(value))) return "未记录";
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "medium", timeStyle: "medium" }).format(new Date(value)) + "（北京时间）";
}
function recoveryHint(task: Task, queue: string) {
  const code = task.errorCode ?? "";
  if (/BUDGET|QUOTA|LIMIT/.test(code)) return "先核对对应项目或来源的每日额度与未结算记录，再决定是否重试。";
  if (/CREDENTIAL|AUTH|ACCESS_DENIED/.test(code)) return "核对服务配置与任务所需权限，再由有权限的运营人员处理。";
  if (/SCHEMA|PARSE|INVALID_INPUT|SOURCE_CHANGED/.test(code)) return "核对来源原文与任务输入；来源变化或结构不匹配需要人工检查。";
  return queue === "来源" ? "到采集管理核对任务、来源配置与后台进程。" : "核对对应项目的任务状态、模型配置与后台进程。";
}
function Badge({ children, attention = false, checked = false }: { children: React.ReactNode; attention?: boolean; checked?: boolean }) {
  return <span className={`${styles.badge} ${attention ? styles.attention : ""} ${checked ? styles.checked : ""}`}>{children}</span>;
}
function SectionHeading({ index, title, caption }: { index: string; title: string; caption?: string }) {
  return <div className={styles.sectionHeader}><h2><span className={styles.sectionIndex}>{index}</span>{title}</h2>{caption && <p className={styles.muted}>{caption}</p>}</div>;
}
function CountGroup({ title, counts, total }: { title: string; counts: Readonly<Record<string, number>>; total?: number }) {
  return <div><h3>{title}{total !== undefined && <span className={styles.caption}> · {integer(total)} 条</span>}</h3><ul className={styles.counts}>{Object.entries(counts).map(([status, count]) => <li key={status}><span className={styles.count}>{integer(count)}</span><span className={styles.countLabel}>{name(status)}</span></li>)}</ul></div>;
}
function SpendMeter({ label, used, limit, currency }: { label: string; used: string; limit: string; currency: "USD" | "CNY" }) {
  const valid = /^\d+$/.test(used) && /^\d+$/.test(limit) && BigInt(limit) > 0n;
  const percentage = valid ? Number(BigInt(used) * 1000n / BigInt(limit)) / 10 : null;
  return <><p className={styles.budgetLabel}><span>{label}</span><strong>{money(used, currency)} / {money(limit, currency)}</strong></p>{percentage !== null && <div className={`${styles.meter} ${percentage >= 100 ? styles.meterLimit : ""}`} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, percentage)} aria-valuetext={`${money(used, currency)}，上限 ${money(limit, currency)}`}><span style={{ width: `${Math.min(100, percentage)}%` }} /></div>}</>;
}
function ServiceCards({ services, provider }: { services: BackendDashboard["services"]; provider: BackendDashboard["discovery"]["provider"] }) {
  return <section className={styles.section} aria-label="后端服务状态"><SectionHeading index="01" title="六项服务" caption="数据库实测；其余只检查配置完整性" /><div className={styles.services}>{services.map(service => {
    const descriptor = service.id === "search" && provider === "dsh_native" ? { name: "DSH 原生联网搜索", purpose: "由 DeepSeek Harness 搜索公开赛事公告，再生成有依据的分析卡片。", next: "检查 DSH 账号授权、原生搜索模型与每日额度。" } : service.id === "search" && provider === "official_sources" ? { name: "官方赛事来源", purpose: "定期检查已选官网的赛事列表，再由 DSH 分析单场详情。", next: "检查官方来源名单、网络与采集配置。" } : serviceNames[service.id];
    const tested = service.connectivity === "reachable";
    return <article key={service.id} className={styles.card}><div className={styles.cardHead}><h3>{descriptor.name}</h3><Badge checked={tested} attention={!service.configured}>{tested ? "数据库可读取" : service.configured ? "配置完整" : "未配置"}</Badge></div><p>{descriptor.purpose}</p><p className={styles.caption}>{tested ? "本次状态读取已成功查询数据库。" : "未发起供应商连通性测试。"}</p><p className={styles.caption}>{!service.configured ? descriptor.next : service.id === "database" ? "不展示连接地址或凭据。" : "实际授权、邮件或模型调用结果以对应任务记录为准。"}</p></article>;
  })}</div></section>;
}
function Workers({ workers }: { workers: BackendDashboard["workers"] }) {
  return <section className={styles.panel}><h2><span className={styles.sectionIndex}>02</span>后台进程</h2><div className={styles.queueGroups}>{workers.map(worker => <article key={worker.kind}><div className={styles.cardHead}><h3>{workerNames[worker.kind]}</h3><Badge attention={!worker.configured || ["failed", "stale", "stopped"].includes(worker.status)}>{!worker.configured ? "未配置" : name(worker.status)}</Badge></div><dl className={styles.facts}><div><dt>最近心跳</dt><dd>{dateText(worker.lastSeenAt)}</dd></div><div><dt>心跳距采样</dt><dd>{duration(worker.ageMs)}</dd></div><div><dt>最近完成</dt><dd>{dateText(worker.lastCompletedAt)}</dd></div>{worker.errorCode && <div><dt>错误代码</dt><dd className={styles.mono}>{worker.errorCode}</dd></div>}</dl></article>)}</div><p className={styles.caption}>心跳超过 120 秒即标记过期；“空闲”只表示进程最近报告空闲，不代表外部供应商已连通。</p></section>;
}
function Queues({ queues }: { queues: BackendDashboard["queues"] }) {
  return <section className={styles.panel}><h2><span className={styles.sectionIndex}>03</span>真实任务队列</h2><div className={styles.queueGroups}><CountGroup title="AI 执行记录" counts={queues.ai.counts} total={queues.ai.total} /><CountGroup title="来源采集与分析" counts={queues.sourceRuns.counts} total={queues.sourceRuns.total} /><div><h3>业务任务</h3><ul className={styles.counts}><li><span className={styles.count}>{integer(queues.domainWaiting.totalQueued)}</span><span className={styles.countLabel}>等待进入执行队列</span></li><li><span className={styles.count}>{integer(queues.domainWaiting.totalRunning)}</span><span className={styles.countLabel}>业务执行中</span></li></ul><details className={styles.budgetDetails}><summary>查看各业务模块</summary><dl className={styles.facts}>{queues.domainWaiting.byKind.map(item => <div key={item.kind}><dt>{name(item.kind)}</dt><dd>待执行 {integer(item.queued)} · 执行中 {integer(item.running)}</dd></div>)}</dl></details></div></div><p className={styles.caption}>以上是当前库存与任务状态，包含历史完成记录；业务任务与执行记录属于不同层级，不应相加。</p></section>;
}
function Budgets({ dashboard }: { dashboard: BackendDashboard }) {
  const usage = dashboard.aiBudget;
  const discovery = dashboard.discovery;
  const state = discovery.state;
  return <section className={styles.section}><SectionHeading index="04" title="调用与费用" caption={`AI 账本日期 ${dashboard.quotaDay} · UTC`} /><div className={styles.budgetGrid}><article className={styles.budgetCard}><h3>今日 AI 调用账本</h3><dl className={styles.facts}><div><dt>调用数</dt><dd>{integer(usage.calls)}</dd></div><div><dt>调用尝试</dt><dd>{integer(usage.attempts)}</dd></div><div><dt>尚未结算</dt><dd>{integer(usage.pendingAttempts)}</dd></div><div><dt>按费率记入的估算</dt><dd>{money(usage.knownChargedMicroUsd)}</dd></div><div><dt>已知预留</dt><dd>{money(usage.knownReservedMicroUsd)}</dd></div><div><dt>已知小计</dt><dd>{money(usage.knownTotalMicroUsd)}</dd></div><div><dt>账本完整估算总额</dt><dd>{usage.completeTotalMicroUsd === null ? "未知，不能按零计费" : money(usage.completeTotalMicroUsd)}</dd></div><div><dt>费用未知尝试</dt><dd>{integer(usage.unknownFeeAttempts)}</dd></div><div><dt>用量未核验</dt><dd>{integer(usage.unverifiedUsageAttempts)}</dd></div></dl><p className={styles.caption}>{usage.includesEstimates ? "账本包含估算或预留，尚非最终供应商账单。" : "账本数值来自已保存记录，完整性仍以上方未知项为准。"}金额单位为美元（USD）。</p><details className={styles.budgetDetails} open><summary>每日调用策略与上限</summary><ul className={styles.sourceBudgets}>{Object.entries(dashboard.budgetPolicies).map(([kind, policy]) => <li key={kind} className={styles.sourceBudget}><strong>{policyNames[kind as keyof typeof policyNames]}</strong>{policy ? <><p className={styles.budgetLabel}><span>{policy.scope === "source" ? "每个来源" : policy.scope === "project" ? "每个项目" : "每个项目或用户"} / UTC 日</span><strong>{integer(policy.dailyCallLimit)} 次</strong></p><p className={styles.budgetLabel}><span>每日费用上限</span><strong>{money(policy.dailyBudgetMicroUsd)}</strong></p><p className={styles.caption}>{policy.pricingConfigured ? "已配置模型单价。" : "计价未配置，不能推断实际费用。"}</p></> : <p className={styles.caption}>未配置此调用策略。</p>}</li>)}</ul></details><p className={styles.caption}>今日账本是全站汇总；每项目、每用户或每来源的上限分别执行，不以全站小计计算额度百分比。</p></article><article className={styles.budgetCard}><div className={styles.cardHead}><h3>自动发现额度</h3><Badge attention={!discovery.configured || ["paused", "stale"].includes(discovery.phase)}>{!discovery.configured ? "未配置" : name(discovery.phase)}</Badge></div>{state ? <><dl className={styles.facts}><div><dt>记录所属日</dt><dd>{state.quotaDay} · UTC</dd></div><div><dt>{discovery.provider === "official_sources" ? "来源检查" : "搜索调用"}</dt><dd>{integer(state.searchCalls)}</dd></div><div><dt>模型调用</dt><dd>{integer(state.modelCalls)}</dd></div><div><dt>估算费用</dt><dd>{money(state.estimatedCostMicros, state.currency)}</dd></div><div><dt>下一次可运行</dt><dd>{dateText(state.nextEligibleAt)}</dd></div><div><dt>最近一轮结束</dt><dd>{dateText(state.lastCompletedAt)}</dd></div>{state.lastErrorCode && <div><dt>错误代码</dt><dd className={styles.mono}>{diagnostic(state.lastErrorCode)}</dd></div>}</dl>{state.quotaDay !== dashboard.quotaDay && <p className={styles.stale}>这份发现记录属于 {state.quotaDay}，尚非今天的消费记录。</p>}<p className={styles.caption}>{state.includesReservation ? "估算包含正在执行的预留额度。" : "此金额为自动发现账本估算。"}它不是最终账单，不与上方 AI 账本直接相加。</p></> : <Empty>暂无自动发现运行记录，当前消费未记录。</Empty>}{discovery.limits ? <div className={styles.budgetDetails}><h3>自动发现每日上限</h3><dl className={styles.facts}><div><dt>{discovery.provider === "official_sources" ? "来源检查上限" : "搜索上限"}</dt><dd>{integer(discovery.limits.maxSearchCallsPerDay)} 次</dd></div><div><dt>模型上限</dt><dd>{integer(discovery.limits.maxModelCallsPerDay)} 次</dd></div><div><dt>估算费用上限</dt><dd>{money(discovery.limits.maxEstimatedCostMicrosPerDay, discovery.limits.currency)}</dd></div></dl>{state && state.quotaDay === dashboard.quotaDay && state.currency === discovery.limits.currency && <SpendMeter label="本记录日估算 / 每日上限" used={state.estimatedCostMicros} limit={discovery.limits.maxEstimatedCostMicrosPerDay} currency={state.currency} />}</div> : <p className={styles.caption}>自动发现限额未配置。</p>}<p className={styles.caption}>{discovery.provider === "dsh_native" ? "原生联网搜索和赛事分析均计入本发现账本的模型调用与估算费用；搜索用量不明时按完整预留计入。" : discovery.provider === "official_sources" ? "当前未使用付费搜索 API；DSH 分析仍按模型用量估算。" : "搜索为独立供应商，模型账本不代表完整搜索费用。"}最短运行间隔：{discovery.minimumIntervalMs === null ? "未配置" : duration(discovery.minimumIntervalMs)}。</p></article></div></section>;
}
function DiscoveryCoverage({ dashboard }: { dashboard: BackendDashboard }) {
  const coverage = dashboard.discovery.coverage;
  if (!coverage) return null;
  return <section className={styles.panel} aria-label="赛事搜索运行统计">
    <h2>赛事搜索运行统计</h2>
    <p>每天持续搜索的目标为 {coverage.targetHours} 小时。服务器运行时轮换关键词；每日费用上限优先执行。</p>
    <dl className={styles.facts}>
      <div><dt>统计所属日</dt><dd>{coverage.quotaDay} · UTC</dd></div>
      <div><dt>已处理轮次</dt><dd>{integer(coverage.cycles)} 轮</dd></div>
      <div><dt>已返回的搜索</dt><dd>{integer(coverage.searchCalls)} 次</dd></div>
      <div><dt>读取页面 / 保存卡片</dt><dd>{integer(coverage.fetchedPages)} / {integer(coverage.savedCards)}</dd></div>
      <div><dt>各轮累计处理耗时</dt><dd>{duration(coverage.activeMs)}</dd></div>
      <div><dt>首次到最近一轮的时间跨度</dt><dd>{duration(coverage.spanMs)}</dd></div>
      <div><dt>首次开始</dt><dd>{dateText(coverage.firstStartedAt)}</dd></div>
      <div><dt>最近结束</dt><dd>{dateText(coverage.lastCompletedAt)}</dd></div>
    </dl>
    <p className={styles.caption}>累计处理耗时包含搜索、读取和分析的等待；时间跨度还包含轮次之间的间隔与可能的停机。两者都不能证明 DSH 连续工作了 5 小时。历史运行不会补造统计。</p>
    {["limited", "attention", "paused"].includes(dashboard.discovery.phase) && <p className={styles.stale} role="status">当前状态：{name(dashboard.discovery.phase)}。额度不足会等待下个 UTC 日；请求结果未知需先核对，不会自动重复付费调用。</p>}
  </section>;
}
function DiscoveryFlow({ dashboard }: { dashboard: BackendDashboard }) {
  const dsh = dashboard.services.find(item => item.id === "dsh");
  const search = dashboard.services.find(item => item.id === "search");
  const urls = dashboard.discovery.recentUrls;
  const steps = [
    { title: "DSH 父服务", description: "模型运行入口，后台调度发现与分析。", status: dsh?.configured ? "配置完整，未测试" : "未配置" },
    { title: dashboard.discovery.provider === "official_sources" ? "检查官方赛事来源" : "搜索比赛", description: dashboard.discovery.provider === "dsh_native" ? "DSH 轮换搜索全网、公众号和社交平台，补充官方目录并回访已收录赛事。" : dashboard.discovery.provider === "official_sources" ? "从限定官网列表发现单场赛事链接。" : "独立 Brave 搜索获取候选地址。", status: search?.configured ? "发现入口配置完整" : "发现入口未配置" },
    { title: "安全抓取", description: "校验地址与重定向；无法读取全文时只采用明确标注的搜索引用。", status: `近期完成 ${integer(urls.filter(item => item.status === "completed").length)} · 失败 ${integer(urls.filter(item => item.status === "failed").length)}` },
    { title: "分析与入队", description: "保留依据，形成待人工核对的候选。", status: `来源排队 ${integer(dashboard.queues.sourceRuns.counts.queued)} · 执行中 ${integer(dashboard.queues.sourceRuns.counts.running)}` },
    { title: "未核验卡片", description: "候选先保留未核验状态，再由运营审核。", status: `现存 ${integer(dashboard.discovery.cards.active)} 张` },
  ];
  return <section className={styles.section}><SectionHeading index="05" title="从发现到核验" caption="流程示意，不代表正在执行每个环节" /><ol className={styles.flow}>{steps.map((step, index) => <li key={step.title}><span className={styles.flowNumber}>0{index + 1}</span><h3>{step.title}</h3><p>{step.description}</p><Badge>{step.status}</Badge></li>)}</ol><p className={styles.caption}>已撤回候选 {integer(dashboard.discovery.cards.withdrawn)} 张。采集管理可处理暂停、来源配置与审核，控制台只读取状态。</p></section>;
}
function InspirationOperations({ dashboard, reload, disabled }: { dashboard: BackendDashboard; reload(): Promise<void>; disabled: boolean }) {
  const inspiration = dashboard.inspiration, state = inspiration.state;
  const [busy, setBusy] = useState(false), [error, setError] = useState<Error | null>(null), [notice, setNotice] = useState("");
  const desiredPaused = !state?.paused;
  async function changePaused() {
    if (busy || disabled || !inspiration.configured) return;
    setBusy(true); setError(null); setNotice("");
    try {
      // Only an explicit administrator action reads/initializes this scheduler;
      // ordinary dashboard refresh remains a single read-only SQL snapshot.
      const current = await api<DiscoveryState>("/admin/inspiration/status");
      const saved = await api<DiscoveryState>("/admin/inspiration/paused", { method: "POST", body: { expectedRevision: current.revision, paused: desiredPaused } });
      if (saved.paused !== desiredPaused) throw new Error("灵感更新状态未返回预期结果，请刷新核对。");
      setNotice(desiredPaused ? "DSH 灵感更新已暂停，已保存的资料仍可查看。" : "DSH 灵感更新已恢复，后续运行仍受独立额度与时间间隔限制。");
      await reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason : new Error("灵感更新控制未完成，请刷新状态后重试。"));
      if (reason instanceof ApiError && [401, 403].includes(reason.status)) await reload();
    }
    finally { setBusy(false); }
  }
  return <section className={styles.panel} aria-label="DSH 灵感更新管理"><div className={styles.cardHead}><h2>DSH 灵感更新与独立额度</h2><Badge attention={!inspiration.configured || ["paused", "stale", "limited", "attention"].includes(inspiration.phase)}>{!inspiration.configured ? "未配置" : name(inspiration.phase)}</Badge></div>
    <p className={styles.caption}>DSH 读取已知官网并更新用途、适用场景与使用注意。AI 说明不代表人工审核发布；本额度与赛事发现、项目 AI 账本分别执行。</p>
    <div className={styles.budgetGrid}><div><dl className={styles.facts}><div><dt>已保存的灵感分析</dt><dd>{integer(inspiration.cards)} 条</dd></div><div><dt>最短运行间隔</dt><dd>{inspiration.minimumIntervalMs === null ? "未配置" : duration(inspiration.minimumIntervalMs)}</dd></div>{state && <><div><dt>记录所属日</dt><dd>{state.quotaDay} · UTC</dd></div><div><dt>模型调用</dt><dd>{integer(state.modelCalls)} 次</dd></div><div><dt>估算费用</dt><dd>{money(state.estimatedCostMicros, state.currency)}</dd></div><div><dt>下一次可运行</dt><dd>{dateText(state.nextEligibleAt)}</dd></div><div><dt>最近一轮结束</dt><dd>{dateText(state.lastCompletedAt)}</dd></div>{state.lastErrorCode && <div><dt>错误代码</dt><dd className={styles.mono}>{diagnostic(state.lastErrorCode)}</dd></div>}</>}</dl>
      {!state && <p className={styles.caption}>尚无灵感更新运行记录，不能将未记录视为已执行。</p>}
      {state?.quotaDay !== dashboard.quotaDay && state && <p className={styles.caption}>这份灵感记录属于 {state.quotaDay}，尚非今天的消费记录。</p>}
    </div><div>{inspiration.limits ? <><h3>灵感更新每日上限</h3><dl className={styles.facts}><div><dt>模型调用上限</dt><dd>{integer(inspiration.limits.maxModelCallsPerDay)} 次 / UTC 日</dd></div><div><dt>估算费用上限</dt><dd>{money(inspiration.limits.maxEstimatedCostMicrosPerDay, inspiration.limits.currency)}</dd></div></dl>{state && state.quotaDay === dashboard.quotaDay && state.currency === inspiration.limits.currency && <SpendMeter label="灵感记录日估算 / 每日上限" used={state.estimatedCostMicros} limit={inspiration.limits.maxEstimatedCostMicrosPerDay} currency={state.currency}/>}</> : <p className={styles.caption}>灵感更新限额未配置。</p>}
      <p className={styles.caption}>{state?.includesReservation ? "估算包含已预留的运行额度。" : "估算来自已保存的灵感更新账本。"}未知付费结果需人工核对，不自动重复分析；金额不是供应商最终账单。</p>
    </div></div>
    <Feedback error={error} notice={notice}/><div className={styles.actions}><button type="button" className={styles.button} disabled={disabled || busy || !inspiration.configured} onClick={() => void changePaused()}>{busy ? "正在更新灵感调度…" : state?.paused ? "恢复 DSH 灵感更新" : "暂停 DSH 灵感更新"}</button><Link href="/inspiration" className={styles.linkButton}>查看灵感库</Link></div>
    {!inspiration.configured && <p className={styles.caption}>尚未启用 DSH 灵感更新。暂停或恢复不能补齐运行配置。</p>}
  </section>;
}
function RecentTasks({ queues, recentUrls }: { queues: BackendDashboard["queues"]; recentUrls: BackendDashboard["discovery"]["recentUrls"] }) {
  const recent: (Task & { queue: string })[] = [...queues.ai.recent.map(task => ({ ...task, queue: "AI" })), ...queues.sourceRuns.recent.map(task => ({ ...task, queue: "来源" }))].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, 12);
  return <section className={styles.section}><SectionHeading index="06" title="最近任务与错误" caption="仅安全元数据，无凭据、原始日志或提示词" />{recent.length ? <ul className={styles.recent}>{recent.map(task => <li key={`${task.queue}:${task.id}`} className={styles.run}><div className={styles.runHeader}><h3>{task.queue} · {name(task.kind)}</h3><Badge attention={task.status === "failed" || task.status === "unknown"}>{name(task.status)}</Badge></div><dl className={styles.facts}><div><dt>任务 ID</dt><dd className={styles.mono}>{task.id}</dd></div><div><dt>更新时间</dt><dd>{dateText(task.updatedAt)}</dd></div>{task.errorCode && <div><dt>错误代码</dt><dd className={styles.mono}>{task.errorCode}</dd></div>}</dl>{task.errorCode && <p className={styles.caption}>{recoveryHint(task, task.queue)}此处读取不会重试或重新收费。</p>}</li>)}</ul> : <Empty>暂无 AI 或来源任务记录。任务总数为实际查询结果。</Empty>}<details className={styles.budgetDetails}><summary>最近发现地址的处理状态（仅域名与记录 ID）</summary>{recentUrls.length ? <ul className={styles.recent}>{recentUrls.map(item => <li key={item.id} className={styles.run}><div className={styles.runHeader}><h3>{item.host ?? "未记录来源域名"}</h3><Badge attention={item.status === "failed" || item.status === "needs_review"}>{item.status === "completed" ? "处理完成" : item.status === "needs_review" ? "结果待确认" : item.status === "pending" ? "待处理" : "处理失败"}</Badge></div><dl className={styles.facts}><div><dt>记录 ID</dt><dd className={styles.mono}>{item.id}</dd></div><div><dt>最近尝试</dt><dd>{dateText(item.lastAttemptAt)}</dd></div><div><dt>最近完成</dt><dd>{dateText(item.lastCompletedAt)}</dd></div>{item.errorCode && <div><dt>错误代码</dt><dd className={styles.mono}>{diagnostic(item.errorCode)}</dd></div>}</dl>{item.status === "needs_review" && <p className={styles.caption}>模型结果尚未确定；请先查看发现运行结果。该地址不会自动再次调用，需要重试时在来源管理中明确建立新运行。</p>}</li>)}</ul> : <Empty>暂无发现地址的处理记录。</Empty>}</details></section>;
}
function NextSteps({ dashboard }: { dashboard: BackendDashboard }) {
  const steps: string[] = [];
  const unconfigured = dashboard.services.filter(service => !service.configured);
  if (unconfigured.length) steps.push(`尚未配置：${unconfigured.map(service => serviceNames[service.id].name).join("、")}。按需要补齐配置，再从对应功能核对真实运行结果。`);
  const affected = dashboard.workers.filter(worker => worker.configured && ["not_started", "failed", "stale", "stopped"].includes(worker.status));
  if (affected.length) steps.push(`${affected.map(worker => workerNames[worker.kind]).join("、")}尚无有效心跳。检查常驻 worker 进程与错误代码，再刷新状态。`);
  if (dashboard.aiBudget.unknownFeeAttempts || dashboard.aiBudget.unverifiedUsageAttempts) steps.push("存在费用未知或用量未核验的调用；先核对账本与供应商用量，避免把未知费用按零处理或重复尝试。");
  if (dashboard.discovery.phase === "paused") steps.push("自动发现当前暂停。前往采集管理核对暂停原因、额度与运行条件。");
  if (dashboard.inspiration.configured && ["paused", "limited", "attention"].includes(dashboard.inspiration.phase)) steps.push("灵感更新当前暂停、额度不足或存在待核对结果。先检查独立账本和错误类别，再决定是否恢复；未知调用不得自动重发。");
  const waiting = (dashboard.reviews.events.pending ?? 0) + (dashboard.reviews.resources.pending ?? 0);
  if (waiting) steps.push(`赛事与资源合计 ${integer(waiting)} 条待审核。前往采集管理，依据原文核对后再发布。`);
  if (!steps.length) steps.push("当前快照没有上述配置或心跳提醒。继续从任务与审核记录核对实际结果；配置完整不能替代外部调用验证。");
  return <aside className={styles.guidance}><h3>下一步</h3><ul>{steps.map(step => <li key={step}>{step}</li>)}</ul><p style={{ marginTop: 16 }}><Link href="/admin" className={styles.link}>去采集管理</Link></p></aside>;
}

export function BackendDashboardClient() {
  const dashboard = useApi<BackendDashboard>("/admin/backend-dashboard");
  const [automatic, setAutomatic] = useState(false);
  const current = useRef({ loading: dashboard.loading, error: dashboard.error, reload: dashboard.reload });
  const refreshing = useRef(false);
  current.current = { loading: dashboard.loading, error: dashboard.error, reload: dashboard.reload };
  const denied = dashboard.error instanceof ApiError && [401, 403].includes(dashboard.error.status);
  const unauthenticated = dashboard.error instanceof ApiError && dashboard.error.status === 401;
  async function refresh() {
    if (refreshing.current || current.current.loading) return;
    refreshing.current = true;
    try { await current.current.reload(); } finally { refreshing.current = false; }
  }
  useEffect(() => {
    if (!automatic) return;
    const timer = window.setInterval(() => {
      const value = current.current;
      if (document.visibilityState !== "visible" || value.loading || refreshing.current || value.error instanceof ApiError && [401, 403].includes(value.error.status)) return;
      void refresh();
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [automatic]);
  const snapshot = denied ? null : dashboard.data;
  return <SiteShell><PageTitle eyebrow="运营 · 后端服务" title="后端服务控制台"><p>从配置、心跳、队列与账本读取真实状态。仅管理员可访问，读取不会发起外部服务测试。</p></PageTitle><div className={styles.dashboard}>
    {unauthenticated ? <section className={styles.access}><h2>登录后查看后端状态</h2><p>此控制台只向管理员开放。登录后由服务器核对当前权限。</p><Link href="/login?returnTo=%2Fadmin%2Fservices" className={styles.button}>前往登录</Link></section> : denied ? <section className={styles.access}><h2>需要管理员权限</h2><p>当前账号无法读取后端控制台。普通成员与审核员不具备此权限；每次读取都会由服务器重新检查。</p><Link href="/admin" className={styles.linkButton}>返回运营入口</Link></section> : <>
      <div className={styles.toolbar}><div className={styles.actions}><button type="button" className={styles.button} onClick={() => void refresh()} disabled={dashboard.loading}>{dashboard.loading ? "正在读取…" : "刷新状态"}</button><label className={styles.check}><input type="checkbox" checked={automatic} onChange={event => setAutomatic(event.target.checked)} />每 15 秒自动读取</label></div><Link href="/admin" className={styles.link}>去采集管理</Link><p className={styles.muted}>页面在后台时暂停自动读取；状态刷新只发送 GET 请求，暂停与恢复由管理员点击执行。</p></div>
      <Feedback error={dashboard.error} />{dashboard.loading && !snapshot && <Loading />}
      {dashboard.error && snapshot && <p className={styles.stale} role="status">本次读取失败。下方仍是 {sampleTime(snapshot.generatedAt)} 的上次成功快照，当前状态可能已变化。</p>}
      {snapshot && <><section className={styles.snapshot}><div><h2>{dashboard.error ? "上次成功快照" : "已保存的运行状态"}</h2><p>任务与心跳来自数据库；配置状态不等于供应商在线。</p></div><div><div className={styles.snapshotLabel}>采样时间</div><time dateTime={snapshot.generatedAt}>{sampleTime(snapshot.generatedAt)}</time></div></section><ServiceCards services={snapshot.services} provider={snapshot.discovery.provider} /><div className={styles.columns}><Workers workers={snapshot.workers} /><Queues queues={snapshot.queues} /></div><Budgets dashboard={snapshot} /><DiscoveryCoverage dashboard={snapshot} /><InspirationOperations dashboard={snapshot} reload={refresh} disabled={dashboard.loading || Boolean(dashboard.error)}/><DiscoveryFlow dashboard={snapshot} />{snapshot.discovery.provider === "official_sources" && <section className={styles.panel}><h2>本次采集覆盖的官方来源</h2><p className={styles.caption}>仅检查这些官网列表；不代表覆盖全网。来源可达性和页面规则会影响采集结果。</p><ul>{snapshot.discovery.sources.map(source=><li key={source.url}><a className={styles.link} href={source.url} target="_blank" rel="noopener noreferrer">{source.name}（新窗口）</a></li>)}</ul></section>}<RecentTasks queues={snapshot.queues} recentUrls={snapshot.discovery.recentUrls} /><section className={styles.panel}><SectionHeading index="07" title="人工核验与纠错" caption="状态计数，均为数据库当前库存" /><div className={styles.queueGroups}><CountGroup title="赛事审核" counts={snapshot.reviews.events} /><CountGroup title="资源审核" counts={snapshot.reviews.resources} /><CountGroup title="统一纠错" counts={snapshot.reviews.corrections} /></div></section><NextSteps dashboard={snapshot} /></>}
      {!dashboard.loading && !dashboard.error && !snapshot && <Empty>尚未取得状态快照，请点击刷新状态。</Empty>}
    </>}
  </div></SiteShell>;
}


