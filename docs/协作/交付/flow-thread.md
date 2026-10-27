# C02 · 自由流程节点交付

日期：2026-10-12。依据宪法 v1.18.0、规划29及主会话本轮精确授权。

## 已完成

- `src/components/space-path-canvas.tsx` 的默认 `presentation="canvas"` 展开 guide-tree 的全部16个行动、40个原有链接/工具，共56个节点、55条主线/资源连线。六段仅为轻量方向标识，节点使用短标题与真实派生状态；说明、核对条件和下一步点开阅读。画布模式详情也去掉重复标题和整段行动标签，`steps` 阅读模式保留。
- 原目标、本人可用时间、职责意愿、官方赛道、规则、资料、任务与交付入口继续复用。`onReady` 可以打开精确 guide 行动 ID，例如 `duties-time`，未知 ID 不打开其他步骤。资源使用 guide-tree 原始 href，标题精简不改目的地；归档继续只读，不新建完成状态。
- 每个行动及资源均可450ms长按移动，没有抓手；未激活移动超过8px取消，短按与 Enter 打开正常，拖后抑制鼠标/触摸 click，键盘激活仍可立即使用。普通文字选择保留。
- 普通 wheel 仅缩放悬停节点，范围0.5–2，节点带 `[data-graph-node]`，原生非 passive 监听调用 `preventDefault`/`stopPropagation`。编辑输入优先；位置与缩放快速变化从同一最新 ref 合并，帧内合并绘制、180ms合并本地保存。
- 浏览器实际未缩放宽高先测量，再按节点 scale 计算边界与 SVG 锚点。桌面取消窄外框/内部视口，自身实际 width/height 和 `data-space-flow-width` / `data-space-flow-height` 暴露给父画布测量，默认右下各留320px空白。SVG始终指针穿透。
- 独立新版键：`hackathon.space.flow.v2.desktop.<project>.<user>` 和 `hackathon.space.flow.v2.mobile-order.<project>.<user>`；不读取/覆盖旧六框位置键。手机单列和双连线通道由独立排序派生，桌面坐标及 scale 原值保留。菜单及 Alt+方向键提供位置调整，桌面菜单/Alt+正负号提供缩放。
- 手机使用媒体查询及 document viewport 判断宽度，避免初次宽图把 `innerWidth` 撑大。指针捕获放在稳定表面，防止实时重排 DOM 丢失捕获。没有全节点 `touch-action:none`；只在长按 active 后通过非 passive touchmove 阻止滚动。保存本地偏好失败明确保留屏幕调整并提示未保存。

## 实际验证

1. `node --experimental-strip-types --test src/modules/space-workflow/graph-layout.test.ts src/modules/space-workflow/guide-tree.test.ts src/modules/space-workflow/step-state.test.ts`：31/31通过，其中 graph-layout 12项。覆盖行动/资源完整连接、无默认重叠、留白、实际宽高先测量后缩放、移动后面对边锚点、手机双通道/180–390px宽度、版本键/账号隔离、原事实和链接不变。
2. `node node_modules/typescript/bin/tsc --noEmit --incremental false`：最终退出0。首轮曾遇到 C01 修改中的 `editing` 引用错误；本会话没有越界修改该文件，后续全项目复查已通过。
3. 已安装 Edge/Playwright 运行隔离浏览器夹具，使用本轮实际 TSX、CSS、guide-tree、graph-layout 和 step-state；仅 API 数据及既有业务面板采用测试替身。验证56节点/55连线、鼠标短按、Enter、精确 guide ID、8px取消、普通滚轮阻断父级缩放、450ms拖动及 click 抑制、线随移动更新、菜单/键盘移动缩放、手机无横溢及独立排序、恢复桌面 scale、归档目标只读。资源节点另外验证父容器0.8缩放下的自身缩放和长按移动、Enter 导航至原始 `/journey` href。
4. 同一隔离夹具采用 `isMobile/hasTouch` 与 CDP 触摸事件验证：手机短按打开；450ms前从行动节点起手纵向滑动产生真实浏览器滚动且未进入拖动；450ms后长按移动排序并保存，未误开弹窗且未滚动页面。模拟结果不代表实体触屏通过。

夹具仅在系统临时目录产生转译文件及本机临时HTTP服务，没有构建或启动项目网站，没有读取 `.env.local`、连接任何数据库或调用外部服务。最终夹具目录：`C:\Users\27736\AppData\Local\Temp\c02-flow-QQgk6z`；复查脚本：`C:\Users\27736\AppData\Local\Temp\c02-flow-browser.cjs`。

## 未验证 / 根验收

- 实体手机、iOS/Safari、实际浏览器选字/长按手势及真实设备差异仍待根验收。
- 隔离夹具中的业务面板为替身；原时间/官方赛道/规则/任务/交付表单的真实写入、权限和生产数据流程不在本会话验证范围。原业务组件与服务没有改动。
- 与 C01 最终父画布尺寸测量、外层缩放/摆放/串行远端保存的组合，以及完整网站浏览器回归、生产构建和服务切换由主会话执行。本会话只验证子节点缩放阻止冒泡及在父缩放下的坐标换算。

## NEEDS_INTERFACE

无新增业务接口、SQL建议、环境变量或依赖。父画布可读本组件 section 自然宽高，或读取上述 `data-space-flow-width/height`；手机断点与 C01 使用的760px保持一致。

## 所有权交还

本会话仅编辑获授权的 `space-path-canvas.tsx`、`space-canvas.module.css`、`space-workflow/graph-layout.ts`、`graph-layout.test.ts` 和本交付说明。

**STOP：交付完成，停止编辑，以上文件交还主会话。**
