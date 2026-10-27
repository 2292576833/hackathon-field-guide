# 竞品调研：JUDGELAYER / Synnovator / H@ckollab

- 调研日期：2026-10-15（UTC）
- 调研方式：**只读**。未安装依赖、未运行任何仓库代码、未执行构建、未 clone。
- 取证路径：
  1. `https://api.github.com/repos/<owner>/<repo>`（仓库元数据、文件树）
  2. `https://raw.githubusercontent.com/<owner>/<repo>/<branch>/<path>`（源码原文，**无 API 配额**）
  3. `https://github.com/<owner>/<repo>/commits/<branch>`（提交活跃度）
- 重要过程说明：本次调研中 `api.github.com` 匿名配额（60 次/小时）中途耗尽，一度全部返回 403。**已改用 `raw.githubusercontent.com` 完成全部代码取证**，因此下文代码证据均为真实原文，不是"因 403 判定仓库不存在"。尝试过但超时/失败的路径见文末"未能确认项"。

---

## 0. 三句话结论

| 竞品 | 核心机制一句话 | 与我们最相关的能力 |
| --- | --- | --- |
| **JUDGELAYER** | 自托管的"提交 + 评审"专用系统，靠**后端硬隔离（评委互盲 403）+ Z-score 打分标准化 + 追加式审计日志**换取结果可辩护性 | Z-score 公式与评委隔离做法**可直接借鉴** |
| **Synnovator** | AI 原生平台，**把 GitHub Issue/PR 当作数据库**，用 22 个 GitHub Actions 实现报名/NDA/评分/组队/状态机的全自动化 | Issue/PR 流程状态机、标签体系、评分校验工作流 |
| **H@ckollab** | 面向学生的协作平台，**"技能匹配"实际只是 SQL 硬过滤 + 前端字符串过滤**，无任何匹配算法 | 反面教材：匹配数据模型可抄，匹配算法**不可抄（根本没有）** |

---

# 一、JUDGELAYER

## 1.1 产品身份

| 项 | 值 | 证据 |
| --- | --- | --- |
| 仓库 | `Tanya-garg10/JUDGELAYER-Self-Hosted-Hackathon-Submission-Judging-Platform` | `https://api.github.com/repos/Tanya-garg10/JUDGELAYER-Self-Hosted-Hackathon-Submission-Judging-Platform` |
| 官网/演示 | `https://judgelayer-self-hosted-hackathon.onrender.com/` | 同上 `homepage` 字段；`README.md` L14 |
| 许可协议 | **MIT**（`spdx_id: MIT`） | API `license` 字段；`LICENSE` 文件 1080 字节 |
| 语言 | TypeScript | API `language` |
| Star / Fork / Issue | **2 star / 0 fork / 0 open issue** | API 字段 |
| 创建 / 最后推送 | 2026-09-28 创建，**2026-09-29 最后推送**（`pushed_at: 2026-09-29T18:50:28Z`） | API 字段 |
| 仓库体积 | 180 KB，47 个文件（`truncated=false`） | `git/trees/HEAD?recursive=1` |
| 提交活跃度 | 共 **12 次提交**，集中在 **2026-09-28 ~ 09-30 三天** | commits 页内嵌 JSON `shortMessage` / `committedDate` |
| 最近提交 | `docs: add live demo and demo video links to README`（2026-09-30）、`fix: add judge_c seed user, wipe stale persistent data on startup`、`fix: upsert+dedupe seed users on every load to fix stale persistent data 403` | 同上 |
| 定位一句话 | "The open-source operating system for hackathon submissions, judging, normalization, and defensible results."（开源的赛事提交/评审/标准化/可辩护结果操作系统） | `README.md` L4 |
| 背景 | 为 **DOGFOOD 2026** 黑客松挑战赛而建 | `README.md` L6；`.dogfood.toml` |

> **活跃度判断**：这是一个**比赛冲刺型仓库**——3 天内 12 次提交后停更（截至调研日 2026-10-15 已 16 天无推送）。不是长期维护项目，但代码量与文档完成度高。

## 1.2 架构与数据模型

### 目录结构（`recursive=1` 实测，共 47 文件）

```
.dogfood.toml              # 验收测试运行器配置
.env.example
ARCHITECTURE.md            # 技术与安全架构
DATA-MODEL.md              # Schema 与关系模型
JUDGING.md                 # 评分方法学 / 标准化引擎公式
LICENSE  README.md  spec.md
acceptance-report.txt      # 7/7 验收断言报告
context.txt (29KB)  fixtures.json (46KB)  metadata.json
data/judgelayer.sqlite (184KB)
example.dogfood.toml  index.html  package.json  render.yaml  run.py
server.ts                  # 43KB 单文件 Express 后端（核心）
src/
  App.tsx  api.ts  types.ts  main.tsx  index.css
  components/  AssignmentMatrix.tsx  CommandPalette.tsx  EdgeAlerts.tsx
               Navigation.tsx  ProjectSubmissionModal.tsx
               SplitReviewRoom.tsx  TrustLayerModal.tsx
  views/       AuditTrailView.tsx  ExportCenterView.tsx  GalleryView.tsx
               HeroOverviewView.tsx  JudgeConsoleView.tsx  OrganizerView.tsx
               ParticipantView.tsx  ResultsView.tsx
```

> **注意**：`README.md` L126–139 的架构图里列了 `src/components/RubricReviewPanel.tsx`、`src/views/ParticipantDashboardView.tsx`、`src/store/`，但实测文件树中**这三个路径不存在**（实际是 `SplitReviewRoom.tsx` / `ParticipantView.tsx`，且无 `src/store/` 目录）。README 与代码有轻微不一致。

### 数据模型（`DATA-MODEL.md`）

8 张表：`Event` / `Track` / `Team` / `TeamMember` / `Project` / `Judge` / `JudgeAssignment` / `Score` / `AuditLog`。

关键字段（`DATA-MODEL.md` L60–84）：

```
Score:  functionality(30%) quality(25%) innovation(25%) impact(20%)
        全部 number 1..5；comment；status: draft | submitted
Project: repo_url, demo_url, submitted_at, status: draft|submitted|withdrawn, is_duplicate (boolean)
User:   role enum: organizer | judge | participant | visitor ; token(明文) ; judge_id
Event:  status: open|closed|judging|concluded ; results_published ;
        review_target_per_project (默认 3)
AuditLog(id, timestamp, actor_id, actor_name, action, resource_type,
         resource_id, status: SUCCESS|BLOCKED_403|ENFORCED, details)
```

### 持久化方式（重要局限）

`server.ts` L163–174：

```typescript
function savePersistentData() {
  const dataDir = process.env.DATA_PATH || path.resolve(__dirname, 'data');
  ...
  const persistentPath = path.resolve(dataDir, 'judgelayer-data.json');
  try {
    fs.writeFileSync(persistentPath, JSON.stringify(db, null, 2));
  } catch (err) { ... }
}
```

**JUDGELAYER 没有真正的数据库。** 状态是**内存里的 JS 对象** `db`，每次写操作后用 `fs.writeFileSync` 把**整个 db 序列化成一个 JSON 文件**。`ARCHITECTURE.md` L30–32 也明确写 "State Store Engine (fixtures.json + Memory)"。

- 仓库里存在的 `data/judgelayer.sqlite`（184 KB）**不是运行时使用的数据库**——`package.json` 里**没有任何 sqlite 依赖**（见 1.5），`server.ts` 中也无 sqlite 引用。
- 启动时还会**主动删除**旧持久化文件（`server.ts` L140–146）：`fs.unlinkSync(persistentPath)`，注释写 `Cleared stale persistent data — will rebuild from fixtures.json.`。**这意味着容器重启会丢数据**，只能从 `fixtures.json` 重建。这是演示型设计，不是生产可用设计。

### API 路由清单（`server.ts` 实测全部 25 条）

| 方法 | 路径 | 鉴权 |
| --- | --- | --- |
| GET | `/api/health` | 公开 |
| GET | `/api/session` | 公开 |
| POST | `/api/auth/switch` | 公开（演示用身份热切换） |
| GET | `/api/event` | 公开 |
| PATCH | `/api/event` | `requireRole(['organizer'])` |
| GET | `/api/tracks` | 公开 |
| GET | `/api/teams` | 公开 |
| GET | `/api/projects` | 公开 |
| GET | `/api/projects/:id` | 公开 |
| POST | `/api/projects` | `requireRole(['participant','organizer'])` + 截止期校验 |
| PATCH | `/api/projects/:id` | `requireRole(['participant','organizer'])` |
| GET | `/api/judge/projects` | `requireRole(['judge','organizer'])` |
| **GET** | **`/api/judge/scores`** | **手写隔离逻辑（见 1.3.1）** |
| POST | `/api/judge/scores` | `requireRole(['judge','organizer'])` + 分配校验 |
| GET | `/api/organizer/dashboard` | `requireRole(['organizer'])` |
| GET | `/api/organizer/assignments` | `requireRole(['organizer'])` |
| POST | `/api/organizer/assignments` | `requireRole(['organizer'])` |
| GET | `/api/results` | 公开 |
| POST | `/api/organizer/publish` | `requireRole(['organizer'])` |
| GET | `/api/export.csv` | 手写 organizer 校验（L1084 记录 `BLOCKED_403`） |
| GET | `/api/audit` | 公开读取审计日志 |
| POST | `/api/audit/probe` | 公开（**交互式渗透探针**，见 1.3.4） |
| POST | `/api/reset` | `requireRole(['organizer'])` |
| GET | `*` | SPA 兜底 |

## 1.3 防作弊机制（代码级证据）

### 1.3.1 评委互盲 / 角色隔离 —— `server.ts` L729–805

这是 JUDGELAYER 最值得抄的一段。**关键点：不在前端隐藏，而是在后端硬拒绝并留痕。**

```typescript
app.get('/api/judge/scores', (req, res) => {
  if (!req.user) { return res.status(401).json({ ... }); }

  // ACCEPTANCE CHECK 6: Participant role block
  if (req.user.role === 'participant') {
    addAuditLog({
      actor_id: req.user.id,
      actor_name: `${req.user.name} (Participant)`,
      action: 'PARTICIPANT_JUDGE_ACCESS_BLOCKED',
      resource_type: 'judge_scores', resource_id: 'all',
      status: 'BLOCKED_403',
      details: 'Participant attempted to query judging API. Access denied.',
    });
    return res.status(403).json({ error: 'FORBIDDEN', code: 'ROLE_ACCESS_DENIED', ... });
  }

  const currentJudgeId = req.user.judge_id;
  const requestedJudgeId = req.query.judge as string | undefined;

  // ACCEPTANCE CHECK 5: Peer Isolation Boundary
  if (req.user.role === 'judge') {
    if (requestedJudgeId && requestedJudgeId !== currentJudgeId) {
      addAuditLog({
        actor_id: req.user.id,
        actor_name: `${req.user.name} (Judge)`,
        action: 'PEER_ISOLATION_BOUNDARY_PROBED',   // ← 关键审计动作名
        resource_type: 'judge_scores',
        resource_id: requestedJudgeId,
        status: 'BLOCKED_403',
        details: `Judge '${currentJudgeId}' attempted to inspect ballot of peer judge '${requestedJudgeId}'. Blocked by backend isolation middleware.`,
      });
      return res.status(403).json({
        error: 'FORBIDDEN', code: 'PEER_SCORE_ACCESS_DENIED',
        message: `Forbidden: Judge '${currentJudgeId}' cannot view peer scores for '${requestedJudgeId}'. Isolation is strictly enforced.`,
      });
    }
    const myScores = db.scores.filter(s => s.judge_id === currentJudgeId);  // 只返回自己的
    return res.json(myScores);
  }
  // Organizer 可看全部
  if (req.user.role === 'organizer') { ... }
});
```

配套的通用 RBAC 中间件在 `server.ts` L252–291（`requireAuth` / `requireRole`）：

```typescript
return res.status(403).json({
  error: 'FORBIDDEN', code: 'ROLE_ACCESS_DENIED',
  message: `Forbidden: Your current role (${req.user.role}) is not authorized to access this resource. Requires: ${allowedRoles.join(', ')}.`,
});
```

**设计要点（可直接抄）**：
1. 判据是 **`req.user.role` 与 `req.user.judge_id` 的服务端事实**，不接受客户端传入的身份。
2. 越权尝试**不是静默 403，而是写审计日志**，动作名常量化为 `PEER_ISOLATION_BOUNDARY_PROBED`，便于后续做异常行为统计（谁在探测边界）。
3. 参与者访问评审接口也会留痕（`PARTICIPANT_JUDGE_ACCESS_BLOCKED`）。
4. `ARCHITECTURE.md` L101 明确设计立场：**"Hiding the score on the client side is treated as invalid; the API hard-rejects the request with HTTP 403."**（前端隐藏视为无效，必须后端硬拒。）

### 1.3.2 认证实现（**这是弱项，我们要做得更好**）—— `server.ts` L223–249

```typescript
app.use((req, res, next) => {
  const cookies = parseCookies(req.headers.cookie);
  const cookieSession = cookies['session'];
  const authHeader = req.headers.authorization;
  let bearerToken = null;
  if (authHeader) { bearerToken = authHeader.startsWith('Bearer ') ? authHeader.substring(7).trim() : authHeader.trim(); }
  const customHeaderToken = req.headers['x-session-token'];
  const queryToken = req.query.token as string | undefined;

  const resolvedToken = cookieSession || bearerToken || customHeaderToken || queryToken || null;
  if (resolvedToken) {
    const matchedUser = db.users.find(u => u.token === resolvedToken || u.id === resolvedToken || u.judge_id === resolvedToken);
    ...
```

问题：**Session token 是静态明文常量**，直接写在 `README.md` L85–92（`session_organizer_sec_991`、`session_judge_a_ada_102` …），登录逻辑是 `db.users.find(u => u.token === resolvedToken)` —— **不是比对哈希，而是明文相等**。`DATA-MODEL.md` L39 也把 `token` 描述为 "Secret session token"。此外还接受 `?token=` **URL query 传令牌**（会进浏览器历史/日志）。这是**演示系统的取舍**（为可测试性），不是可上生产的鉴权。

> 我们的 Auth 模块（M01）**必须**用哈希化令牌 + 过期 + HttpOnly + 不接受 query 传令牌。这是我们能明显超越的点。

### 1.3.3 审计日志（追加式 + 有上限）—— `server.ts` L178–199

```typescript
function addAuditLog(entry: {
  actor_id: string; actor_name: string; action: string;
  resource_type: string; resource_id: string;
  status: 'SUCCESS' | 'BLOCKED_403' | 'ENFORCED'; details: string;
}) {
  const logEntry = {
    id: `aud_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    timestamp: new Date().toISOString(),
    ...entry,
  };
  db.audit_logs.unshift(logEntry);
  if (db.audit_logs.length > 200) { db.audit_logs.pop(); }   // ← 只保留 200 条
  savePersistentData();
  return logEntry;
}
```

审计动作常量（实测贯穿 `server.ts`）包括：`SCORE_SUBMITTED`、`PEER_ISOLATION_BOUNDARY_PROBED`、`PARTICIPANT_JUDGE_ACCESS_BLOCKED`、`DEADLINE_VIOLATION_REJECTED`、`CSV_EXPORTED`。

**注意差距**：文件名叫 "append-only tamper-evident"（`DATA-MODEL.md` L75），但实现是**内存数组 + `unshift` + 超过 200 条 `pop`**，并且可被 `POST /api/reset` 清空。**它不是防篡改的**（无哈希链、无签名、无只追加存储）。这是一个"名不副实"的点，我们在文档里要避免同样的夸大。

### 1.3.4 交互式渗透探针 —— `server.ts` L1157–1213

`POST /api/audit/probe` 提供**一键触发越权尝试**，用来自证隔离有效：

```typescript
if (probeType === 'peer_isolation') {
  addAuditLog({
    ...
    action: 'PEER_ISOLATION_BOUNDARY_PROBED',
    status: 'BLOCKED_403',
    details: 'Interactive probe: Judge B attempted to retrieve ballots belonging to Judge A. Backend rejected with HTTP 403 Forbidden.',
  });
  return res.status(403).json({ ... });
}
```
另有 participant 访问评审、截止期后提交两种探针。

> 这个"**可演示的自证清白**"设计很有传播力，成本极低，值得我们借鉴（详见"值得抄"第 3 条）。

### 1.3.5 查重 —— **【重要修正】没有实现真实查重**

`JUDGING.md` L52–55 声称：

> **Duplicate Submissions** — Trigger: Detected via **Levenshtein title similarity (>85%)** or identical repository URLs.

但在 `server.ts` 全文中检索 **没有任何 Levenshtein / 编辑距离 / 相似度实现**（实测 `grep 'levenshtein'` 零命中，仅 `JUDGING.md` 文档提到）。实际代码只是**读取一个已存在的布尔标记**：

```typescript
// server.ts L888
const duplicates = db.projects.filter(p => p.is_duplicate);
// server.ts L365 / L1031
isDuplicate: proj.is_duplicate || false,
```

而 `is_duplicate` 是**从 `fixtures.json` 预置进来的静态字段**（`DATA-MODEL.md` L53 描述为 "Flag identifying accidental duplicate submissions"）。

**结论：JUDGELAYER 的查重是文档承诺、未实现（或仅人工预置标记）。** 我们若实现真实的提交指纹（仓库 URL 归一化 + 标题相似度 + 文件哈希）即可直接超越。

### 1.3.6 截止期硬校验 —— `ARCHITECTURE.md` L105–115

```typescript
// 1. now = new Date()  2. deadline = new Date(event.submissions_close)
// 3. 若 now > deadline → 403 / 400，error code: DEADLINE_EXPIRED
//    并记录审计事件 DEADLINE_VIOLATION_REJECTED
```
配合验收报告 CHECK 3（`acceptance-report.txt` L23–32）实测返回 `403 DEADLINE_EXPIRED`。

## 1.4 ★ Z-score 评分标准化：公式与实现位置（本次核心交付）

### 文档侧公式 —— `JUDGING.md` L14–41

原始分（4 项加权）：

```
RawScore = 0.30·F + 0.25·Q + 0.25·I + 0.20·M      （F/Q/I/M 均为 1.0–5.0）
```

**Step 1 — 评委校准参数**（对评委 j，需 N_j ≥ 2 份已提交评分）：

```
μ_j = (1/N_j) · Σ_k S_{j,k}
σ_j = sqrt( (1/N_j) · Σ_k (S_{j,k} − μ_j)² )
若 σ_j < 0.15 → 判定"分数压缩"(Score Compression Detected)，在主办方控制台标红，
                并限制方差稳定（避免出现无穷大 z-score）
```

**Step 2 — Z-score 标准化**（评委 j 给项目 p 的原始分 S_{j,p}）：

```
Z_{j,p} = (S_{j,p} − μ_j) / max(σ_j, 0.25)
```

**Step 3 — 重标定回 1–5 分布**（用全局均值/标准差）：

```
S_norm_{j,p} = clamp( μ_global + Z_{j,p} · σ_global , 1.0 , 5.0 )
```

**项目聚合分**（对项目 p 的评委集合 J_p 取算术平均）：

```
S_p = (1/|J_p|) · Σ_{j ∈ J_p} S_norm_{j,p}
```

### 代码侧实现 —— **`server.ts` L294–382，函数 `calculateScoresAndNormalization()`**

这是公式的**唯一真实实现**（`server.ts` L296–382）：

```typescript
function calculateScoresAndNormalization() {
  const submittedScores = db.scores.filter(s => s.status === 'submitted');
  const judgeStats: Record<string, { count: number; mean: number; std: number; rawScores: number[] }> = {};

  // (1) 每个 ballot 先算加权综合分
  const judgeGroup: Record<string, number[]> = {};
  for (const s of submittedScores) {
    const composite = (0.3 * s.functionality) + (0.25 * s.quality) + (0.25 * s.innovation) + (0.2 * s.impact);
    s._composite = Math.round(composite * 100) / 100;
    if (!judgeGroup[s.judge_id]) judgeGroup[s.judge_id] = [];
    judgeGroup[s.judge_id].push(s._composite);
  }

  // (2) 每个评委的 mean / std
  let allScoresList: number[] = [];
  for (const [judgeId, arr] of Object.entries(judgeGroup)) {
    allScoresList.push(...arr);
    const mean = arr.reduce((acc, v) => acc + v, 0) / arr.length;
    const variance = arr.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / (arr.length || 1);
    const std = Math.sqrt(variance);
    judgeStats[judgeId] = { count: arr.length,
                            mean: Math.round(mean * 100) / 100,
                            std: Math.round(std * 100) / 100, rawScores: arr };
  }

  // (3) 全局 mean / std（带默认值兜底）
  const globalMean = allScoresList.length ? allScoresList.reduce((a, b) => a + b, 0) / allScoresList.length : 4.0;
  const globalVar  = allScoresList.length ? allScoresList.reduce((a, b) => a + Math.pow(b - globalMean, 2), 0) / allScoresList.length : 0.5;
  const globalStd  = Math.sqrt(globalVar) || 0.5;

  // (4) 逐 ballot 算 Z-score 并重标定
  const projectBallots: Record<string, { raw: number[]; normalized: number[]; comments: string[] }> = {};
  for (const s of submittedScores) {
    const jStat = judgeStats[s.judge_id] || { mean: globalMean, std: globalStd };
    const effectiveStd = Math.max(jStat.std, 0.25);                 // ← 公式里的 max(σ_j, 0.25)
    const zScore = (s._composite - jStat.mean) / effectiveStd;      // ← Z_{j,p}
    let norm = globalMean + (zScore * globalStd);                   // ← 重标定
    norm = Math.max(1.0, Math.min(5.0, norm));                      // ← clamp(1.0, 5.0)
    s._normalized = Math.round(norm * 100) / 100;

    if (!projectBallots[s.project_id]) projectBallots[s.project_id] = { raw: [], normalized: [], comments: [] };
    projectBallots[s.project_id].raw.push(s._composite);
    projectBallots[s.project_id].normalized.push(s._normalized);
    if (s.comment) projectBallots[s.project_id].comments.push(s.comment);
  }

  // (5) 项目聚合分 = 标准化分算术平均；排序：先 normalizedScore 后 rawScore 破平
  const projectSummaries = db.projects.map(proj => {
    const ballots = projectBallots[proj.id] || { raw: [], normalized: [], comments: [] };
    const reviewsCount = ballots.raw.length;
    const rawAvg  = reviewsCount > 0 ? ballots.raw.reduce((a, b) => a + b, 0) / reviewsCount : 0;
    const normAvg = reviewsCount > 0 ? ballots.normalized.reduce((a, b) => a + b, 0) / reviewsCount : 0;
    return {
      id: proj.id, title: proj.title, track_id: proj.track_id, team_id: proj.team_id,
      repo_url: proj.repo_url, demo_url: proj.demo_url,
      reviewsCount,
      targetReviews: db.event.review_target_per_project || 3,
      coveragePercent: Math.min(100, Math.round((reviewsCount / (db.event.review_target_per_project || 3)) * 100)),
      rawScore: Math.round(rawAvg * 100) / 100,
      normalizedScore: Math.round(normAvg * 100) / 100,
      isDuplicate: proj.is_duplicate || false,
      feedbackCount: ballots.comments.length,
    };
  });

  projectSummaries.sort((a, b) => {
    if (b.normalizedScore !== a.normalizedScore) return b.normalizedScore - a.normalizedScore;
    return b.rawScore - a.rawScore;   // 破平
  });

  return { judgeStats, globalMean: Math.round(globalMean * 100) / 100,
           globalStd: Math.round(globalStd * 100) / 100, projectSummaries };
}
```

**调用点**（3 处，均为实时计算而非落库）：
- `server.ts` L867 → `GET /api/organizer/dashboard`
- `server.ts` L1017 → `GET /api/results`（L1027 输出 `normalizedScore`）
- `server.ts` L1121 → `GET /api/export.csv`（L1122 表头 `Rank,Project ID,Title,Track,Team,Normalized Score,Raw Score,Reviews Count,Coverage %`，L1126 写行）

### 分数压缩检测实现 —— `server.ts` L890–902

```typescript
// 3. Score compression (judges with near-zero standard deviation across multiple scores)
const compressedJudges = Object.entries(normData.judgeStats)
  .filter(([_, stat]) => stat.count >= 3 && stat.std < 0.15)   // ← 阈值 0.15，且至少 3 份
  .map(([judgeId, stat]) => {
    const judgeObj = db.users.find(u => u.judge_id === judgeId);
    return { judgeId, name: judgeObj?.name || judgeId,
             scoreCount: stat.count, mean: stat.mean, std: stat.std };
  });
```

### 未完成评审批次检测 —— `server.ts` L877–885

```typescript
const incompleteProjects = normData.projectSummaries
  .filter(p => p.reviewsCount < (db.event.review_target_per_project || 3))
  .map(p => ({ id: p.id, title: p.title, reviewsCount: p.reviewsCount,
               target: db.event.review_target_per_project || 3 }));
```

### 我对该公式的**评审意见（我们实现时必须改）**

1. **`σ_global` 与 `μ_global` 含被标准化者自身** → 轻度自相关，样本小时结果不稳。可接受，但应文档化。
2. **归一化后取算术平均**，会**重新引入一部分评委偏差**（把标准化分拉回全局尺度后再平均，理论上仍非无偏）。更严谨可用 z 的均值再映射，或用中位数/截尾均值。
3. **未处理评委-项目分配不随机**（谁评谁是主办方指派）。若"严格评委"恰好都评了强队，标准化后仍失真。真解需要**矩阵补全 / IRT（项目反应理论）**。
4. **`N_j ≥ 2` 未在代码中强制**：代码里若某评委只有 1 份评分，`std` 会是 **0**，此时 `effectiveStd = max(0, 0.25) = 0.25`，`zScore = 0`（因为 `S − mean = 0`），该评委给谁都是"全局平均"。**单评分评委的区分度被完全抹平** —— 这正是公式想避免、但边界情况下仍会发生的事。值得我们在实现中显式处理（如 `N_j < 2` 时回退到 raw 分并标记）。
5. **`globalStd = Math.sqrt(globalVar) || 0.5`**：全局方差为 0 时兜底 0.5，属合理防御。

## 1.5 技术栈与部署（JUDGELAYER）

`package.json`（实测原文）：

| 层 | 选型 |
| --- | --- |
| 前端 | React **19.0.1** + ReactDOM 19 + Vite **8.3.0** + `@vitejs/plugin-react` + Tailwind **4.3.3**（`@tailwindcss/vite`）+ `lucide-react` 图标 + `motion` 12（动画） |
| 后端 | **Express 4.21.2**，TypeScript，运行时 **`tsx`** 直跑 `server.ts`（`"dev": "tsx server.ts"`，`"start": "tsx server.ts"`），**无编译产物** |
| 语言 | TypeScript **7.0.2**（devDep），`lint: tsc --noEmit` |
| 数据库 | **无。** 内存对象 + `fs.writeFileSync` 全量 JSON 快照 |
| 部署 | Render（`render.yaml`）+ 可选 Vercel 前后端分离（需自行配 CORS）；Node ≥ 18 |
| 其他 | `openai` ^4.104.0（在依赖里，但本次取证的代码中未见调用）、`dotenv` |

`render.yaml`（实测 267 字节）与 README L56–77 说明 Render 免费层一键部署。

---

# 二、Synnovator

## 2.1 产品身份

| 项 | 值 | 证据 |
| --- | --- | --- |
| 仓库 | `Synnovator/monorepo`（description: **"Synnovator is an AI-native Hackathon Platform"**） | `https://api.github.com/repos/Synnovator/monorepo` |
| 许可协议 | **未获取 / API 返回 `license: null`** —— 仓库未声明开源许可证（`README.md` 中也未见许可章节） | API `license` 字段 |
| 官网 | 无（`homepage: null`） | API 字段 |
| 语言 | TypeScript | API `language` |
| Star / Fork / Issue | **0 star / 1 fork / 19 open issues** | API 字段 |
| 创建 / 最后推送 | 2026-03-03 创建，**2026-03-27 最后推送**（`pushed_at: 2026-03-27T11:12:25Z`） | API 字段 |
| 仓库体积 | 2497 KB，**825 个文件**（`truncated=false`） | `git/trees/HEAD?recursive=1` |
| 提交活跃度 | commits 页单页 **35 条**（首页含脚本在内共 190 个 commit 链接），日期跨 **2026-03-17 ~ 03-27**；PR 编号已到 **#113** | commits 页内嵌 JSON |
| 最近提交 | `fix(workflows): @mention PR/issue author on validation failure (#113)`、`Merge pull request #74 ...data/submit-dishuihu-ai-opc-global-challenge-2026-team-onebot`、`Merge pull request #101 ...data/team-join-team-ai-voyager-1774345615` | 同上 |
| 定位一句话 | AI 原生的黑客松平台；**以 GitHub Issue/PR 作为唯一数据层**驱动活动全流程 | 仓库 description + `.github/workflows/` 22 个文件 + `hackathons/` 目录即"数据库" |

> **同前注意**：GitHub 搜索还返回 `H2OSLabs/SynnovatorZero`（"Synnovator Rebuild from Scratch"）、`H2OSLabs/ssd`、`Onesyn-ai/synnovator-*` 等疑似同源/衍生仓库。本次调研**只取 `Synnovator/monorepo`**（description 与"AI 原生黑客松平台"完全匹配）。其他同名仓库未逐一取证，**不排除**同组织还有更活跃的仓库。

## 2.2 架构与数据模型：**文件系统 + GitHub 即数据库**

### 目录结构（实测 825 文件，下述为关键骨架）

```
.github/
  ISSUE_TEMPLATE/   appeal.yml  bug-report.yml  config.yml  feature-request.yml
                    judge-score.yml  nda-sign.yml  register.yml
  workflows/        ← 22 个 Actions，这是整个产品的大脑
    status-update.yml  aggregate-scores.yml  sync-issue-data.yml  sync-team-data.yml
    validate-score.yml  validate-register.yml  validate-nda.yml  validate-team.yml
    validate-submission.yml  validate-hackathon.yml  validate-appeal.yml
    validate-bug.yml  validate-feature.yml  validate-profile.yml  validate-mdx.yml
    team-join-approval.yml  stale.yml  deploy.yml  ci.yml
    claude.yml  claude-code-review.yml  cleanup-preview.yml
apps/web/           ← Next.js 应用（App Router）
  app/(public)/  (auth)/  (admin)/  api/
    api/submit-pr/route.ts (11.7KB)   api/auth/{login,callback,logout,me,dev-login}
    api/admin/{review,theme,visibility}   api/check-profile
  lib/  permissions.ts  github-app.ts  github-url.ts  oklch.ts  static-provider.ts
  scripts/generate-static-data.mjs (16KB)
  wrangler.jsonc   ← Cloudflare Workers 部署
packages/shared/src/
  schemas/  hackathon.ts profile.ts team.ts submission.ts result.ts roles.ts visibility.ts theme.ts
  data/readers/  hackathons.ts profiles.ts teams.ts submissions.ts results.ts
  data/writers/  github-client.ts  pending.ts
  auth/session.ts
packages/ui/src/components/  …（shadcn 风格组件库）
hackathons/          ← ★ "数据库"：每个赛事一个目录
  <slug>/hackathon.yml   ← 赛事定义（slug、timeline、tracks、judges、criteria）
  <slug>/stages/*.mdx    ← 7 个阶段说明
  <slug>/tracks/*.mdx
  <slug>/submissions/<team>/project.yml + README.mdx
  <slug>/results/<track>.json     ← ★ 由 Actions 自动生成
teams/<team-slug>/team.yml
profiles/<username>-<uuid>.yml
config/roles.yml   config/themes/*.yml   docs/（大量规划与验收 spec）
```

### 数据模型 = **YAML 文件 + GitHub Issue**

**赛事定义** `hackathons/<slug>/hackathon.yml`：含 `slug`、`timeline`（7 阶段各 start/end）、`tracks[].judging.criteria[]`（`name` / `weight` / `score_range` / `hard_constraint` / `constraint_rule`）、`judges[].github`。

**个人档案** `profiles/_schema.yml`（60 行，实测原文关键段）：

```yaml
synnovator_profile: "2.0"
hacker:
  github: ""                    # 必填
  name: ""  name_zh: ""  avatar: ""
  team: "team-slug"             # 全局一人一队，由 sync-team-data.yml 写入
  bio: ""  bio_zh: ""
  location: ""  languages: []
  identity:
    type: ""                    # student | professional | academic
    affiliation: ""  degree: ""  major: ""  graduation_year:
  skills:                       # ★ 分类技能列表
    - category: ""              # 如 "AI/ML", "Backend", "Frontend"
      items: []                 # 如 ["PyTorch", "LangChain"]
  interests: []                 # ★ 如 ["AI Agent", "Developer Tools"]
  looking_for:                  # ★ 招募意图（最关键的结构化匹配信号）
    roles: []                   # 如 ["Frontend Developer"]
    team_size: ""               # 如 "3-5"
    collaboration_style: ""     # 如 "async-friendly"
  experience:
    years:
    hackathons: [{name, result, project_url}]
    projects:   [{name, url, description}]
  links: {twitter, linkedin, website}
  judge_profile:                # ★ 评委专属
    available: false
    expertise: []
    conflict_declaration: ""    # PDF URL（利益冲突声明书）
```

**队伍** `teams/<slug>/team.yml`（`teams/_schema.yml`，34 行原文关键段）：

```yaml
synnovator_team: "1.0"
name: ""  name_zh: ""
description: ""  description_zh: ""
github_url: ""
status: recruiting            # ★ 三态：recruiting | formed | disbanded
leader: "github-username"
members:                      # 不含 leader
  - github: ""
    role: developer           # 五值枚举：developer|product|designer|marketing|researcher
    joined_at: "2026-01-15"
looking_for:                  # ★ 仅在 status=recruiting 时有意义
  roles: [researcher, designer]   # HackerRole 枚举数组
  description: ""
hackathons:
  - hackathon: ""  track: ""  registered_at: ""
created_at: ""
```

**结果** `hackathons/<slug>/results/<track>.json`（由 `aggregate-scores.yml` 生成）。

**角色模型** 有两层：
1. `config/roles.yml` —— 实测**只有 51 字节**（内容极简，实际角色定义散落在 `packages/shared/src/schemas/roles.ts` 和 Issue 模板的 dropdown 里）。
2. `packages/shared/src/schemas/roles.ts`（693 字节）+ Issue 模板 `register.yml` 的 `role` dropdown。

## 2.3 ★ GitHub Issue/PR 驱动的流程状态机（本次核心交付）

### 2.3.1 阶段状态机（7 阶段 + ended）—— `.github/workflows/status-update.yml`

**每天 00:00 UTC 定时**（`cron: '0 0 * * *'`）跑一次，也支持手动 `workflow_dispatch`。核心逻辑（原文 L32–45）：

```javascript
const stages = ['draft', 'registration', 'development', 'submission', 'judging', 'announcement', 'award'];

function getCurrentStage(timeline) {
  for (const stage of stages) {
    const range = timeline[stage];
    if (!range) continue;
    const start = new Date(range.start);
    const end = new Date(range.end);
    if (now >= start && now <= end) return stage;
  }
  const lastStage = timeline['award'];
  if (lastStage && now > new Date(lastStage.end)) return 'ended';
  return 'draft';
}
```

**状态如何"落到"每个 Issue 上**（原文 L57–88）——按 `hackathon:<slug>` 标签拉出全部 open issue，**删除旧的 `stage:*` 标签、加上新的**：

```javascript
const { data: issues } = await github.rest.issues.listForRepo({
  owner: context.repo.owner, repo: context.repo.repo,
  labels: `hackathon:${slug}`, state: 'open', per_page: 100,
});

const stageLabel = `stage:${stage}`;
for (const issue of issues) {
  const existingStageLabels = issue.labels.filter(l => l.name.startsWith('stage:')).map(l => l.name);
  if (existingStageLabels.includes(stageLabel)) continue;
  for (const old of existingStageLabels) {
    await github.rest.issues.removeLabel({ ..., name: old }).catch(() => {});
  }
  await github.rest.issues.addLabels({ ..., labels: [stageLabel] });
}
```

> **要点**：状态迁移是**幂等的**（已是目标 stage 就 skip），且**阶段标签唯一**（先摘旧再挂新）。这是一个非常干净的"用标签做状态机"的范式。

### 2.3.2 完整标签体系（实测全部标签字符串）

| 标签 | 含义 | 写入者 |
| --- | --- | --- |
| `hackathon:<slug>` | 归属赛事（所有 issue 的基础标签） | 提交者 / 校验工作流 |
| `stage:draft` … `stage:award`（+ `ended`） | **阶段状态机**（唯一，由定时任务改写） | `status-update.yml` |
| `track:<trackSlug>` | 归属赛道 | `validate-score.yml` |
| `judge-score` | 该 Issue 是评分表（触发校验） | Issue 模板 |
| `score-validated` | **评分已通过校验**（聚合只认这个） | `validate-score.yml` L97/L155 |
| `nda-sign` | 该 Issue 是 NDA 签署 | Issue 模板 |
| `nda-approved` | NDA 已批准 | `sync-issue-data.yml` L246 |
| `register` / `registered` | 报名 / 报名已通过 | `validate-register.yml` L147 |
| `submission` / `judge-score` / `appeal` / `bug-report` / `feature-request` | Issue 类型标签 | 各 Issue 模板 |

> **标签命名约定清晰**：`<维度>:<值>`（`hackathon:`、`stage:`、`track:`），类型标签裸名（`judge-score`），状态标签用过去分词（`registered`、`nda-approved`、`score-validated`）。**值得直接抄。**

### 2.3.3 事件驱动的自动校验流（Issue 一开/一改即触发）

以 `validate-score.yml` 为例（触发条件 `on: issues: types: [opened, edited]`，且 `if: contains(github.event.issue.labels.*.name, 'judge-score')`）：

**校验链（原文 L26–141）**：
1. **标题格式硬校验**：`/\[Score\]\s*(.*?)\s*—\s*(.*?)\s*\/\s*(.*)/` → 必须 `[Score] team-name — hackathon-slug / track-slug`。
2. **赛事存在性**：`hackathons/${slug}/hackathon.yml` 必须存在。
3. **赛道存在性**：`h.tracks.find(t => t.slug === trackSlug)`。
4. **评委授权**：`const judges = (h.judges || []).map(j => j.github); if (!judges.includes(author))` → 拒绝。
5. **利益冲突声明（双重检查）**：
   ```javascript
   if (!profileData?.hacker?.judge_profile?.conflict_declaration) {
     errors.push(`@${author}: Profile is missing \`judge_profile.conflict_declaration\`...`);
   }
   ...
   const conflictChecked = bodyText.includes('[X]') || bodyText.includes('[x]');
   const conflictField = bodyText.includes('conflict_declaration: true');
   if (!conflictChecked && !conflictField) {
     errors.push('Conflict of interest checkbox not checked...');
   }
   ```
   ⚠️ **弱点**：`bodyText.includes('[X]')` 是**全文子串搜索**——正文任何地方（哪怕是引用别人评论、或写个 `[x]` 装饰）都会通过。**没有定位到具体的 checkbox id**。这是可明确超越的点。
6. **重复评分检测**：
   ```javascript
   const duplicate = existingScores.find(i =>
     i.user.login === author && i.title.includes(team.trim()) && i.number !== issue.number);
   if (duplicate) errors.push(`@${author} has already submitted a validated score for team \`${team}\` in issue #${duplicate.number}.`);
   ```
   ⚠️ 用 `title.includes(team)` **子串匹配**——`Team A` 会误命中 `Team AB`。
7. **评分范围校验**：`criterion.score_range || [0,100]`；越界即 error：
   ```javascript
   if (typeof s.score !== 'number' || s.score < range[0] || s.score > range[1]) {
     errors.push(`"${s.criterion}": score ${s.score} outside range [${range[0]}, ${range[1]}]`);
   }
   ```
8. **未知评分项拒绝**：`if (!criterion) errors.push(\`Unknown criterion: "${s.criterion}"\`)`。
9. **失败即评论 + 不贴标签；成功即贴 `score-validated` + 评论 ✅**（L143–166）。
10. **硬约束只警告不执行**（L129–134）：只 `warnings.push('...If triggered during aggregation, this score will be set to 0.')`。

### 2.3.4 ★ 评分聚合（`aggregate-scores.yml`，每天 01:00 UTC）

**只有在 `judging` / `announcement` / `award` 阶段才聚合**（L47–57）。

**输入**：标签为 `score-validated,hackathon:${slug},track:${trackSlug}` 的 issue（L65–71）。
**从 Issue 标题提取队名**：`issue.title.match(/\[Score\]\s*(.*?)\s*—/)`；**从正文 ```` ```yaml ```` 代码块提取评分**（L84–96）。

**加权计算 + 聚合（L111–165）**：

```javascript
for (const s of entry.scores) {
  const criterion = criteria.find(c => c.name === s.criterion);
  if (!criterion) continue;
  let weightedScore = s.score * (criterion.weight / 100);   // ★ 权重在赛道定义里
  ...
  judgeTotal += weightedScore;
}

// Expert score = mean of all judge totals
const expertScore = judgeDetails.reduce((sum, j) => sum + j.total, 0) / judgeDetails.length;

// Final score (expert_only for P1; expert_plus_vote handled below)
let finalScore = expertScore;
let voteScore = null;
// TODO: expert_plus_vote mode — fetch PR reactions for vote_score   ← ★ 未实现
```

**产出**（L190–201）：写入 `hackathons/<slug>/results/<trackSlug>.json`：
```javascript
const result = {
  track: trackSlug, hackathon: slug, calculated_at: now.toISOString(),
  judging_mode: track.judging?.mode || 'expert_only',
  total_judges: new Set(scoreIssues.map(i => i.user.login)).size,
  total_teams: rankings.length,
  rankings,   // [{team, final_score, expert_score, vote_score, judge_count,
              //   criteria_breakdown, hard_constraint_violations, judge_details, rank}]
};
```
最后 `git add hackathons/*/results/*.json && git commit && git push`（L206–216），提交者 `github-actions[bot]`。

### 2.3.5 ★★ Synnovator 评分机制的关键缺陷（我们必须知道）

**Synnovator 完全没有 Z-score / 评委标准化！** 对比 JUDGELAYER：

| 维度 | JUDGELAYER | Synnovator |
| --- | --- | --- |
| 评委松紧偏差 | **有** Z-score 校准（μ_j, σ_j） | **无**，直接算术平均 `expertScore` |
| 分数压缩检测 | 有（σ_j < 0.15 标红） | **无** |
| 评审完整性检测 | 有（< 3 份告警） | **无显式检测** |
| 硬约束 | 无 | **声明了但未实现**（见下） |
| 并列破平 | 有（rawScore 次级排序） | **无**（仅按 final_score，JS `sort` 不稳定 → 并列名次任意） |

**硬约束"假实现"证据**（`aggregate-scores.yml` L117–124，原文注释）：

```javascript
// Hard constraint enforcement
if (criterion.hard_constraint && criterion.constraint_rule) {
  // For P1: any criterion with hard_constraint=true where
  // the constraint_rule indicates a threshold is checked during
  // final aggregation. Simplified: if score fails constraint,
  // set to 0. The actual rule parsing would need domain logic.
  // For now, we flag it but keep the score (human review needed).
}
```
且输出字段是**硬编码空数组**：`hard_constraint_violations: [],`（L177）。

**评委身份未脱敏**：聚合时 `judgeDetails.push({ judge_id: \`judge-${jIdx + 1}\`, total, criteria })` —— 用**数组下标**当 judge_id，看似匿名，但同一 issue 里 `const judge = issue.user.login;`（L81）保留了真实身份，且 `total_judges: new Set(scoreIssues.map(i => i.user.login)).size` 用的也是真名。**评分结果 JSON 会暴露「哪个 GitHub 用户评了哪个队」**。

**投票分未实现**：`// TODO: expert_plus_vote mode — fetch PR reactions for vote_score`（L168）。

### 2.3.6 AI 原生：`.claude/` 内嵌 AI 运维技能

仓库根有完整的 `.claude/` 目录（`skills/`、`agents/`、`commands/`、`hooks/`），其中与业务直接相关的是：

- `.claude/skills/synnovator-admin/SKILL.md`（10KB）
  - `references/schema-v2.md`（9KB）—— 数据 schema 说明
  - `references/github-api-patterns.md`（4.3KB）
  - `references/watch-issue-prompt.md`（7.7KB）
  - `references/simulate-*.md`（示例与风险手册）
  - `simulate/SKILL.md`、`watch-issue/SKILL.md`
- `.claude/hooks/enforce-tools.sh`、`pre-commit.sh`、`rtk-rewrite.sh`
- `.github/workflows/claude.yml`、`claude-code-review.yml`（**Claude Code 接入 CI**）

> 这是"**AI 原生**"的实际含义：**运维/审核/模拟由 Claude Code 技能驱动**，而不是产品里有 AI 功能。⚠️ 注意区分——`docs/specs/synnovator-prd.md`（53KB）等文档未在本次取证的代码中体现为运行时 AI 能力。

## 2.4 防作弊机制（Synnovator）

| 机制 | 实现 | 证据 |
| --- | --- | --- |
| 利益冲突声明 | Profile 必须含 `judge_profile.conflict_declaration`（PDF URL）；Issue 勾选框 | `validate-score.yml` L63–91 |
| 评委白名单 | `h.judges[].github` 必须包含作者 | `validate-score.yml` L57–61 |
| 重复评分 | 同人 + 同队名子串 + 不同 issue → 报错 | `validate-score.yml` L93–108 |
| 分数范围 | `criterion.score_range \|\| [0,100]` 越界报错 | `validate-score.yml` L124–127 |
| NDA 签署 | `nda-sign.yml` 模板 + `validate-nda.yml` + 批准后 `nda-approved` 标签 | 文件树 + `sync-issue-data.yml` L246 |
| 申诉 | `appeal.yml`（含 `appeal_type`、`expected_result`、证据、"主办方决定为最终"承诺勾选）+ `validate-appeal.yml` | `appeal.yml` 全文 |
| 审计 | **依赖 GitHub 自身**的 issue/PR 时间线与 commit 历史；**无独立审计日志** | `sync-issue-data.yml` |
| 状态防篡改 | `CODEOWNERS`（784 字节）+ PR 流程 + 分支保护（推测） | `.github/CODEOWNERS` |

**关键优势**：因为一切走 GitHub Issue/PR，**审计 = git 历史 + issue 时间线**，天然不可抵赖、天然有 actor 与时间戳。这是**零成本获得审计能力**的聪明做法。

## 2.5 技术栈与部署（Synnovator）

`package.json`（根，302 字节）+ `apps/web/package.json`（1839 字节）+ `apps/web/wrangler.jsonc`：

| 层 | 选型 | 证据 |
| --- | --- | --- |
| Monorepo | **pnpm workspaces + Turborepo**（`pnpm-workspace.yaml`、`turbo.json`、`pnpm-lock.yaml` 377KB） | 文件树 |
| 前端/全栈 | **Next.js App Router** + React + TypeScript（`apps/web/app/(public|auth|admin)/`） | 目录结构 |
| UI | 自建 `packages/ui`（shadcn 风格：`button/card/dialog/dropdown-menu/sidebar/...`）+ 自绘 SVG 图标 | 文件树 |
| 校验 | **Zod**（`packages/shared/src/schemas/*.ts`，含 `__tests__`） | 文件树 |
| 测试 | **Vitest**（`vitest.config.ts`，`__tests__/*.test.ts(x)`） | 文件树 |
| 数据层 | **文件系统 + GitHub API**（`packages/shared/src/data/readers/*` 读 YAML，`writers/github-client.ts` 写 PR）+ `fs-provider.ts` + `static-provider.ts` | 文件树 |
| 部署 | **Cloudflare Workers / OpenNext**（`wrangler.jsonc`、`open-next.config.ts`、`.dev.vars.example`）+ `deploy.yml` | 文件树 |
| 认证 | GitHub OAuth（`api/auth/{login,callback}`）+ `packages/shared/src/auth/session.ts` | 文件树 |
| 国际化 | `packages/shared/src/i18n/{en,zh}.json`（23KB / 22.5KB） | 文件树 |
| AI | `.claude/` 技能 + GitHub Actions `claude.yml` | 文件树 |

---

# 三、H@ckollab

## 3.1 产品身份

| 项 | 值 | 证据 |
| --- | --- | --- |
| 仓库 | `nst-sdc/-H-ckollab`（**注意：仓库名以连字符开头**） | `https://api.github.com/repos/nst-sdc/-H-ckollab` |
| description | "A full-stack collaboration platform that empowers students to effortlessly find and team up with ideal collaborators for hackathons and project-based learning." | API |
| 官网 | `https://h-ckollab.vercel.app/` | API `homepage` |
| 许可协议 | **无（API `license: null`）** | API |
| 语言 | JavaScript | API |
| Star / Fork / Issue | **2 star / 5 fork / 1 open issue** | API |
| 创建 / 最后推送 | 2025-06-12 创建，**2026-02-13 最后推送** | API（`pushed_at: 2026-02-13T17:49:20Z`） |
| 仓库体积 | 3346 KB，104 文件（`truncated=false`） | `git/trees/HEAD?recursive=1` |
| 提交活跃度 | commits 页单页 35 条 / 页面共 176 个 commit 链接；日期跨 **2025-07-18 ~ 2026-02-13**（8 个月以上，间歇提交） | commits 页内嵌 JSON |
| 最近提交 | `Fix project name typo in README`（2026-02-13）、`f`、`bug`、`bugs`、`resolved bugs`、`vv`、`re-` | 同上（**提交信息质量很低**） |
| 组织 | `nst-sdc`（疑似 Newton School SDC 学生社团） | owner |
| 定位一句话 | 面向学生的**基于技能**的协作/组队平台：建开发者档案、发项目、邀请他人入队 | README + 代码 |

## 3.2 架构与数据模型

### 目录结构（实测 104 文件）

```
README.md  Contribution.md  package.json  vercel.json
backend/
  index.js               # Express 入口（2035 B）
  package.json
  drift_fix.sql          # 手工 SQL 补丁（6054 B）
  encoded.txt
  EMAIL_SETUP.md
  controllers/  userController.js (8.7KB)  projectController.js (11.5KB)
                inviteController.js (6.9KB)  interestController.js (2.8KB)
                hackathonController.js (2.8KB)
  routes/       userRoutes.js  projectRoutes.js  inviteRoutes.js
                interestRoutes.js  hackathonRoutes.js
  middleware/   firebaseAuth.js (720 B)
  lib/          emailService.js (9.6KB)  firebaseAdmin.js  prisma.js
  prisma/       schema.prisma (4106 B)
                migrations/20251111114725_init/migration.sql (6243 B)
                seed.js  migration_lock.toml
frontend/
  package.json  (Create React App)
  src/
    App.js  AppRoutes.jsx  index.js  firebase.js
    components/  UserProfileForm.jsx (11.8KB)  PostProjectForm.jsx (9.7KB)
                 InviteModal.jsx  Navbar.jsx (15.3KB)  UserCard.jsx
                 SignIn.jsx  SignUp.jsx  Loader.jsx  ErrorMessage.jsx  Footer.jsx
    pages/       Dashboard.jsx (7.1KB)  Explore.jsx (11.3KB)  ExploreProjects.jsx
                 ExploreHackathons.jsx (9.1KB)  MyProjectsPage.jsx (21.7KB)
                 MyInvites.jsx (7.6KB)  Profile.jsx (13.6KB)  Landing.jsx
                 PostHackathon.jsx  PostProjectPage.jsx  Collaborations.jsx
                 CreateProfile.jsx  Messages.jsx
    context/     AppContext.jsx  UserContext.js  prisma/schema.prisma (436 B, 疑似残留)
    layout/      Layout.jsx
    data/        dummyProjects.js
```

### 数据模型 —— `backend/prisma/schema.prisma`（132 行，实测原文）

**7 个 model + 1 个 enum**：

```prisma
model User {
  id               String   @id @default(cuid())
  name             String
  email            String   @unique
  bio              String?
  githubUrl        String?
  portfolioUrl     String?
  availability     String          // ★ 匹配维度
  academicYear     String?
  branch           String?
  interests        String?         // ★ 自由文本，非结构化
  featuredProjects Json?
  firebaseUid      String   @unique
  discordOrContact String?
  skills           UserSkill[]     // ★ 技能关联
  collaborations   Collaborator[]
  ...
}

model Skill {
  id       String  @id @default(cuid())
  name     String  @unique          // ★ 技能主数据（唯一名）
  category String?                  // ★ 分类（前端写死 4 类）
  users    UserSkill[]
}

model UserSkill {                   // ★ 连接表
  id      String @id @default(cuid())
  userId  String
  skillId String
  level   String                    // ★ 熟练度（Beginner/Intermediate/Advanced）
  skill   Skill  @relation(...)
  user    User   @relation(...)
  @@unique([userId, skillId])
}

model Project {
  id                String   @id @default(uuid())
  title             String
  description       String
  tags              String[]
  techStack         String[]        // ★ 技术栈数组
  maxTeamSize       Int
  status            String   @default("Open")
  creatorId         String
  collaborationType String
  deadline          DateTime?
  difficulty        String          // ★ 难度
  rolesNeeded       String[]        // ★ 需要什么角色  ← 匹配的关键输入
  visibility        String   @default("Open to All")
  inviteStatus      String?  @default("Pending")
  isDeleted         Boolean? @default(false)
  isOpen            Boolean? @default(true)
  collaboratorsV2   Collaborator[]
  invites           Invite[]
  collaborators     User[]   @relation("ProjectCollaborators")
  interestedUsers   User[]   @relation("ProjectInterest")
}

model Invite {
  id          String   @id @default(cuid())
  projectId   String
  senderId    String
  receiverId  String
  role        String        // ★ 邀请的角色（对标 Project.rolesNeeded）
  status      String   @default("pending")
  respondedAt DateTime?
  ...
}

model Collaborator {
  id        String     @id @default(cuid())
  projectId String
  userId    String
  joinedAt  DateTime   @default(now())
  joinedVia JoinMethod   // ★ 加入方式
}

enum JoinMethod { invite   interest }
```

> **数据模型评述**：**这个 schema 本身是好的**——`Skill` 主数据 + `UserSkill(level)` 连接表 + `Project.rolesNeeded[]` + `Invite.role` 构成了一套**理论上可以做匹配**的结构。**问题在于没有任何代码去用它做匹配。**

### API 路由清单（实测全部）

**`backend/index.js`** 挂载：`/api/users`、`/api/projects`、`/api/invites`、`/api/interests`、`/api/hackathons`。

| 文件 | 方法 | 路径 | 鉴权（实测） |
| --- | --- | --- | --- |
| `userRoutes.js` | GET | `/api/users`（支持 `?stack=` 技能过滤） | **无** |
| | GET | `/api/users/:firebaseUid` | **无** |
| | POST/PUT | 建档/更新 | `verifyFirebaseToken` |
| `projectRoutes.js` | POST | `/api/projects` | ✅ `verifyFirebaseToken` |
| | GET | `/api/projects/mine` | ✅ `verifyFirebaseToken` |
| | GET | `/api/projects` | **无**（Explore 公开） |
| | GET | `/api/projects/:id` | **无** |
| | POST | `/api/projects/:projectId/interest` | **❌ 无鉴权**（见 3.4） |
| | PATCH | `/api/projects/:id` | **❌ 无鉴权** |
| | POST | `/api/projects/:id/invite` | ✅ `verifyFirebaseToken` |
| | PATCH | `/api/projects/:id/edit` | ✅ |
| | PATCH | `/api/projects/:id/delete` | ✅ |
| | PATCH | `/api/projects/:id/archive` | ✅ |
| | POST | `/api/projects/accept-interest` | ✅ |
| | DELETE | `/api/projects/:id` | ✅ |
| `inviteRoutes.js` | POST | `/api/invites` | ✅ `verifyFirebaseToken` |
| | GET | `/api/invites/received` | **❌ 无** |
| | GET | `/api/invites/user/:firebaseUid` | **❌ 无** |
| | **PATCH** | **`/api/invites/:inviteId`** | **❌ 无鉴权** |
| | GET | `/api/invites/sent/:senderId` | **❌ 无** |
| | GET | `/api/invites/test-email` | **❌ 无** |
| | GET | `/api/invites/project/:projectId` | **❌ 无** |
| `interestRoutes.js` | POST | `/api/interests` | ✅ `verifyFirebaseToken` |
| | GET | `/api/interests/user/:userId` | **❌ 无** |
| `hackathonRoutes.js` | GET/POST | `/api/hackathons` | 部分（未逐一取证） |

## 3.3 ★ 技能匹配机制：**实测没有任何匹配算法**（本次核心交付）

### 3.3.1 后端"过滤"（不是匹配）—— `backend/controllers/userController.js` L1–51

```javascript
// Get all users with optional skill stack filter
export const getUsers = async (req, res) => {
  try {
    const { stack, page = 1, limit = 0 } = req.query;
    let where = {};

    if (stack) {
      const skillNames = stack.split(",").map((s) => s.trim()).filter(Boolean);
      if (skillNames.length > 0) {
        where.skills = {
          some: { skill: { name: { in: skillNames } } },   // ← SQL IN，精确名匹配
        };
      }
    }

    const take = parseInt(limit, 10) || undefined;
    const skip = take ? (parseInt(page, 10) - 1) * take : undefined;

    const users = await prisma.user.findMany({
      where,
      include: { skills: { include: { skill: true } }, projects: true },
      ...(take && { take }), ...(skip && { skip }),
    });
    res.json(users);
  } catch (error) { ... }
};
```

**这就是所谓"技能匹配"的全部后端实现**：把 `?stack=React,Node.js` 拆开，做一次 `Skill.name IN (...)` 的**布尔硬过滤**。

**关键结论（可直接引用）**：
- ❌ **无相似度/得分/排序/权重**——没有任何 `score`、`weight`、`rank`、`ORDER BY relevance`。
- ❌ **`UserSkill.level` 完全没参与查询**（表里有 `level` 字段，但 `where` 里从不使用）。
- ❌ **`User.availability`、`academicYear`、`branch` 完全没参与查询**（前端筛，见下）。
- ❌ **`Project.rolesNeeded` 与 `UserSkill` 之间没有任何计算**——项目"需要什么角色"和候选人"会什么技能"从不做交叉。
- ❌ **`User.interests` 是自由文本 `String?`，无法参与匹配**。
- ❌ **精确名匹配**：`name: { in: skillNames }`，`"React"` 匹配不到 `"React Native"` 或 `"react"`（大小写敏感，取决于 DB collation）。

### 3.3.2 前端"匹配"是纯客户端字符串过滤 + **硬编码占位符** —— `frontend/src/pages/Explore.jsx`

**★ 最有力的证据（L42–55）——所谓"匹配维度"是写死的常量：**

```javascript
// Map backend user data to card format
const mappedDevelopers = allUsers.map(user => ({
  id: user.id || user.firebaseUid,
  name: user.name,
  university: [user.branch, user.academicYear].filter(Boolean).join(' | '),
  rating: 4.8,                       // ← ★ 硬编码！不是真实评分
  description: user.bio || '',
  skills: user.skills ? user.skills.map(s => s.skill?.name).filter(Boolean) : [],
  collaborations: user.projects ? user.projects.length : 0,
  availability: user.availability || 'Open to Collaborate',
  status: 'online',                  // ← ★ 硬编码！永远是 online
  level: 'Mid-Level',                // ← ★ 硬编码！永远是 Mid-Level
  discordOrContact: user.discordOrContact || '',
}));
```

**过滤逻辑（L57–75）**：

```javascript
const filteredDevelopers = useMemo(() => {
  return mappedDevelopers.filter(developer => {
    const matchesSearch = searchQuery === '' ||
      developer.name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      developer.description?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      developer.skills.some(skill => skill.toLowerCase().includes(searchQuery.toLowerCase())) ||
      developer.university?.toLowerCase().includes(searchQuery.toLowerCase());

    const matchesTechStack = selectedTechStack === 'All Tech Stacks' ||
      developer.skills.some(skill => skill.toLowerCase().includes(selectedTechStack.toLowerCase()));

    const matchesLevel = selectedLevel === 'All Levels' || developer.level === selectedLevel;

    const matchesAvailability = selectedAvailability === 'All Availability' ||
      developer.availability === selectedAvailability;

    return matchesSearch && matchesTechStack && matchesLevel && matchesAvailability;
  });
}, [searchQuery, selectedTechStack, selectedLevel, selectedAvailability, mappedDevelopers]);
```

**致命细节**：`developer.level` 恒为 `'Mid-Level'`（L53 硬编码），所以 **`selectedLevel` 只要不是 `'All Levels'`，筛选结果永远是空集**——"按水平筛选"这个功能实际上是坏的。

同时 `rating: 4.8` 恒为 4.8 —— 卡片上的"评分"是**假数据**。

> **这是本次调研最有价值的负面发现**：H@ckollab 对外宣称"基于技能的匹配"，但**实现只是 `String.includes()` 过滤 + 两个硬编码常量**，且其中一个筛选维度是死功能。**"AI 匹配/智能推荐"完全不存在。**

### 3.3.3 档案字段（前端 UI 侧，`UserProfileForm.jsx`）

**技能选择是写死的 4 类封闭清单**（`UserProfileForm.jsx` L10–37，原文）：

```javascript
const skillCategories = {
  Frontend: ["React","Vue.js","Angular","Next.js","TypeScript","JavaScript","HTML","CSS","Tailwind CSS"],
  Backend:  ["Node.js","Python","Java","Go","Ruby","PHP","C#",".NET","Express.js","Django","Flask"],
  Mobile:   ["React Native","Flutter","Swift","Kotlin","Ionic","Xamarin"],
  Database: ["PostgreSQL","MongoDB","MySQL","Redis","Firebase","Supabase"],
};
```

**表单字段**（`UserProfileForm.jsx` L44–54）：

```javascript
const [formData, setFormData] = useState({
  name: "", bio: "", availability: "", academicYear: "", branch: "",
  skills: [], interests: "", github: "", otherLinks: "",
  projects: [{ title: "", tech: "", link: "" }],
  ...
```

**提交时把技能名当 `skillId` 传**（L82–87 toggle + L116–117）：

```javascript
const toggleSkill = (skill) => {
  setFormData(prev => ({
    ...prev,
    skills: prev.skills.includes(skill)
      ? prev.skills.filter((s) => s !== skill)
      : [...prev.skills, skill],
  }));
};
...
const skillsPayload = formData.skills.map((skill) => ({
  skillId: skill,      // ← ★ 注意：这里把"技能名"当 skillId 传
  level,               // （level 由其他控件提供）
}));
```

后端 `userController.js` L86–100 相应做 `findUnique({ where: { name: skillName } })`，不存在则 `create`：

```javascript
let skill = await prisma.skill.findUnique({ where: { name: skillName } });
if (!skill) {
  skill = await prisma.skill.create({ data: { name: skillName } });
}
skillRelations.push({ skillId: skill.id, level });
```

**能提炼的匹配维度（数据模型具备、代码未用）**：

| 维度 | 字段 | 是否用于匹配 |
| --- | --- | --- |
| 技能名 | `UserSkill → Skill.name` | ✅ 仅 `IN` 硬过滤 |
| 技能熟练度 | `UserSkill.level` | ❌ **有字段，从不查询** |
| 技能分类 | `Skill.category` | ❌ 从不查询（前端写死分类） |
| 可投入度 | `User.availability` | ⚠️ 仅前端字符串相等 |
| 兴趣方向 | `User.interests` | ❌ 自由文本，无法用 |
| 学历/年级/院系 | `academicYear` / `branch` | ⚠️ 仅前端展示+搜索 |
| 项目技术栈 | `Project.techStack[]` | ❌ 未与技能交叉 |
| 项目所需角色 | `Project.rolesNeeded[]` | ❌ **从不与用户技能交叉** |
| 项目难度 | `Project.difficulty` | ❌ 未用 |
| 团队规模 | `Project.maxTeamSize` | ❌ 未用 |
| 协作类型 | `Project.collaborationType` | ❌ 未用 |
| 过往协作数 | `projects.length` | ⚠️ 仅展示 |

> **对比 Synnovator 的档案**：Synnovator 的 `skills[].category + items[]`、`interests[]`、`looking_for{roles, team_size, collaboration_style}` 是**更可计算的结构**（有枚举、有意图声明）。**两者都没有真正的匹配算法，但 Synnovator 的数据模型更接近可做匹配的形态。**

### 3.3.4 匹配后的动作：邀请/兴趣 → 协作者

- **邀请流**：`inviteController.js` `sendInvite`（L6–65）→ `prisma.invite.create({status:"pending"})` → 发邮件（`sendInviteEmail`，不阻塞响应）。
- **兴趣流**：`interestController.js` `showInterest`（L5–70）→ 加进 `Project.interestedUsers` 多对多 → 发邮件。
- **接受后入队**：`inviteController.js` L163–199：

```javascript
if (status === "accepted") {
  await prisma.collaborator.create({
    data: { projectId: invite.projectId, userId: invite.receiverId, joinedVia: "invite" },
  });
  // 1. Bell notification for sender (simulate with console.log)   ← ★ 通知是 console.log
  console.log(`🔔 Bell: ${invite.receiver.name} accepted your invitation for ${invite.project.title}.`);
  // 2. Send email to sender (inviter)
  ...
}
```
`projectController.js` L368–383 的 `acceptInterest` 同理，`joinedVia: "interest"`。

> ⚠️ **注意**：不是事务。`invite.update` 和 `collaborator.create` 是两次独立写；中间失败会留下"已接受但未入队"的不一致。**没有幂等保护**（重复 PATCH 会产生**重复 Collaborator 行**——schema 里 `Collaborator` 没有 `@@unique([projectId, userId])`）。这是我们要避免的（对照我们 AGENTS.md 的"名额/接受事实同事务持久化"）。

## 3.4 防作弊 / 安全机制（H@ckollab 的重大弱点）

### 3.4.1 ★ 邀请状态可被任意人篡改（无鉴权）—— `inviteRoutes.js` L26

```javascript
// Accept or decline an invite
router.patch('/:inviteId', updateInviteStatus);      // ← ❌ 没有 verifyFirebaseToken
```

而 `updateInviteStatus`（`inviteController.js` L148–206）**不校验调用者是否是收件人**：

```javascript
export const updateInviteStatus = async (req, res) => {
  const { inviteId } = req.params;
  const { status } = req.body;
  // 直接更新，没有任何身份/归属校验
  const invite = await prisma.invite.update({
    where: { id: inviteId },
    data: { status, respondedAt: status === "accepted" ? new Date() : undefined },
    ...
  });
  if (status === "accepted") {
    await prisma.collaborator.create({ data: { projectId: invite.projectId, userId: invite.receiverId, joinedVia: "invite" } });
  }
```

**任何人只要能猜到/枚举 `inviteId`，就能替他人接受邀请并把该用户塞进任意项目团队。** 这是**垂直+水平双重越权**。

### 3.4.2 兴趣接口无鉴权且自我断言

`interestRoutes.js` L8：`router.post('/', verifyFirebaseToken, showInterest);` —— 这个有鉴权。
但 `projectRoutes.js` L25：`router.post("/:projectId/interest", showInterest);` —— **这条没有**。控制器内部的"自我校验"是：

```javascript
// interestController.js L12-18
// Verify the user is showing interest for themselves
if (...) {
  return res.status(403).json({ error: "Unauthorized: Can only show interest for yourself" });
}
```
判据来自**请求体里客户端自报的 `senderFirebaseUid`**，不是 `req.user`。**客户端可任意伪造**。对照有鉴权的路由用 `req.user?.uid`（`inviteController.js` L9），两条路径的信任模型不一致。

### 3.4.3 邀请可被非项目所有者发出

`inviteController.js` `sendInvite`（L6–65）**没有校验 `sender` 是否为 `project.creatorId` 或协作者**：
```javascript
const invite = await prisma.invite.create({ data: { projectId, senderId: sender.id, receiverId: receiver.id, role, status: "pending" } });
```
**任何登录用户都能以任意项目名义邀请任意人**。

### 3.4.4 其他

- **审计日志**：❌ **完全没有**。无 AuditLog 表、无事件记录。
- **提交哈希 / 查重 / 异常检测**：❌ **完全没有**。
- **鉴权机制**：Firebase Auth（`middleware/firebaseAuth.js`，仅 720 字节），所有 route 需显式挂 `verifyFirebaseToken`（**opt-in 而非 opt-out**，导致上面多处遗漏）。
- **CORS / 速率限制 / 输入校验**：本次取证未见（未逐一验证）。

## 3.5 技术栈与部署（H@ckollab）

`backend/package.json` + `frontend/package.json` + `vercel.json`：

| 层 | 选型 | 证据 |
| --- | --- | --- |
| 前端 | **Create React App**（`react-scripts`，非 Vite/Next）+ Tailwind CSS | `frontend/package.json` |
| 后端 | **Express + Node.js（ESM，`"type":"module"`）** | `backend/package.json`、`index.js` |
| ORM | **Prisma**（`prisma-client-js`） | `schema.prisma` L1–2 |
| 数据库 | **PostgreSQL**（Supabase 托管，`DATABASE_URL` + `DIRECT_URL`） | `schema.prisma` L4–7 |
| 认证 | **Firebase Auth**（`firebaseAdmin` + `verifyFirebaseToken`） | `middleware/firebaseAuth.js` |
| 邮件 | Nodemailer（`lib/emailService.js`，9.6KB） | 文件树 |
| 迁移 | Prisma Migrate（1 个迁移 `20251111114725_init`）+ **手工补丁 `drift_fix.sql`** | 文件树 |
| 部署 | **Vercel**（`vercel.json` 109 B）；前端静态 + 后端需另部署 | 文件树 |

> **`drift_fix.sql`（6054 B）是一个信号**：说明生产库与 Prisma schema 曾发生 **drift**，靠手写 SQL 对齐，而**没有回写成一个正式迁移**。这是数据库治理不规范的直接证据（对比我们 AGENTS.md："已应用文件不可重写，后续使用递增迁移"）。

---

# 四、三竞品横向对比

| 维度 | JUDGELAYER | Synnovator | H@ckollab |
| --- | --- | --- | --- |
| 定位 | 提交+评审（可辩护结果） | AI 原生赛事全流程 | 学生技能组队 |
| 许可 | **MIT** | **无声明** | **无声明** |
| Star / Fork | 2 / 0 | 0 / 1 | 2 / 5 |
| 最后推送 | 2026-09-29 | 2026-03-27 | 2026-02-13 |
| 代码量 | 47 文件 / 180KB | **825 文件 / 2.5MB** | 104 文件 / 3.3MB |
| 后端 | Express 单文件 43KB | Next.js（Cloudflare Workers） | Express 分层 |
| 数据库 | **无（内存+JSON 文件）** | **无（YAML 文件 + GitHub）** | **PostgreSQL + Prisma** |
| 评分标准化 | **★ Z-score（μ/σ 校准 + 压缩检测）** | ❌ 纯加权算术平均 | N/A |
| 评委隔离 | **★ 后端硬 403 + 审计留痕** | ⚠️ 仅评委白名单，**结果 JSON 泄露评委身份** | ❌ 无评审概念 |
| 审计日志 | ⚠️ 有，但仅内存 200 条、可重置 | ✅ **Git 历史 + Issue 时间线（天然）** | ❌ **完全没有** |
| 防重复提交 | ❌ 文档承诺 Levenshtein，**代码未实现** | ⚠️ 同人同队子串检测（有误判） | ❌ 无 |
| 流程状态机 | Event.status 枚举（4 态） | **★ 7 阶段标签状态机 + 22 个 Actions** | ❌ 无 |
| 技能匹配算法 | N/A | ❌ 无（但 schema 可计算） | ❌ **无，且筛选功能是坏的** |
| 鉴权质量 | ⚠️ 明文 token + 允许 `?token=` | ✅ GitHub OAuth | ⚠️ Firebase，但**多处路由漏挂中间件** |
| 测试 | `acceptance-report.txt`（7/7，外部运行器 `run.py`） | **Vitest 单测 + 大量 spec 文档** | ❌ 仅 CRA 默认测试 |

---

# 五、优点（最多 6 条，逐条说明为什么强 + 我们能不能做）

### 1. ★ Z-score 评委校准 + 分数压缩检测（JUDGELAYER）
**为什么强**：它解决的是赛事评审**最本质的公正性问题**——评委松紧差异与"老好人给分"会让排名失真。公式完整、有边界防御（`max(σ_j, 0.25)`、`clamp(1,5)`、σ 为 0 的兜底），并且**有配套的可观测性**（压缩评委在主办方控制台标红，阈值 σ<0.15 且至少 3 份评分）。
**证据**：`JUDGING.md` L25–41（公式）；`server.ts` L294–382（实现）；`server.ts` L890–902（压缩检测）。
**我们能不能做**：**能，且能做得更好。** 我们是 TypeScript + PostgreSQL，把 `calculateScoresAndNormalization()` 移植为**纯函数 + 单元测试**即可（比它的内存实现更可测）；同时补上它缺的：`N_j < 2` 的显式降级、并列破平、标准化前后双轨留痕、以及把中间量（μ_j/σ_j/Z/norm）**落库**以便申诉时举证（它只在请求时现算）。

### 2. ★ 后端硬隔离 + 越权即审计（JUDGELAYER）
**为什么强**：立场正确——`ARCHITECTURE.md` L101 明确"前端隐藏视为无效，必须后端 403"。更关键的是**越权尝试不是静默失败，而是写一条 `PEER_ISOLATION_BOUNDARY_PROBED` 审计**，于是"谁在探测边界"变成可统计的信号；再配 `POST /api/audit/probe` **一键自证清白**，把安全能力变成可演示的产品卖点。
**证据**：`server.ts` L729–805（隔离）、L252–291（RBAC）、L178–199（审计）、L1157–1213（探针）；`acceptance-report.txt` CHECK 5/6。
**我们能不能做**：**能，且必须做。** 我们已有 M01 权限模型与 M04 评分模块。做法：在评分读取的 server handler 里强制 `actor.userId === ballot.judgeId`，越权写审计表（**真正的 append-only 表**，不是它那种内存数组 pop）；再加一个管理员可见的"边界探测记录"面板。

### 3. ★ 用标签实现阶段状态机（Synnovator）
**为什么强**：把"赛事当前处于哪个阶段"这个全局状态，编码成**每条 Issue 上的唯一 `stage:*` 标签**。每日定时任务按 `hackathon.yml` 的 `timeline` 重算并**先摘旧标再挂新标**，幂等且可审计（谁在什么时候被改了标签，GitHub 全记录）。**零额外存储、零额外权限系统**，且状态变更对参与者完全可见。
**证据**：`status-update.yml` L32–45（7 阶段 + ended）、L57–88（标签摘挂）。
**我们能不能做**：**能。** 我们已有 M03 赛事 + M05 时间窗口。可把"阶段"做成**服务端派生的单一事实**（从 timeline 计算，不落第二份状态），并复刻它的**幂等标签/徽章语义**（前端展示 + 变更留痕）。注意：**不要**引入第二套状态（符合我们 AGENTS.md"不建立第二份完成状态"）。

### 4. ★ 事件驱动的提交校验链（Synnovator）
**为什么强**：`validate-score.yml` 在 Issue 一开/一改就自动跑 7 项校验（标题格式、赛事存在、赛道存在、评委白名单、利益冲突声明、重复评分、分数范围），**失败就把错误清单评论回 issue 且不通过**，成功才贴 `score-validated`。这把"数据质量"前移到**录入瞬间**，而不是等到聚合时才发现脏数据；而且**聚合只消费 `score-validated` 标签**，形成清晰的数据分层。
**证据**：`validate-score.yml` L26–141（校验）、L143–166（通过/失败分流）；`aggregate-scores.yml` L68（只取已校验）。
**我们能不能做**：**能。** 我们不需要 GitHub Actions——把同一套规则做成**服务端校验管线**（提交时同步校验 + 失败返回结构化错误清单），并用 `status` 字段复刻"未校验/已校验"分层（只有已校验的评分进入排名）。

### 5. ★ 结果可辩护：把评分过程完整留痕（JUDGELAYER 的方向 + Synnovator 的载体）
**为什么强**：JUDGELAYER 记录 `criteria_breakdown`、`judge_details`、`raw` 与 `normalized` 双分、`coveragePercent`；Synnovator 的 `results/<track>.json` 记录 `calculated_at`、`judging_mode`、`total_judges`、每评委明细，且**结果文件本身进 Git**，天然带版本与时间。当队伍申诉时，"为什么是这个名次"可以逐层展开到某评委给某项打了几分。
**证据**：`aggregate-scores.yml` L145–179（judge_details/criteria_breakdown）、L190–201（结果结构）+ L206–216（commit）；JUDGELAYER `server.ts` L1122（CSV 含 Raw Score + Normalized Score 双列）。
**我们能不能做**：**能，而且应该做成第一等公民。** 我们的 M04 已有"原始测评仅本人默认可见"；在此基础上加"**评分派生结果可复算**"——保存输入（原始分 + 当时的 μ/σ 快照 + 算法版本），使任何历史排名都能被重放验证。

### 6. ★ 零基础设施的部署形态（Synnovator / JUDGELAYER）
**为什么强**：Synnovator 用 **GitHub 作为数据库 + Cloudflare Workers** —— 没有一台自己的服务器、没有数据库运维、审计免费；JUDGELAYER 用**单文件 Express + JSON 快照**，`npm install && npm run dev` 就能跑，**零云账号零 API key**（`README.md` L35）。两者都把"让评委/学生在 5 分钟内看到东西"做到了极致。
**证据**：`README.md` L35–46；`apps/web/wrangler.jsonc`；`hackathons/` 即数据库。
**我们能不能做**：**部分能，且已选了更好的路线。** 我们已定 Next.js + PostgreSQL（PGlite 本机 / pg 线上），**比 JUDGELAYER 的 JSON 快照在并发与一致性上强得多**；但可以借鉴它的"**一条命令起全套**"体验（我们已有 serve wrapper + 单例应用初始化）和 Synnovator 的"**静态化只读投影**"（`apps/web/scripts/generate-static-data.mjs`、`static-provider.ts`）——把公开赛事页做成静态/近静态读取，降低读压力。

---

# 六、弱点与我们可超越的点（最多 6 条）

### 1. ★★ 三家的"技能匹配"都不存在——这是最大的机会
**弱点证据**：H@ckollab 的后端只有 `Skill.name IN (...)` 布尔过滤（`userController.js` L10–21），前端是 `String.includes()` + **两个硬编码常量** `rating: 4.8` / `level: 'Mid-Level'`（`Explore.jsx` L47/L53），导致**"按水平筛选"永远是空集**；`UserSkill.level`、`Project.rolesNeeded`、`Project.techStack` 之间的交叉计算**一处都没有**。Synnovator 有更好的 schema（`skills[].category/items`、`looking_for.roles/team_size/collaboration_style`）但**同样没有匹配算法**。
**我们怎么超越**：做**真正的可解释匹配分数**——把「项目需求向量」（`rolesNeeded` + `techStack` + `difficulty`）与「候选人能力向量」（`UserSkill.name × level` + `interests` + `availability`）做加权相似度，输出 0–100 分 **+ 逐维贡献明细**（为什么是 87 分：技能命中 3/4 项、熟练度达标、时间可投入）。**关键是可解释且不吹牛**——我们 AGENTS.md 已明确"不给能力或匹配百分比"，所以要设计成"条件性建议 + 依据"而非"匹配度 87%"。这是**产品判断上的差异**，也是我们能讲清楚故事的地方。

### 2. ★★ 审计日志名不副实（JUDGELAYER）
**弱点证据**：文件称 "append-only tamper-evident"（`DATA-MODEL.md` L75），实现却是**内存数组 + `unshift` + 超 200 条 `pop` + 可被 `POST /api/reset` 清空**（`server.ts` L188–198、L1217）。
**我们怎么超越**：建**真正的只追加审计表**（PostgreSQL，`INSERT` only，撤销 `UPDATE`/`DELETE` 权限）+ **哈希链**（每条记录含前一条哈希）使篡改可检测；保留期另走归档而非删除。这是低成本、高说服力的差异化。

### 3. ★★ 提交查重是文档承诺、代码未实现（JUDGELAYER）
**弱点证据**：`JUDGING.md` L54 声称 "Detected via Levenshtein title similarity (>85%) or identical repository URLs"，但 `server.ts` **全文无 Levenshtein/编辑距离实现**，实际只读 `fixtures.json` 预置的静态布尔 `p.is_duplicate`（`server.ts` L888、L365）。
**我们怎么超越**：实现真实的**提交指纹**——仓库 URL 归一化（去 `.git`/大小写/协议）+ 标题归一化后编辑距离或 token 集合相似度 + 关键文件哈希（我们 M06 已有仓库/版本保存能力）。并**把判定依据展示给主办方**（相似度数值 + 命中项），而不是一个布尔。

### 4. ★★ 越权漏洞与"opt-in 鉴权"（H@ckollab）
**弱点证据**：`PATCH /api/invites/:inviteId` **完全无鉴权**（`inviteRoutes.js` L26），控制器也不校验调用者归属（`inviteController.js` L148–206）→ **任何人可替他人接受邀请并入队任意项目**；`sendInvite` 不校验发送者是否为项目所有者（L39–47）→ **任何人可冒项目名义发邀请**；`POST /api/projects/:projectId/interest` 无鉴权且用**客户端自报的 `senderFirebaseUid`** 做"自我校验"（`interestController.js` L12–18）。
**我们怎么超越**：我们的权限模型是 **actor 由会话解析、服务端强制**（AGENTS.md：所有读写复核当前权限）。补两点：①**默认拒绝**的中间件挂载（而非逐条 opt-in），②跨模块调用**同事务断言**（已有 executor/保存点机制）。这三处漏洞在我们架构下天然不成立——这是可以直接写进对比稿的硬优势。

### 5. ★ 状态变更与入队不是事务、无幂等（H@ckollab）
**弱点证据**：`invite.update` 与 `collaborator.create` 是两次独立写（`inviteController.js` L154–171），中间失败留下"已接受未入队"；`Collaborator` 无 `@@unique([projectId,userId])`（`schema.prisma` L119–127），重复 PATCH 产生**重复成员行**。此外 `drift_fix.sql`（6KB 手写补丁）说明生产库曾 drift 且**未回写为正式迁移**。
**我们怎么超越**：我们 AGENTS.md 已定"**名额/接受事实同事务持久化**"、迁移"**已应用不可重写 + 递增**"。把这两条在竞品对比里点名，直接体现工程成熟度。

### 6. ★ 评委身份未脱敏 + 评分无标准化（Synnovator）
**弱点证据**：①聚合时虽写 `judge_id: judge-${idx+1}`，但同函数保留 `const judge = issue.user.login`，且 `total_judges` 用真实 login（`aggregate-scores.yml` L81、L195）→ 结果 JSON 暴露"谁评了谁"，**与评审期互盲的初衷矛盾**；②**完全没有 Z-score**，直接 `expertScore = 各评委总分算术平均`（L153），评委松紧偏差原样进入排名；③**并列无破平**（L183 只按 `final_score` 排，JS `sort` 不稳定）；④硬约束只警告、`hard_constraint_violations` **硬编码空数组**（L117–124、L177）；⑤投票分 `// TODO` 未实现（L168）；⑥利益冲突勾选校验是 `bodyText.includes('[X]')` **全文子串搜索**（`validate-score.yml` L87），重复评分用 `title.includes(team)` **子串匹配**（L103，`Team A` 误命中 `Team AB`）。
**我们怎么超越**：直接**组合两家的长处**——用 JUDGELAYER 的 Z-score 与后端隔离，用 Synnovator 的流程状态机与校验链；同时修掉它们各自的坑：结果输出**只给匿名 judge 序号 + 不复用 login**、并列用**多级破平**（标准化分 → raw 分 → 覆盖度 → 提交时间）、硬约束**真正实现**、勾选用**表单字段精确解析**而非全文子串、重复检测用**结构化 team id** 而非标题子串。

---

# 七、证据与来源

## 7.1 仓库元数据（API）

| 仓库 | URL |
| --- | --- |
| JUDGELAYER | `https://api.github.com/repos/Tanya-garg10/JUDGELAYER-Self-Hosted-Hackathon-Submission-Judging-Platform` |
| JUDGELAYER 文件树 | `https://api.github.com/repos/Tanya-garg10/JUDGELAYER-Self-Hosted-Hackathon-Submission-Judging-Platform/git/trees/HEAD?recursive=1` |
| H@ckollab | `https://api.github.com/repos/nst-sdc/-H-ckollab` |
| H@ckollab 文件树 | `https://api.github.com/repos/nst-sdc/-H-ckollab/git/trees/HEAD?recursive=1` |
| Synnovator | `https://api.github.com/repos/Synnovator/monorepo` |
| Synnovator 文件树 | `https://api.github.com/repos/Synnovator/monorepo/git/trees/HEAD?recursive=1` |
| Synnovator 检索 | `https://api.github.com/search/repositories?q=Synnovator` |

## 7.2 原始文件（`raw.githubusercontent.com`，无配额限制）

**JUDGELAYER**（branch `main`）：
```
https://raw.githubusercontent.com/Tanya-garg10/JUDGELAYER-Self-Hosted-Hackathon-Submission-Judging-Platform/main/README.md
https://raw.githubusercontent.com/Tanya-garg10/JUDGELAYER-Self-Hosted-Hackathon-Submission-Judging-Platform/main/ARCHITECTURE.md
https://raw.githubusercontent.com/Tanya-garg10/JUDGELAYER-Self-Hosted-Hackathon-Submission-Judging-Platform/main/DATA-MODEL.md
https://raw.githubusercontent.com/Tanya-garg10/JUDGELAYER-Self-Hosted-Hackathon-Submission-Judging-Platform/main/JUDGING.md
https://raw.githubusercontent.com/Tanya-garg10/JUDGELAYER-Self-Hosted-Hackathon-Submission-Judging-Platform/main/server.ts
https://raw.githubusercontent.com/Tanya-garg10/JUDGELAYER-Self-Hosted-Hackathon-Submission-Judging-Platform/main/package.json
https://raw.githubusercontent.com/Tanya-garg10/JUDGELAYER-Self-Hosted-Hackathon-Submission-Judging-Platform/main/acceptance-report.txt
https://raw.githubusercontent.com/Tanya-garg10/JUDGELAYER-Self-Hosted-Hackathon-Submission-Judging-Platform/main/render.yaml
```
提交历史：`https://github.com/Tanya-garg10/JUDGELAYER-Self-Hosted-Hackathon-Submission-Judging-Platform/commits/main`

**Synnovator**（branch `main`）：
```
https://raw.githubusercontent.com/Synnovator/monorepo/main/.github/workflows/status-update.yml
https://raw.githubusercontent.com/Synnovator/monorepo/main/.github/workflows/aggregate-scores.yml
https://raw.githubusercontent.com/Synnovator/monorepo/main/.github/workflows/validate-score.yml
https://raw.githubusercontent.com/Synnovator/monorepo/main/.github/workflows/validate-register.yml
https://raw.githubusercontent.com/Synnovator/monorepo/main/.github/workflows/sync-issue-data.yml
https://raw.githubusercontent.com/Synnovator/monorepo/main/.github/workflows/team-join-approval.yml
https://raw.githubusercontent.com/Synnovator/monorepo/main/.github/ISSUE_TEMPLATE/register.yml
https://raw.githubusercontent.com/Synnovator/monorepo/main/.github/ISSUE_TEMPLATE/judge-score.yml
https://raw.githubusercontent.com/Synnovator/monorepo/main/.github/ISSUE_TEMPLATE/nda-sign.yml
https://raw.githubusercontent.com/Synnovator/monorepo/main/.github/ISSUE_TEMPLATE/appeal.yml
https://raw.githubusercontent.com/Synnovator/monorepo/main/profiles/_schema.yml
https://raw.githubusercontent.com/Synnovator/monorepo/main/teams/_schema.yml
https://raw.githubusercontent.com/Synnovator/monorepo/main/config/roles.yml
https://raw.githubusercontent.com/Synnovator/monorepo/main/packages/shared/src/schemas/profile.ts
https://raw.githubusercontent.com/Synnovator/monorepo/main/packages/shared/src/schemas/team.ts
https://raw.githubusercontent.com/Synnovator/monorepo/main/apps/web/lib/permissions.ts
https://raw.githubusercontent.com/Synnovator/monorepo/main/apps/web/wrangler.jsonc
```
提交历史：`https://github.com/Synnovator/monorepo/commits/main`

**H@ckollab**（branch `main`）：
```
https://raw.githubusercontent.com/nst-sdc/-H-ckollab/main/README.md
https://raw.githubusercontent.com/nst-sdc/-H-ckollab/main/backend/prisma/schema.prisma
https://raw.githubusercontent.com/nst-sdc/-H-ckollab/main/backend/prisma/migrations/20251111114725_init/migration.sql
https://raw.githubusercontent.com/nst-sdc/-H-ckollab/main/backend/prisma/seed.js
https://raw.githubusercontent.com/nst-sdc/-H-ckollab/main/backend/drift_fix.sql
https://raw.githubusercontent.com/nst-sdc/-H-ckollab/main/backend/index.js
https://raw.githubusercontent.com/nst-sdc/-H-ckollab/main/backend/package.json
https://raw.githubusercontent.com/nst-sdc/-H-ckollab/main/backend/middleware/firebaseAuth.js
https://raw.githubusercontent.com/nst-sdc/-H-ckollab/main/backend/controllers/userController.js
https://raw.githubusercontent.com/nst-sdc/-H-ckollab/main/backend/controllers/projectController.js
https://raw.githubusercontent.com/nst-sdc/-H-ckollab/main/backend/controllers/inviteController.js
https://raw.githubusercontent.com/nst-sdc/-H-ckollab/main/backend/controllers/interestController.js
https://raw.githubusercontent.com/nst-sdc/-H-ckollab/main/backend/routes/inviteRoutes.js
https://raw.githubusercontent.com/nst-sdc/-H-ckollab/main/backend/routes/projectRoutes.js
https://raw.githubusercontent.com/nst-sdc/-H-ckollab/main/backend/routes/userRoutes.js
https://raw.githubusercontent.com/nst-sdc/-H-ckollab/main/backend/routes/interestRoutes.js
https://raw.githubusercontent.com/nst-sdc/-H-ckollab/main/frontend/package.json
https://raw.githubusercontent.com/nst-sdc/-H-ckollab/main/frontend/src/components/UserProfileForm.jsx
https://raw.githubusercontent.com/nst-sdc/-H-ckollab/main/frontend/src/components/PostProjectForm.jsx
https://raw.githubusercontent.com/nst-sdc/-H-ckollab/main/frontend/src/pages/Explore.jsx
https://raw.githubusercontent.com/nst-sdc/-H-ckollab/main/frontend/src/pages/Profile.jsx
https://raw.githubusercontent.com/nst-sdc/-H-ckollab/main/frontend/src/pages/ExploreHackathons.jsx
```
（仓库名以 `-` 开头，URL 路径中原样使用 `-H-ckollab`。）
提交历史：`https://github.com/nst-sdc/-H-ckollab/commits/main`

## 7.3 本地取证留档（本次调研生成）

原始抓取文件保存在 `F:\黑客松情报局\.runtime\竞品调研\_raw\`（`judgelayer__*` / `synnovator__*` / `hackollab__*` / `gh_*_commits.html`），以及两个只读抓取脚本 `fetch.mjs`、`rawfetch.mjs`。**这些是本次调研的原始证据，可复核上文任何片段。**

---

# 八、代码级证据索引（速查）

| # | 结论 | 文件 | 行 |
| --- | --- | --- | --- |
| 1 | Z-score 公式全文（μ_j/σ_j/Z/max(σ,0.25)/clamp/Σ） | `JUDGING.md` | 25–41 |
| 2 | 加权综合分 `0.3F+0.25Q+0.25I+0.2M` | `server.ts` | 303 |
| 3 | 评委 mean/std 计算 | `server.ts` | 311–322 |
| 4 | 全局 mean/std + 兜底 | `server.ts` | 324–326 |
| 5 | **Z-score + 重标定 + clamp 实现** | `server.ts` | 328–336 |
| 6 | `effectiveStd = Math.max(jStat.std, 0.25)` | `server.ts` | 332 |
| 7 | 项目聚合（标准化分算术平均）+ 双分排序破平 | `server.ts` | 347–374 |
| 8 | **评委互盲硬 403 + 审计留痕** | `server.ts` | 772–793 |
| 9 | 参与者访问评审接口被拒 + 审计 | `server.ts` | 739–756 |
| 10 | 通用 RBAC `requireRole` | `server.ts` | 252–291 |
| 11 | 审计日志写入（含 200 条上限） | `server.ts` | 178–199 |
| 12 | 分数压缩检测 `count>=3 && std<0.15` | `server.ts` | 890–902 |
| 13 | 未完成评审批次 `< target` | `server.ts` | 877–885 |
| 14 | 查重：**仅读静态 `is_duplicate`** | `server.ts` | 888, 365 |
| 15 | 持久化 = 全量 JSON 文件覆写 | `server.ts` | 163–174 |
| 16 | 启动时**删除**持久化文件 | `server.ts` | 140–146 |
| 17 | 明文 token 比对 + 允许 `?token=` | `server.ts` | 223–249 |
| 18 | 交互式渗透探针 | `server.ts` | 1157–1213 |
| 19 | CSV 双分列（Normalized + Raw） | `server.ts` | 1122–1126 |
| 20 | 隔离设计立场（前端隐藏无效） | `ARCHITECTURE.md` | 101 |
| 21 | 审计日志字段定义 | `DATA-MODEL.md` | 74–84 |
| 22 | **7 阶段状态机 + ended** | `status-update.yml` | 32–45 |
| 23 | 阶段标签幂等摘挂 | `status-update.yml` | 57–88 |
| 24 | 评分校验 7 项链 | `validate-score.yml` | 26–141 |
| 25 | 利益冲突 `bodyText.includes('[X]')`（弱校验） | `validate-score.yml` | 87–91 |
| 26 | 重复评分 `title.includes(team)`（子串误判） | `validate-score.yml` | 101–108 |
| 27 | 校验通过才贴 `score-validated` | `validate-score.yml` | 151–156 |
| 28 | 加权评分 `score * weight/100` | `aggregate-scores.yml` | 115 |
| 29 | 硬约束**未实现**（注释自承） | `aggregate-scores.yml` | 117–124 |
| 30 | `hard_constraint_violations: []` 硬编码空 | `aggregate-scores.yml` | 177 |
| 31 | 投票分 `// TODO` 未实现 | `aggregate-scores.yml` | 168 |
| 32 | 无 Z-score，直接算术平均 | `aggregate-scores.yml` | 153 |
| 33 | 并列无破平 | `aggregate-scores.yml` | 183–184 |
| 34 | 评委真名泄露（login 复用） | `aggregate-scores.yml` | 81, 195 |
| 35 | 结果 JSON 结构 + Git 提交 | `aggregate-scores.yml` | 190–216 |
| 36 | 档案 schema：skills/interests/looking_for | `profiles/_schema.yml` | 30–39 |
| 37 | 队伍 schema：status 三态 + looking_for.roles | `teams/_schema.yml` | 14, 23–27 |
| 38 | **后端"技能匹配"= `Skill.name IN (...)`** | `userController.js` | 10–21 |
| 39 | `UserSkill.level` 存在于表但不参与查询 | `schema.prisma` | 46–52；`userController.js` 10–21 |
| 40 | **硬编码 `rating: 4.8` / `status:'online'` / `level:'Mid-Level'`** | `Explore.jsx` | 47, 52, 53 |
| 41 | 前端纯 `String.includes()` 过滤（4 维度） | `Explore.jsx` | 57–75 |
| 42 | "按水平筛选"永远空集（因 level 硬编码） | `Explore.jsx` | 53, 68 |
| 43 | 技能清单写死 4 类 | `UserProfileForm.jsx` | 10–37 |
| 44 | 提交时技能名当 skillId | `UserProfileForm.jsx` | 116–117 |
| 45 | 后端按 name upsert Skill | `userController.js` | 95–100 |
| 46 | **`PATCH /api/invites/:id` 无鉴权** | `inviteRoutes.js` | 26 |
| 47 | 邀请状态更新不校验归属 | `inviteController.js` | 148–206 |
| 48 | `sendInvite` 不校验项目所有权 | `inviteController.js` | 39–47 |
| 49 | 无鉴权 interest 路由 + 客户端自报身份 | `projectRoutes.js` 25；`interestController.js` 12–18 |
| 50 | 邀请接受 ≠ 事务、无幂等；通知是 console.log | `inviteController.js` | 163–199 |
| 51 | `Collaborator` 无 `@@unique` | `schema.prisma` | 119–127 |
| 52 | 数据库 drift 手工补丁未回写迁移 | `drift_fix.sql` | 全文 |
| 53 | 7/7 验收断言（含 403 证据） | `acceptance-report.txt` | 9–70 |
| 54 | 部署零云依赖说明 | `README.md` | 35–46 |

---

# 九、未能确认项

以下内容**在本次调研中未能取得确证**，不做推测性结论：

1. **Synnovator 许可协议**：`api.github.com` 返回 `license: null`，仓库内也**未见 LICENSE 文件**（文件树实测无 `LICENSE`/`COPYING`）。→ 可能是**未声明许可**（默认保留全部权利），但也可能是许可放在其他分支/未同步。**判定为"未获取"，建议使用前直接向作者确认。**
2. **H@ckollab 许可协议**：同样 `license: null`，文件树中**无 LICENSE 文件**。
3. **Synnovator 的 `config/roles.yml` 内容**：文件仅 51 字节，内容极简；**实际角色枚举定义位置**未能完全确认（推测在 `packages/shared/src/schemas/roles.ts` + Issue 模板 dropdown 中，已取到 `roles.ts` 文件但未逐行比对）。
4. **Synnovator 其他同源仓库**：GitHub 搜索返回 `H2OSLabs/SynnovatorZero`、`H2OSLabs/ssd`、`Onesyn-ai/synnovator-skills-bundle`、`Onesyn-ai/synnovator-code-submit-skill`。这些**未逐一取证**，`Synnovator/monorepo` 是否为主力仓库、是否有更活跃的仓库**未确认**。
5. **三个产品的线上站点实际可用性**：`judgelayer-self-hosted-hackathon.onrender.com`（Render 免费层会休眠）、`h-ckollab.vercel.app` **均未实际访问验证**。Synnovator 无 homepage。→ 本笔记的所有结论均基于**源码与仓库文档**，未做运行时验证。
6. **各仓库的 issue 内容**：H@ckollab 1 个 open issue、Synnovator 19 个 open issue 的**具体内容未逐一读取**（API 配额耗尽后未补取）。
7. **H@ckollab 的 `hackathonRoutes.js` / `interestRoutes.js` 完整字段与鉴权**：已取得路由文件（419 B / 341 B），但未逐条比对控制器，**部分鉴权判定标为"未逐一取证"**。
8. **JUDGELAYER 的 `openai` 依赖是否实际使用**：`package.json` 含 `openai ^4.104.0`，但本次取证的 `server.ts` 等文件中**未见调用**；是否在未取证的文件中使用**未确认**。
9. **JUDGELAYER 的 `run.py`（8855 B）与 `context.txt`（29KB）、`fixtures.json`（46KB）内容**：`run.py` 为 DOGFOOD 验收测试运行器，`fixtures.json` 为种子数据 —— **均未逐行阅读**（体积较大，非本次重点）。`data/judgelayer.sqlite` 的用途**未确认**（见 1.2 分析：运行时并不使用）。
10. **三个仓库的分支保护 / CODEOWNERS 实际生效情况**：Synnovator 有 `.github/CODEOWNERS`（784 B），但**是否配置了分支保护规则**属仓库设置，**代码层面无法确认**。
11. **H@ckollab `frontend/src/context/prisma/schema.prisma`（436 B）**：这是一个**位置异常的小 schema 副本**（推测为废弃残留），**用途未确认**。

## 尝试过但失败的 URL / 方法（诚实记录）

| 尝试 | 结果 |
| --- | --- |
| `https://api.github.com/repos/<...>/contents/<path>`（批量 23 个文件） | 前 10 个成功，后续 **配额耗尽 → HTTP 403 / 重试失败**（core: 0/60，重置于 2026-10-15 07:16:20 UTC） |
| `https://raw.githubusercontent.com/...` via **PowerShell `Invoke-WebRequest`** | **全部超时**（操作超时）→ 改用 **Node.js `fetch`** 后全部成功（200） |
| `https://raw.githubusercontent.com/Synnovator/monorepo/main/wrangler.jsonc` | **404**（正确路径为 `apps/web/wrangler.jsonc`，已取到） |
| 从 GitHub commits HTML 用 `Link--primary` / `aria-label` 正则提取提交信息 | **零命中**（页面结构变化）→ 改用内嵌 JSON `"shortMessage":"..."` 提取成功 |
| Synnovator 直接以 `Synnovator` 为名检索 | 主仓库名为 **`Synnovator/monorepo`**，**不是** `Synnovator/Synnovator`；已通过 search API 定位 |

**未使用**：`r.jina.ai` 等第三方镜像（按要求不使用需要 token 的第三方服务）；未 `git clone`；未 `npm install`；未运行任何仓库代码或构建。

---

## 附：可复用取证命令（本项目其他会话可直接照用）

```powershell
# 读单文件（无 API 配额，Node fetch 比 Invoke-WebRequest 稳定）
node -e "fetch('https://raw.githubusercontent.com/<owner>/<repo>/main/<path>').then(r=>r.text()).then(t=>console.log(t))"

# 批量抓取（脚本已存在于 .runtime\竞品调研\_raw\rawfetch.mjs）
# jobs.json: [{"url":"https://raw.githubusercontent.com/...","saveAs":"name.ext"}, ...]
node "F:\黑客松情报局\.runtime\竞品调研\_raw\rawfetch.mjs" "<输出目录>" "<jobs.json 路径>"
```

> `api.github.com` 匿名限流 **60 次/小时**，且按 IP 计数；`raw.githubusercontent.com` 实测**不受该配额限制**，优先用它。
