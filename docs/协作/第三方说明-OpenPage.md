# 第三方说明：OpenPage（视觉与交互参考）

本项目的主办方专属页编辑器**参考**了 OpenPage 的编辑器外壳结构与交互形态：

- 仓库：https://github.com/buildingopen/openpage
- 许可：**MIT License**（Copyright (c) OpenPage contributors）
- 采用时间：2026-10-18

## 采用了什么

| 部分 | 我们怎么用 |
| --- | --- |
| 三栏编辑器布局（左：组件箱 + 层级；中：画布 + 工具条；右：属性） | 按此结构重写 `src/components/event-site-editor.tsx` |
| 画布上块级悬浮工具条（选中/悬浮才出现，↑↓✎＋✕） | 体现在 `BlockFrame` |
| 层级列表（选中后滚入视野） | `styles.layers` 列表 |
| 工具条上的档位切换（1440 / 768 / 375） | `styles.canvasToolbar` |
| 快捷键帮助面板 | `styles.modal` + `?` 按钮 |
| 空白画布引导 | `styles.emptyHint` 与「想法画布」提示 |

## 没有采用什么（与原项目的关键差异）

1. **数据模型不同**：OpenPage 的区块是自由 `props` 包 + 主题系统；本项目是**封闭区块注册表**，服务端 `parseSpec` 校验、事实只能绑定、动作只能跳平台页、手机语义由引擎派生。
2. **样式体系不同**：本项目只用既有设计令牌与 CSS Modules，**不引入 Tailwind**，也不引入 OpenPage 的主题（颜色/字体/圆角）系统。
3. **不采用**它的 19 个营销区块、HTML 导出、JSON 抽屉、Gemini 生成。

因此这里**没有复制其源代码**，只借鉴结构与交互；如其后确有代码片段被直接采用，须在此逐文件标注并保留 MIT 版权声明。
