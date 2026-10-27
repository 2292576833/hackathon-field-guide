# 设计令牌合并：字面色值 → CSS 变量

- 任务：把 CSS 里"写了字面色值、但与本项目设计令牌完全同值"的地方机械替换为 `var(--token)`，让 `.palette-1`～`.palette-5` 换肤真正覆盖这些组件。
- 令牌表来源：`src/styles/globals.css` 的 `:root`（v1.20.0）。`src/styles/globals.css` **未做任何修改**。
- 范围：`src/**/*.css`（排除 `src/styles/globals.css`）。所有替换均为 1 对 1 同值替换。
- 说明：`src/styles/globals.css` 按硬约束 4 **整文件排除在扫描与替换口径之外**，因此下文 374/235/0 这些数字都不含该文件；该文件内确实存在 1 处"真实取值的同值字面量"，因必须保留而未计入（见第五节第 5 条）。

## 一、结论数字

| 指标 | 数字 |
| --- | --- |
| 改动文件数 | **35 个 CSS 文件**（另有 16 个 CSS 文件未改动） |
| 总替换处数 | **235 处** |
| "与令牌同值但写字面值"（本任务口径，可替换） | **235 → 0** |
| 全部"与令牌同值的十六进制字面量"（含 `var()` 回退值） | **374 → 139** |
| 其中 `var(--token, #hex)` 回退值（保留未改） | 139 → 139 |
| 近似值（不同值，按要求不动） | 569 处 / 363 个不同色值，全部原样保留 |

`374 = 235`（真正的字面值，本轮替换）`+ 139`（`var()` 回退值，保留）。
替换后再次扫描：结果为 `plain = 0`、`var-fallback = 139`，即**所有作为真实取值的同值字面量已清零**。

> 与任务描述里"约 302 处"的口径差异：我无法复现出恰好 302 的统计口径（详见"六、无法确定"）。本轮按"是否是真实取值（而非 `var()` 回退值）"这一更严格、更安全的口径统计，前后数字同源可比。

### 按令牌统计（替换处数）

| 令牌 | 替换处数 | 令牌 | 替换处数 |
| --- | --- | --- | --- |
| `--surface` | 73 | `--action-hover` | 8 |
| `--space-component-surface` | 68 | `--paper` | 7 |
| `--tint` | 20 | `--warning` | 6 |
| `--action` | 18 | `--line` | 6 |
| `--warning-bg` | 11 | `--ink` | 3 |
| `--control-line` | 9 | `--muted` | 3 |
| `--success` | 2 | `--success-bg` | 1 |
| `--brand` | 0 | 合计 | **235** |

## 二、已完成

### 改动文件与替换处数（前 → 后）

| 文件 | 前 | 后 |
| --- | ---: | ---: |
| `src/modules/selection-notices/selection-notices.module.css` | 23 | 0 |
| `src/components/ppt.module.css` | 22 | 0 |
| `src/components/participation.module.css` | 20 | 0 |
| `src/components/roadshow.module.css` | 18 | 0 |
| `src/components/site.module.css` | 18 | 0 |
| `src/modules/organizer-mail-settings/sender-settings.module.css` | 17 | 0 |
| `src/components/backend-dashboard.module.css` | 14 | 0 |
| `src/modules/retrospectives/retrospectives.module.css` | 14 | 0 |
| `src/modules/event-official-links/event-official-links.module.css` | 10 | 0 |
| `src/components/competition-workspace.module.css` | 8 | 0 |
| `src/components/first-login-guide.module.css` | 6 | 0 |
| `src/modules/journey/journey.module.css` | 6 | 0 |
| `src/modules/event-communication/event-communication.module.css` | 5 | 0 |
| `src/modules/event-judging/judging.module.css` | 5 | 0 |
| `src/modules/recruiting/recruiting.module.css` | 5 | 0 |
| `src/modules/team-assistant/assistant.module.css` | 5 | 0 |
| `src/components/operations.module.css` | 4 | 0 |
| `src/components/space-mission-workbench.module.css` | 4 | 0 |
| `src/components/navigator.module.css` | 3 | 0 |
| `src/components/team-task-board.module.css` | 3 | 0 |
| `src/modules/team-collaboration/collaboration.module.css` | 3 | 0 |
| `src/styles/home.module.css` | 3 | 0 |
| `src/components/space-lifecycle.module.css` | 2 | 0 |
| `src/modules/auth/account-controls.module.css` | 2 | 0 |
| `src/modules/event-registration/registration.module.css` | 2 | 0 |
| `src/modules/operations/audit-query-panel.module.css` | 2 | 0 |
| `src/modules/organizer/organizer.module.css` | 2 | 0 |
| `src/modules/resources/components.module.css` | 2 | 0 |
| `src/components/space-canvas-board.module.css` | 1 | 0 |
| `src/components/space-documents.module.css` | 1 | 0 |
| `src/components/space-guide-tree.module.css` | 1 | 0 |
| `src/components/space-invitation.module.css` | 1 | 0 |
| `src/modules/events/event-completion.module.css` | 1 | 0 |
| `src/modules/operations/observability-panel.module.css` | 1 | 0 |
| `src/modules/skills/skill-review-panel.module.css` | 1 | 0 |
| **合计** | **235** | **0** |

### 典型形态

- 局部令牌别名归位：`retrospectives.module.css` 的 `.panel { --retro-paper:#f6f3eb; --retro-surface:#fff; --retro-ink:#21201c; --retro-muted:#666257; --retro-action:#b8351e; --retro-action-hover:#9c2a17; --retro-line:#d9d4c8; --retro-control:#7d776c; }` 八个局部变量全部改为引用全局令牌。
- 组件别名归位：`roadshow` 的 `--roadshow-paper`、`participation` 的 `--participation-tint/warning/success`、`journey` 的 `--journey-tint`、`event-communication` 的 `--ec-paper`、`selection-notices` 的 `--notice-accent`、`organizer` 的 `--orange` 同样归位。
- 直接取值归一：`border: 1px solid #d9d4c8` → `var(--line)`、`background: #fffdf8` → `var(--space-component-surface)`、`color: #fff` → `var(--surface)`、`outline: 3px solid #b8351e` → `var(--action)`、`accent-color:#b8351e` → `var(--action)` 等。
- 大小写不一致也归位：`organizer.module.css` 的 `#B8351E`、`#7D776C`。

### 未改动的 CSS 文件（16 个）

`event-discoveries`、`inspiration-catalog`、`novice-workspace`、`project-discovery`、`space-assistant-float`、`space-canvas`、`space-collaboration-overview`、`space-operation`、`space-resource`、`space-teammates`、`space-todos`、`planning/plan-changes`、`skills/ProjectSkillSelection`、`space-changes/space-changes`、`team-supervision/supervision`、`styles/globals.css`。
前 15 个本来就没有与令牌同值的字面值；`globals.css` 按硬约束 4 完全未动。

## 三、已验证

### 1. `tsc --noEmit` → 0

```
node node_modules/typescript/bin/tsc --noEmit
tsc exit: 0
```

> 环境说明：本机 PowerShell 禁止运行 `npx.ps1`，`npx tsc --noEmit` 被 Execution Policy 拒绝。因此改用同一份 TypeScript 5.9.3 编译器的本地入口 `node ./node_modules/typescript/bin/tsc --noEmit`，等价于 `npm run typecheck`。退出码 0，无任何输出。

### 2. `npm run build` → failures: 0

```
✓ Compiled successfully in 18.3s
  Finished TypeScript in 6.5s
✓ Generating static pages using 11 workers (29/29) in 379ms
> postbuild: node scripts/verify-build-tracing.mjs --sanitize
{"manifestCount":63,"changedManifestCount":1,"filteredReferences":106670,"remainingPrivateReferences":0,"copiedPrivateEntries":0,"failures":0}
BUILD EXIT: 0
```

- `failures: 0`。
- 构建期 5 条 Turbopack 警告全部来自 `src/server/*` 的文件系统追踪（`.runtime` 通配、`child_process` 动态路径），与 CSS 无关，替换前已存在。
- 构建命令通过 `npm.cmd` 调用（同样因 Execution Policy 无法直接跑 `npm.ps1`）。

### 3. 改动精确性验证（字节级）

对改动前后逐文件做了证明：把替换前的原文件按同一套规则重放替换，结果必须与替换后的文件**逐字节相等**。

```
exact-match files: 35, mismatched: 0, untouched: 16
```

（该结果在替换完成后立即取得。之后另一会话又改了其中 1 个文件，故现在复跑会得到 34/1/16——见第七节。）

即：35 个文件里除"目标字面值 → `var(--token)`"外**没有任何其他改动**（无空格、无换行、无 BOM、无编码变化），16 个文件逐字节未变。

### 4. 同值证明与"变量遮蔽"检查

- 每一条替换在脚本内都做了 `norm(原文) === norm(令牌值)` 断言，不等即抛错中止。
- 扫描全仓 CSS 的局部变量声明，确认令牌同名变量只在 `globals.css` 的 `:root` / `.palette-1..5` 以及 `organizer.module.css` 的 `.surface { --ink:#352f2a; --muted:#746b63; --line:#e8ddd1 }` 出现。后者是既有的局部覆盖，本轮在该文件只替换了 `--action`（`--orange:#B8351E` 处）和 `--control-line`（`.surface textarea` 的 `border`），**都不在 `.surface` 的遮蔽名单里**，因此解析值不变。
- 逐替换点复核"该令牌是否被同规则或祖先选择器重新声明"：767 个 `var(--token)` 使用点中命中 2 处，均为 `organizer.module.css` 里**替换前就存在**的 `color: var(--ink)`（配合 `.surface` 的有意局部覆盖）。**本轮 235 处替换引入的遮蔽风险为 0**。

结论：在默认皮肤（无 `palette-*` class）下，每个新 `var(--token)` 的解析值与替换前的字面值完全相同，视觉结果不变。

### 5. 构建产物抽查（原生 CSS）

从 `.next/static/chunks/**/*.css` 抽查改动过的类，11/11 全部命中变量：

| 抽查项 | 产物中的实际规则 |
| --- | --- |
| roadshow `.opening` | `.MA5Q0G_opening{background:var(--action)}` |
| roadshow `.primary` | `{background:var(--action,#b8351e);color:var(--surface)}` |
| selection-notices `.kicker` | `._90ue_G_kicker{color:var(--action);…}` |
| sender-settings `.kicker` | `._90ue_G_kicker{color:var(--action);…}` |
| ppt `.warning` | `.DbmqKG_warning{background:var(--warning-bg);color:var(--warning);border:1px solid #b08b4f;…}` |
| ppt `.needsEvidence` | `._6TuomG_needsEvidence{color:var(--warning);background:var(--warning-bg);border-color:#ddc391}` |
| retrospectives `.panel` 局部令牌 | `.DbmqKG_panel{--retro-paper:var(--paper);--retro-surface:var(--surface);--retro-ink:var(--ink);--retro-muted:var(--muted);--retro-action:var(--action);--retro-action-hover:var(--action-hover);…}` |
| site / backend-dashboard `.panel` | `.zF3XJG_panel{background:var(--space-component-surface);…}` |
| organizer `.surface` | `._3_DgQq_surface{--orange:var(--action);--ink:#352f2a;--muted:#746b63;--line:#e8ddd1;color:var(--ink);…}` |
| participation 打印样式 | `@media print{body:has([data-participation-print]){background:var(--surface);color:#000}…}` |

产物中 `var(--token)` 使用计数（15 个令牌合计）：`--action` 204、`--line` 146、`--muted` 135、`--surface` 78、`--space-component-surface` 76、`--ink` 48、`--paper` 33、`--tint` 22、`--warning-bg` 11、`--control-line` 9、`--action-hover` 8、`--warning` 6、`--brand` 2、`--success` 2、`--success-bg` 1。

产物中残留的 `#b8351e` 共 28 处，逐处核对为：25 处 `var(--action, #b8351e)` 回退值 + `globals.css` 的 3 处（`:root` 定义、`.palette-1` 定义、配色预览圆点 `.paletteFabDot[data-palette="palette-1"]`，后者是必须保留项，见第五节第 5 条），**没有应替换却漏掉的残留**。

## 四、未接入

以下位置的底色/前景色与某个令牌相同或近似，但因为**同一份值里还带着透明度或别的信息**，机械换成 `var()` 会改变观感、或需要新增颜色，所以本轮**没有接入**（也未被计入 235）：

1. **带 alpha 的十六进制（7 处）**——`#21201c22`、`#21201c77`（`navigator.module.css`）；`#21201c18`（`site.module.css`）；`#21201c38`、`#21201c70`（`space-invitation.module.css`）；`#21201c24`、`#21201c80`（`resources/components.module.css`）。
   底色就是 `--ink`，但颜色和透明度写在同一个值里，换成 `var(--ink)` 会丢掉 alpha。要接入需要 `color-mix(in srgb, var(--ink) 13%, transparent)` 这类新写法，或新增"半透明 ink"令牌，两者都属于新增颜色，超出本轮授权。
2. **`rgba()` / `rgb()`（模块 CSS 中 11 处）**——按硬约束 3 一律未动。扫描确认其中**没有任何一处**的 RGB 三元组等于令牌色值（0 处），所以这一项对换肤没有影响。
3. **渐变色标**——全仓模块 CSS 只有 2 个 gradient 函数，其中**没有**与令牌同值的色标（0 处）。即硬约束 3 提到的"渐变色标"这一项本轮为空集，没有需要逐案判断的对象。
4. **`--brand`（`#ef4d2e`）在模块 CSS 中没有出现任何同值字面量**（替换 0 处）。若设计上希望某些组件跟随 brand 色，属于改色决策，不在本轮。

## 五、保留未改（列出保留项与原因）

1. **`var(--token, #hex)` 里的回退值——139 处，全部原样保留。**
   分布：`roadshow` 49、`auth/account-controls` 32、`event-official-links` 17、`resources/components` 15、`events/event-completion` 7、`journey` 4、`selection-notices` 4、`team-assistant` 4、`ppt` 3、`organizer-mail-settings/sender-settings` 3、`event-registration` 1。
   令牌分布：`--line` 31、`--action` 25、`--muted` 23、`--ink` 15、`--control-line` 7、`--surface` 6、`--action-hover` 5、`--paper` 5、`--tint` 5、`--warning-bg` 5、`--warning` 5、`--success` 3、`--space-component-surface` 3、`--success-bg` 1。
   原因：这些位置**本来就已经在用变量**，变量优先，换肤**已经生效**，改回退值没有任何收益；而删掉回退值反而降低健壮性（样式表被单独加载、变量未定义时就没有兜底）。硬约束 2、5 也不支持这种无收益改动。
2. **近似色值——569 处 / 363 个不同色值，全部原样保留。**
   与某个令牌"接近但不等值"，按硬约束 1 一律不动。取最容易被误伤的：`#f5f1e8`（14 处 / 5 个文件，与 `--paper` 差 3）、`#faeee8`（9 处，差 5）、`#b3321d`（8 处，与 `--action` 差 5）、`#b64022`（6 处，差 11）、`#fffefa`（6 处，与 `--space-component-surface` 差 2）、`#fbe8e5`（5 处，与 `--tint` 差 3）、`#f7f3eb`（5 处，与 `--paper` 差 1）、`#9d2b18`（3 处，与 `--action-hover` 差 1）、`#9b2b17`（1 处，差 1）、`#fff1d7`（1 处，与 `--warning-bg` 差 1）。
   原因：任务点名 `#b3321d`、`#f5f1e8`、`#b64022` 这类"近似值一律不动"。它们大多出现在半透明叠加、渐变、遮罩或各模块自成一套的配色里，换变量会在某些皮肤下改变观感。
3. **`globals.css` 的 `:root` 与 `.palette-1`～`.palette-5` 变量定义**——硬约束 4，完全未动。
4. **`organizer.module.css` 的 `.surface { --ink:#352f2a; --muted:#746b63; --line:#e8ddd1 }`**——不是"漏掉的令牌"，而是有意让主办方工作区用自己那套正文/次要/描边色。它与全局 `--ink/--muted/--line` **不同值**，按硬约束 1 保留。登记它是因为它会让该作用域内的 `var(--ink)`、`var(--muted)`、`var(--line)` 解析成局部值；本轮在这个文件只替换了 `--action` 与 `--control-line`，两者都不在遮蔽名单里，所以解析值不变。
5. **`globals.css` 的配色预览圆点 `.paletteFabDot[data-palette="palette-1"] { background: #b8351e; }`**——这是全仓唯一一处"在 `globals.css` 里、作为真实取值、且与 `--action` 同值"的字面量（`globals.css` 整文件排除在扫描口径外，故不计入 374/235）。
   **必须保留**：这个圆点用来显示 palette-1 *自己的* 主色，与当前激活哪套皮肤无关。改成 `var(--action)` 后，切到 palette-2 时这个圆点会跟着变绿，预览功能即失效。同理 `.palette-2`～`.palette-5` 的 `#146b57`/`#2f49b0`/`#6534d9`/`#8e2f1e` 也保持原样。

### 附：已替换但需要登记的边界（不是保留项）

- **`@media print` 里的 `background: #fff` → `var(--surface)`（participation 打印样式）**：属于本轮已完成，当前无任何视觉变化（5 套皮肤的 `--surface` 都是 `#fff`）。若将来有皮肤把 `--surface` 改成非白色，打印底色会跟着变。同理，按钮上的 `color:#fff` → `var(--surface)` 在现有 5 套皮肤下完全不变。
- **`selection-notices` 的 `.orange { --notice-accent: var(--action) }`**：该模块另有 `.blue` 分支保持固定蓝色。改成变量后 `.orange` 会跟随皮肤、`.blue` 不会——这是换肤的预期行为，登记以便主会话确认这是想要的效果。

## 六、无法确定

1. **"约 302 处"的原始统计口径无法复现。** 我扫出的是 374 个同值十六进制字面量 = 235（真实取值）+ 139（`var()` 回退值）。任何把回退值计入/部分计入、或统计时点不同的口径都可能落到 302 附近，但我拿不到原脚本，**无法确定**是哪一个。本轮改用更严格、可复现、前后同源的口径（`plain` 计数），并给出完整分解。
2. **未做像素级视觉回归。** 我给出的"视觉不变"是**论证**而非截图比对：`var(--token)` 在默认皮肤下的解析值与原子面值完全相同，且已证明不存在同名局部变量遮蔽。没有运行截图对比（未启动服务、未跑 Playwright）。若主会话要求像素级证据，需要另行安排一次前后截图对比。
3. **近似色值是否应该统一。** `#f5f1e8` 与 `--paper` 只差 3、`#f7f3eb` 只差 1 这类"几乎就是令牌"的值大量存在。它们**是否属于设计上的疏漏、是否应当归并**，属于改色的设计决策，不是机械替换，**无法确定**，因此一律按硬约束 1 保留。
4. **`--brand`（`#ef4d2e`）在模块 CSS 中没有同值字面量**（替换 0 处），这符合扫描结果，但"是否本来就应该有组件用 brand 色"是设计问题，**无法确定**。

## 七、并发工作区说明（重要，供主会话整合时参考）

本工作区同时有其他会话在改文件（`AGENTS.md` 记载的共享目录约定）。为避免把并发改动算到本轮头上，记录如下：

- `src/styles/globals.css`（令牌定义处）在我备份前已于 `10:42:40` 被其他会话改过；我按当前内容读取，15 个令牌值与任务给出的对照表**完全一致**，本轮未改该文件。
- `src/components/team-task-board.module.css` 在我完成替换并被逐字节校验通过**之后**，于 `11:19:41` 被另一个会话继续修改（新增规划 31 第 1.4 项"交接候选" `.handoffChip` 等规则，同时 `team-task-board.tsx` 于 `11:19:32` 被改）。
  影响：该文件现在的最终内容是"我的 3 处替换 + 对方新增规则"的合并结果，**我的 3 处替换仍在**；因此用"替换前快照重放"的方式复核该文件会显示不一致（因为对方新增了内容），这是并发写入造成的，不是替换错误。其余 34 个改动文件仍逐字节一致。
- 另一会话新增的 CSS 已经使用 `var(--control-line)`/`var(--space-component-surface)`/`var(--action)`/`var(--line)`/`var(--muted)`，没有引入新的"令牌同值字面量"；在其写入之后（`11:20:19`）重跑扫描，`plain` 仍为 **0**。
- 验证时间点：`tsc --noEmit` 与 `npm run build` 在 `11:16` 前后完成；`tsc --noEmit` 于 `11:20:42` 在当前树（含对方当时的改动）上复跑，仍为 **0**。构建产物抽查基于 `11:16:37` 的那次构建（`.next/BUILD_ID` 时间戳），该构建已包含本轮全部 235 处替换。`11:19` 之后对方的改动未再重新构建（避免与仍在写入的会话抢构建产物）。

## 八、复现方法

本轮使用三个临时脚本（存放在系统临时目录，**未写入仓库**）：

1. 扫描：解析每个 CSS 文件里与令牌同值的十六进制字面量，并按上下文分类为 `plain`（真实取值）/ `var-fallback` / `gradient` / `url` / `selector-or-prop`。
2. 替换：只替换 `plain`，其余跳过；每条替换前断言同值，替换时按偏移从后往前拼接，保证行尾/BOM/编码不变。
3. 校验：把替换前的原文件重放替换后与替换后的文件做逐字节比较。

临时产物：`C:\WINDOWS\TEMP\palette-audit.mjs`、`palette-fix.mjs`、`palette-verify.mjs`、`palette-artifact-check2.mjs`、`palette-reserved.mjs`、`palette-near-summary.mjs`，改动前的 CSS 快照在 `C:\WINDOWS\TEMP\css-backup\`。
仓库内除本交付文档外**没有新增文件**；扫描脚本临时写到 `.runtime/palette-audit.json` 的结果文件已删除。

## 九、边界与未做

- 未改任何非 CSS 文件（本交付文档除外）。
- 未改 `docs/规划/`、`.specify/` 下的任何文件。
- 未新增颜色、未调整间距/布局/字体。
- 未动 `rgba()`/`rgb()`/`transparent`/`currentColor`，未动 `globals.css` 的变量定义。
- 未执行 `git` 相关操作（本机没有 git 命令）；版本与集成由主会话处理。
- 本次改到了主会话独占目录 `src/styles/` 下的 `src/styles/home.module.css`（3 处 `#fbe9e2`/`#fff`/`#fffdf8` → `var(--tint)`/`var(--surface)`/`var(--space-component-surface)`）。它属于任务范围"CSS 里的同值字面值"，故一并处理；如主会话希望 `src/styles/` 保持独占，可单独回退该文件的这 3 处。
