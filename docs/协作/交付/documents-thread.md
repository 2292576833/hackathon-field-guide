# C03 · 正文文档独立会话交付

日期：2026-10-12。依据宪法 v1.18.0、规划29与主会话的 C03 精确授权。

状态：**STOP，停止编辑，以下四个文件交还主会话。** 模块交付不表示浏览器验收完成或新版已经发布。

## 文件范围

- `src/components/space-documents.tsx`
- `src/components/space-documents.module.css`
- 新 `tests/e2e/plain-space-documents.spec.ts`
- 新本交付说明 `docs/协作/交付/documents-thread.md`

未修改服务端、共享契约、既有浏览器测试、公共规划、配置、依赖或迁移；没有构建、启停网站、打开生产数据库或发送邮件/模型请求。按独立会话要求没有转交子代理。

## 已完成

- 默认只呈现带一层边框的正文与角落 `⋯` 菜单。去掉空间文档 h2、文档常驻标题、标题表单、空状态段落、权限介绍和常驻刷新行。读取中、错误、归档及未保存状态继续明确显示。
- 新建文档只写正文，内部 title 取首个非空行 trim 后的前200字符；正文不 trim，保留空行和末尾换行。已有文档只提交 body 与 expectedRevision，保留原内部 title。
- 正文使用普通文本节点，HTML样式文字不执行；复制只包含完整正文，不再前置隐藏的 title。
- textarea 随内容增加高度，并在窗口/组件宽度变化时重新测量；正文不设固定高度、max-height 或内部滚动，手机自动换行。正文外框标记 `data-space-document-body`，内部纯文本标记 `data-space-document-text`。
- 保存、复制正文/草稿、编辑、允许/收回队友编辑、刷新、加入私人备忘、作者删除与复制文档位置均进入正文框的小菜单。菜单支持键盘打开、Escape关闭和焦点恢复；菜单标记 `data-canvas-options`，供画布避免菜单滚轮触发缩放。
- 保存前菜单明确提示“保存后，本空间成员可读”，只在服务真实返回成功后显示保存确认；打字不发创建/编辑请求。
- 编辑草稿按文档保存于当前组件状态。409后刷新真实版本但保留草稿、禁用旧版本保存并提供完整复制及明确放弃草稿入口。撤回共享、删除、归档或成员撤销后，已在本页编辑的草稿仍保留为可复制的只读内容。
- 服务返回 PROJECT_ARCHIVED 时立即关闭当前旧页面的文档写入口，同时保留新建与编辑草稿。原服务的账号、活跃成员、作者、共享编辑和归档校验没有改写。
- 私人备忘只在真实 POST 成功后触发 `hackathon:space-todos-changed`，携带 projectId；复制位置只写剪贴板，不发送给别人。
- 文档 id 继续作为页面锚点；正文异步读取完成后处理 `#space-document-…` 定位，配合画布的锚点展开逻辑。

## 实际验证

以下命令在本会话实际执行并通过：

1. `node node_modules/typescript/bin/tsc --noEmit --incremental false`：全项目类型检查通过。直接执行 `npm run typecheck -- --incremental false` 曾因当前依赖目录缺少可调用 tsc shim 失败；随后调用现有 TypeScript 的实际入口通过，没有安装依赖或改配置。
2. `node node_modules/typescript/bin/tsc --noEmit --target ES2022 --module esnext --moduleResolution bundler --allowImportingTsExtensions --jsx react-jsx --esModuleInterop --skipLibCheck --strict tests/e2e/plain-space-documents.spec.ts next-env.d.ts`：新浏览器测试及其导入类型检查通过。
3. `node --experimental-strip-types --test src/server/space-documents.test.ts`：既有文档服务12项测试全部通过。服务端文件仅只读，测试使用专属内存 PGlite 和实际文档迁移，不读取生产目录或 `.env.local`。
4. `node node_modules/@playwright/test/cli.js test tests/e2e/plain-space-documents.spec.ts --list`：7个新增浏览器场景成功枚举。

## 隔离测试与未验证边界

服务12项验证是真实内存 PostgreSQL 引擎下的业务与权限测试，不能替代生产持久库、多连接远程 PostgreSQL 或浏览器视觉验收。

新增7个浏览器场景使用现有 `ux-test` / `isolated-workspace`：页面服务只供应UI资产，API由实际 application/router/handlers和已迁移的专属内存数据库处理，账号来自夹具验证码；拦截跨源请求，不用真实验证码、不发邮件、不调用模型、不写生产数据库。脚本已枚举和类型检查，**没有实际运行浏览器**，按授权留给主会话统一执行。

覆盖：

1. 375px默认只有带框正文、无标题输入/常驻权限说明；手动保存前不发布，首行生成内部标题，菜单键盘与Escape。
2. 长文全部可选择/复制、手机自动换行，HTML保持纯文本；私人备忘真实保存及事件、复制位置和打开异步文档锚点。
3. 未共享队友只读，作者允许后队友真实保存，长编辑器自然增长，已有title不改；收回权限以及作者真实删除。
4. 409真实响应不覆盖新版本、完整草稿仍可复制、旧版本保存禁用，明确放弃后读取新正文。
5. 已归档正文仍可读可复制；写入口隐藏，create/edit/share/remove实际handler均拒绝。
6. 编辑中的旧页面遇到归档时保留新建及编辑草稿，关闭保存，不报成功。
7. 当前成员被撤销后旧编辑器实际写入/重读均拒绝，本页草稿保持只读可复制。

主会话可在自己的隔离页面服务就绪后执行：

```powershell
node node_modules/@playwright/test/cli.js test tests/e2e/plain-space-documents.spec.ts
```

若使用主会话另设的页面服务地址，沿用其 E2E_BASE_URL。C03没有启动任何页面服务。

未完成浏览器实跑、截图/视觉核验、C01长按框沿/选字与滚轮缩放集成核验、生产构建/切换或真实试用验收。

## 未接入与 NEEDS_INTERFACE

业务继续使用已有真实 space-documents / space-todos API，无新增 Port、迁移或接口缺口。

主会话集成时需要注意：

- C01应使用正文外框 `data-space-document-body` 判断框沿，框内文本和textarea保留选字；菜单使用 `data-canvas-options` 排除滚轮缩放。
- 新测试替代文档旧呈现断言。现有 `tests/e2e/space-redesign.spec.ts` 的文档断言仍期待常驻标题/操作、`复制全文`和旧标题+正文剪贴板格式，已不符合规划29；该文件未获C03授权，留给主会话按最终UI更新，不把旧断言失败算作新需求回退依据。
- 当前草稿只保留在本页组件状态中；刷新整页、离开页面或切换导致组件卸载仍会结束本页草稿，未增加第二套草稿持久存储。

## 环境变量

无新增业务环境变量或密钥。浏览器夹具使用已有可选 `E2E_BASE_URL`，仅允许loopback页面服务。

## 交还

**STOP。C03完成本次授权范围内的实现、类型检查、服务隔离测试及浏览器脚本准备，从本说明写入后停止编辑。构建、启停、浏览器实跑、公共文档同步及最终验收由主会话接回。**
