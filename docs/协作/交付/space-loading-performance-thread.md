# 团队空间加载性能交付

## 最新追加：可见圈选与仅圈选组缩放（2026-10-12）

状态：**STOP，源码、测试及本记录已停止编辑，交还主会话。** 两份 TSX 已提前声明“源码已冻结，可构建”。本轮没有构建、启停服务、实际迁移、配置变更或生产数据库操作，也没有修改主会话持有的 CSS。

### 本轮精确文件范围

- `src/components/space-canvas-board.tsx`
- `src/components/space-path-canvas.tsx`（主会话追加授权）
- `src/modules/space-workflow/canvas-gestures.ts`
- `src/modules/space-workflow/canvas-gestures.test.ts`
- `tests/e2e/space-usability.spec.ts`
- 本交付记录。

### 已完成

- 外层空白画布和流程内部空白都支持桌面左键按下立即拖框，不再因450ms内移动超过8px而取消。按下期间保留最小可见框，松开后移除框并保留圈选；短点空白或Esc取消。触屏原长按/移动取消逻辑保留，手机仍单列排序。
- 只有圈选集合授予缩放资格。单组件/节点长按拖动不会自动选中；未选项上的滚轮不取消默认事件、不改选择、不写布局。Ctrl/Cmd滚轮继续交给浏览器。
- `scaleCanvasGroup` 使用全组选中项的左上共同锚点，同一倍率同时作用于各成员坐标和scale。任一项到0.5/2边界会限制整组倍率，不分别截断各项；保留原宽度、折叠等其它字段。
- 外层选中卡片非编辑区的滚轮统一缩放整组，一次更新交给原去抖/CAS保存流程。菜单“缩小选中项/放大选中项”作用于整组；“恢复100%”以当前菜单指向项为目标计算全组倍率，受全组上下限限制。“窄一点/宽一点”仅在单独圈选该项后启用，避免修改多选组内相对宽度。
- 流程内部的滚轮、菜单和Alt正负号统一使用圈选组缩放；未圈选时菜单禁用、Alt正负号不被截获。节点菜单区域不抢滚轮。原真实行动短按打开、长按整组移动及内外手势互斥保留。
- 保留主会话新增的 `layoutReady` 挂载门控和 `data-component-kind`。未改主会话最新组件暖白底、文档/流程例外及2px虚线圈选样式。

### 验证与待根验收

- **通过**：`node --experimental-strip-types --test src/modules/space-workflow/canvas-gestures.test.ts`，15/15。新增共同锚点和比例、上下限统一约束、以指向项恢复100%、反向倍率还原小数坐标及非法输入检查。
- **通过**：`node node_modules/typescript/bin/tsc --noEmit --incremental false`，退出0。
- **通过测试发现/解析**：`node node_modules/@playwright/test/cli.js test tests/e2e/space-usability.spec.ts --list`，9项。
- **本轮未执行新构建浏览器验收**：按主会话要求交回后统一执行。旧“九类未圈选即缩放”用例已改为九类长按移动不授予选中、圈选前无布局写入、圈选后实际滚轮缩放。新增外层组倍率/上限/恢复100%/重载/原生滚动，以及流程选中组滚轮/菜单/键盘/重载/外层零写入；原整组拖动、短按弹窗、手机资料与行动入口回归保留。
- 建议根对新构建执行：`node node_modules/@playwright/test/cli.js test tests/e2e/space-usability.spec.ts --workers=1 --output=.runtime/selection-scale-e2e --reporter=line`，使用根指定 `E2E_BASE_URL`。未声称线上、实体手机或新构建的实际浏览器检查已通过。

### NEEDS_INTERFACE

没有新增Port、环境变量、迁移或依赖。早先发现的归一化舍入会破坏组内比例：主会话已接手并报告完成 `canvas-board.ts` 的坐标/scale及 `graph-layout.ts` 的位置/scale精度修复，并通过根持有的54项几何/往返检查；本会话未覆盖这些文件。CSS增强也由主会话持有，无待本会话接入项。

---

## 历史交付：加载性能（此前已STOP，以下为当时记录）

日期：2026-10-12。

状态：**STOP，停止编辑并交还本轮全部临时文件。** 按主会话最新消息只补此记录，不再运行浏览器、类型检查或等待构建。未构建、未重启服务、未读取生产 PGlite；只使用现有网站的页面/静态资源 GET 与现有隔离内存数据库夹具。

## 授权范围与改动

- `src/components/project-client.tsx`：16个分区/设置组件改为 `next/dynamic` 命名导出加载，包括队友、规则、赛道、分工、计划、测评、交付、仓库、资源、技能、复盘、经验与项目操作。只渲染当前 section 的组件；保留原 props、权限来源、刷新方法与项目 key。加载中使用现有 Loading，不改业务接口或样式。默认 SpaceOperationDeck 保持直接导入，避免给画布入口再增加一段按需加载等待。
- 空间设置首次展开前不挂载 ProjectActions，所以不发 `/teams` 与当前项目 `/activity`。首次展开后保持挂载，关闭/重开以及项目刷新保留未提交表单；换项目时 details 的项目 key 与 settingsProject 状态使新空间恢复未打开。原 `#space-settings` hash 自动展开继续有效。
- 新 `tests/e2e/space-loading-performance.spec.ts`：9个回归，覆盖设置关闭零请求、首次挂载、折叠保留草稿、hash打开，以及team/rules/assessment/plan/delivery/resources/retrospective七个路由的实际编辑器入口。
- 本交付记录；审计日志只在 `.runtime/perf-space-*`。未改根正在处理的 client-api、inflight-read、Navigator、SiteShell、首页、board 或其它文件。

## 可复核的实测基线

使用当前运行的旧构建，Playwright Edge 清浏览器缓存，页面/静态资源从 `127.0.0.1:3000` 读取；所有 API 经现有 isolatedWorkspace 分派到独立内存数据库，账号/空间均为虚构夹具。未记录cookie、正文或生产账号数据。

| 场景 | 首个组件出现 | 初始API数 | 不同API数 | 重复读取 | JS请求/传输 |
| --- | ---: | ---: | ---: | ---: | --- |
| 默认6组件 | 441ms | 32 | 23 | 9 | 14个 / 429757字节，约419.7KiB |
| 已保存仅AI一组件 | 396ms | 35 | 23 | 12 | 同上 |

- 本地页面TTFB约5.5–6.5ms，首屏绘制112–120ms；这个小型隔离空间没有复现数秒的服务器等待。不能把这些数字当公网、真实大项目或实体手机速度。
- 默认首屏重复：`GET /me` 3次；项目 `rules` 3次、`official-tracks` 3次、`my-intention` 2次、`my-availability` 2次、`plans/current` 2次。五条项目读取合并同一时刻的请求最多消除7次重复，`/me`另消除2次。
- 保存仅AI布局仍发35次的原因是默认6组件先挂载，布局返回后拆掉；隐藏path opener又读一次plans/current/rules/tracks，后3条约在422–427ms开始。主会话已采纳board等待layoutReady再挂载，当前会话未改board。
- 设置保持关闭时，ProjectActions仍已挂载并读取teams/activity；本次授权修复这2条。旧Navigator在未打开时读取intro、conversation、projects；主会话已自行修复，不重复修改。
- 15秒实际观测3条轮询：当前项目、plans/current、shared-intentions；该轮各约24ms。源码另有30秒SpaceChanges reconcile+GET与TeamSupervision读取/启用后的检查，二者不作为本轮随意删除的目标。
- 初始14个JS中最大应用块解压395778字节/线上传输117957字节。其内包含画布、交付、技能等代码。静态runtime import遍历可到133个源码文件，含14个以上业务模块；这是源码依赖证据，不表示全部代码都保留在最终包内。本次只切project-client的分区入口，path及其它静态依赖仍可能令部分共享模块进入首包，实际减包字节须根重建比较。

日志：

- `.runtime/perf-space-waterfall.json`：默认布局实际瀑布、API计数、静态文件尺寸、15秒轮询。
- `.runtime/perf-space-minimal-layout.json`：保存仅AI布局仍先发默认组件请求的证据。
- `.runtime/perf-space-static-imports.json`：源码静态依赖统计。
- `.runtime/perf-space-project-client-isolated.json`：本次入口/设置隔离验证结果。

## 给根client-api的精确读取合并建议

仅浏览器端**同时在途**GET、无body、无idempotencyKey、无长期结果缓存，可在根现有 `/me`、`/system/status` 之外加入精确项目路径白名单：

```text
^/projects/[^/]+/(rules|official-tracks|my-intention|my-availability|plans/current)$
```

| 路径后缀 | 默认布局实测次数 | 调用方 |
| --- | ---: | --- |
| rules | 3 | SpaceTodosPanel、SpaceCollaborationOverview、SpacePathCanvas |
| official-tracks | 3 | 同上 |
| my-intention | 2 | SpaceTodosPanel、SpaceCollaborationOverview |
| my-availability | 2 | 同上 |
| plans/current | 2 | SpaceCanvasBoard、SpacePathCanvas |

保留根现有写请求前失效、调用方独立Abort等待、结果clone及401清理；只共享同时在途请求，后续reload必须真正重新验证当前权限和事实。不要把 `space-changes/reconcile` 或 `team-supervision/check` 的POST纳入，也无需扩大到任意带query的GET。

隐藏 `SpaceAssistantFloat` 没有预读：源码由 `mounted && <SpaceAiAssistant>` 控制，首次打开前不挂载；两份瀑布没有空间AI历史请求。只是代码目前静态导入 `space-ai-assistant.tsx`。邀请弹窗也在首次打开前不挂载其业务组件。下一阶段若要继续减包，可另授权 `space-assistant-float.tsx` / `space-invitation-trigger.tsx` 的动态导入，以及path弹窗业务表单拆分；本会话未改这些文件。

## 验证边界

- 实际加载本次 project-client 和 ProjectActions TSX 的隔离React浏览器验证通过：首屏未加载分区编辑器/设置；首次打开读取；关闭重开和父层刷新保留输入；切换项目关闭设置；hash开启；七种section只挂相应编辑器；没有业务写入/浏览器异常。`next/dynamic` 在此使用隔离异步加载器，真实Next拆包效果不据此宣称。
- 新e2e文件的7个 `direct ... navigation` 用例，在当前运行旧构建+真实隔离处理器上 **7/7通过（11.9s）**，确认选择器和业务入口。它们不是新动态包的发布证明。设置两项新行为留给根重建后执行整个9项文件。
- 本会话类型检查时，仅遇到根 `src/server/site-search-sources.test.ts` 第42/109/134行夹具缺少新增version的3个范围外错误，未越界修改；主会话随后通报最新全局类型检查已通过，并要求不再重复运行。
- 根验收命令：`node node_modules/@playwright/test/cli.js test tests/e2e/space-loading-performance.spec.ts --workers=1 --output=.runtime/perf-space-e2e --reporter=line`；使用根指定的新构建baseURL。之后比较同条件JS传输与首屏请求数量，不能用源码文件数量替代线上下载收益。

## NEEDS_INTERFACE

无新增模块、Port、环境变量或迁移需求。后续读取去重、board挂载控制和构建均由主会话持有。
