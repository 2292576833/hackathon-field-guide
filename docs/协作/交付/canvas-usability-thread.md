# 画布交互、刷新与两层圈选交付

日期：2026-10-12。依据主会话本轮精确授权及两次圈选追加任务。

状态：**STOP，代码已稳定并停止编辑，所有临时文件交还主会话。** 最后一次代码修改仅清理图内新短按继承的尾随点击状态；随后全项目类型检查通过。未构建、未启动/重启网站、未访问生产数据库、未修改配置/依赖/真实迁移。

## 本轮文件

- `src/components/space-canvas-board.tsx`
- `src/components/space-canvas-board.module.css`
- 新 `src/modules/space-workflow/canvas-gestures.ts`
- 新 `src/modules/space-workflow/canvas-gestures.test.ts`
- 追加交接的 `src/components/space-path-canvas.tsx`、`src/components/space-canvas.module.css`
- 本说明。

保留主会话在 path 文件中的行动直达、目标 hash 打开、建议节点和只显示行动的图构造修改。未覆盖队友/文档/业务表单组件及根浏览器测试。

## 已完成

- 去掉外层拖动虚线框，以及 card/canvasViewport/canvas 非交互容器程序聚焦产生的大轮廓；流程节点拖动也改用轻提示。按钮、链接、summary 的键盘 focus-visible 保留。
- 九种外层组件共用无边框留白：左右/上方16px，下方26px；悬停出现轻量操作提示，手机显示顺序提示。没有增加抓手、额外文档边框或重复标题。既有保存宽度含这些留白。
- AI 启动按钮、外层折叠后的“＋”为显式长按白名单：450ms 长按移动，释放后仅抑制该指针的尾随点击；新短按及键盘操作仍打开/展开。其它业务按钮和 summary 不被变成拖动按钮，其组件周围留白可拖动。
- 输入框、textarea、contenteditable、文档正文选字、弹窗和布局菜单保留自身操作。文档不再要求精准命中约6px边沿；即使 textarea 保持焦点，鼠标移到外侧留白也能滚轮缩放。普通正文区域在同组件编辑器聚焦时保留原生滚动。
- 后台15秒 GET 刷新已有计划快照时不再向 common/倒计时传递首次读取 loading；失败明确显示并传给子面板，下一轮重试期间继续保留失败提示，成功后才清除。首次无数据 loading 保留。
- 外层画布空白左键长按450ms后拖框，松开完成多选；再长按任一选中组件的空白处整组平移。左/上边界整组约束，组件间距、各自尺寸/缩放不变；一次布局更新走原串行 revision/CAS 保存。
- 流程图自身空白同样支持长按圈选节点；长按选中行动节点整组移动，使用图内坐标，正确扣除外层组件缩放和页面/画布滚动影响；整组一次 localStorage 保存。节点短按仍打开对应真实行动。
- 只在拖框过程中存在圈选矩形；松手后只保留每个选中项旁的小点，没有包住整个画布或整组选区的大框。空白短点清选择；Esc 取消活动预览并清选择，不保存取消结果。窗口失焦、指针取消/捕获丢失也撤销活动预览。
- 图内 pointer 事件先 stopPropagation，外层对整个 `data-space-flow-surface` 避让。内外开始新手势时按项目+账号广播私人手势归属，取消另一层候选/活动手势与选择，避免两层混跑。该事件只处理浏览器私人摆放，不增加业务接口/权限。
- 手机继续原单卡/单节点排序，不启用圈选；外层手机排序只改 items 顺序，不改桌面坐标/缩放，图内手机继续独立顺序存储。

## 已验证

- `node --experimental-strip-types --test src/modules/space-workflow/canvas-gestures.test.ts src/modules/space-workflow/canvas-board.test.ts src/modules/space-workflow/graph-layout.test.ts`：**53/53通过**。新测覆盖刷新失败重试、编辑/节点优先、点击隔离、反向圈选、缩放坐标、整组边界约束及字段保留。
- `node node_modules/typescript/bin/tsc --noEmit --incremental false`：**全项目通过**，最后一次在全部代码修改后完成。
- 本机 Edge headless 隔离浏览器实际加载 board/path/assistant 的 TSX 编译结果和 CSS；业务面板/数据读取使用夹具，内存 HTML 路由，不启动网站、不访问数据库。已通过：九种组件存在且初次零 PUT；非交互容器聚焦无轮廓；九种组件普通滚轮与实际长按；聚焦文档 textarea 不被抢滚动而外侧可缩放；AI 长按不误开而下一次短按可开；外层2卡圈选/整组移动一次CAS；Esc取消无保存；业务按钮短按与图内滚轮隔离；图内2节点圈选/移动一次本地保存且外层零CAS；外层1.05倍时图内位移换算；图内拖动后短按打开；刷新时内容保留、失败重试不冒充最新、成功清失败；无浏览器错误。

隔离夹具不等于生产页面验收。主会话正在使用自己的 `.next-usability-review` 构建和 `space-usability.spec.ts` 完成真实处理器验收；实际手机触摸/原生选字仍以根浏览器及设备结果为准。

补充隔离检查也通过了折叠“＋”长按移动/短按展开，以及后开始的内外手势清除另一层选择。手机补充夹具未完成：夹具把两个 CSS Module 都映射成原始类名，path 的同名 `.canvasViewport` 手机规则误隐藏了外层画布，导致测试取不到边界；真实构建使用独立 CSS Module 类名，未据此更改产品代码。手机结果仍待根真实构建验收。

## 根浏览器操作与稳定标识

1. 外层：在画布 `[data-mobile="false"]` 的真正空白点按住鼠标左键至少450ms，再拖过两卡可见边界。活动框为 `[data-canvas-marquee]`；释放后它必须不存在，选中项为 `[data-instance-id][data-selected="true"]`。
2. 长按选中卡的外侧留白后移动。`[data-instance-id][data-dragging="true"]` 应含整组选中项，释放应只有一次 space-canvas PUT；各项 x/y 增量相同，负向越界时整组同停。纯圈选、空白短点、Esc不应发 PUT。
3. 所有9种 kind：todos/overview/path/teammates/documents/supervision/assistant/deadline/scope。推荐命中卡矩形左上角内5px的留白；先滚动使该点避开粘性页头。不要用正文/textarea或图内空白作为外层拖动目标。
4. AI 按钮及折叠“＋”带 `[data-canvas-longpress]`；分别验证短按、450ms长按后移动、长按后下一次短按、Enter/Space。普通业务按钮/表单不带该属性。
5. 图内：在 `[data-space-flow-surface]` 真正空白按住450ms后拖过 `[data-graph-node="action:goal"]` 与 `[data-graph-node="action:invite"]`。活动框 `[data-flow-marquee]`；选中节点 `[data-flow-selected="true"]`；外层不应被选中或拖动。
6. 长按选中的图内行动节点后移动。`[data-graph-node][data-dragging="true"]` 应为整组；松手只有一次图位置 localStorage.setItem，不能发外层 PUT，不能误开业务弹窗；接下来一次短按应打开当前行动。外层缩放0.5/2倍时换算后的图坐标增量应相应为屏幕增量的2/0.5倍。
7. 外层已有选中项时再开始图内手势，外层选择立即清除；反过来也一样。图内菜单和弹窗不用作圈选起点。ctrl/meta滚轮保留浏览器行为。
8. 短点对应层的真正空白取消选择；Esc取消活动圈选/整组预览后坐标及存储不变。手机宽度下无圈选，仍能单项排序。
9. 延迟15秒轮询响应：已有任务/队友/范围内容保持；模拟错误再重试，错误不能在请求尚未成功时消失；首次读取仍有 loading。

## 未接入 / NEEDS_INTERFACE / 环境

无新增业务 Port、迁移或环境变量。真实站点构建、部署、跨浏览器/实体手机验收由主会话负责；本说明不宣称已经发布。
