# form-guide · 表单步骤指引（纯逻辑）交付

日期：2026-10-18。依据：`docs/规划/36-AI工作台、组队大厅与全流程效率.md` §2.2、
`docs/规划/35-主办方自助建站与AI页面生成.md` §19.4、宪法 v1.24.0（原则 XIII 助手只读只出草稿、
XIV AI 生成内容须人工确认、II 事实必须可追溯、XII 不编造）。

授权文件范围：**仅新增** `src/modules/form-guide/`（model / steps / hints / index / README / 4 个测试）
与本交付。未编辑 `src/app`、`src/server`、`src/shared`、`src/components`、`migrations` 或任何其他模块的现有文件。

## 1. 已完成

把「一张表单怎么分步、每栏一句人话、哪些能预填」做成纯逻辑模块，供 AI 工作台调用：

| 能力 | 入口 | 说明 |
| --- | --- | --- |
| 分步 | `planSteps(schema, options?)` | 稳定步骤数组，每步 2–4 栏、步内按 schema 顺序、必填优先、不丢字段 |
| 提示 | `attachHints(steps, hints)` | 每条 1–80 字、无控制字符、只能指向该步真实字段；非法逐条丢弃并计数 |
| 预填 | `applyPrefill(steps, prefill)` | 只填 text / textarea / date / select；checkbox 与必填 textarea 不填 |
| 拟稿标注 | 每栏 `origin: 'user' \| 'ai' \| 'empty'` | 预填栏标 `ai`，界面据此显示「AI 拟稿」 |
| 组合 | `buildFormGuide({ schema, steps?, prefill?, hints? })` | 一次给出步骤、跳过清单、丢弃清单、`aiDraftedFields` |
| 取消标注 | `markFieldOrigin(steps, field, 'user')` | 本人改过 AI 拟稿后撤掉标注 |

文件：`model.ts`（契约 / 校验 / 错误码）、`steps.ts`（分步 + 预填）、`hints.ts`（提示）、
`index.ts`（出口 + buildFormGuide）。

**模块不持有任何表单定义**：无内置字段、无内置白名单、无默认表单；`formId` 只认调用方给的 schema
或调用方给的白名单，取不到就是 `FORM_GUIDE_UNKNOWN_FORM`（404）。

## 2. 数据契约

```ts
GuideSchema      { formId, fields: GuideSchemaField[] }
GuideSchemaField { name, label, type: 'text'|'textarea'|'select'|'date'|'checkbox',
                   required, options?, maxLength? }
GuideStep        { id: formId:step-N, formId, index, fields[], fieldCount,
                   requiredCount, prefillableCount }
GuideField       { name, label, type, required, options[], maxLength|null,
                   schemaIndex, value|null, origin, hint|null }
applyPrefill  →  { steps, filledFields[{field,stepId,stepIndex,value,origin}],
                   skippedFields[{field,reason,detail}] }
attachHints   →  { steps, accepted, dropped[{index,field,stepId,reason,detail}],
                   droppedCount, hintCount }
```

约束：`accepted + droppedCount === hintCount`；`filledFields` 按步骤顺序；
`origin === 'ai'` 的栏必须在界面标注「AI 拟稿」，本人确认后才写草稿。
错误码：`FORM_GUIDE_INVALID_SCHEMA` / `FORM_GUIDE_UNKNOWN_FORM`（404）/ `FORM_GUIDE_UNKNOWN_FIELD` /
`FORM_GUIDE_INVALID_OPTIONS` / `FORM_GUIDE_INVALID_STEPS` / `FORM_GUIDE_INVALID_HINTS` / `FORM_GUIDE_INVALID_PREFILL`，
全部是 `DomainError`（`name` 回写为 `DomainError`，可经既有 HTTP 边界透出）。

## 3. 分步规则

1. **不丢字段、不重复**：每栏恰好一次，`schemaIndex` 保留原位置。
2. **每步 2–4 栏**：默认 2/4；整张表只有 1 栏时允许 1 栏一步（唯一例外）。
3. **步内顺序与 schema 一致**：一屏内的栏按 schema 原顺序排，模块从不改标签或栏序。
4. **必填优先**：跨屏看，任一必填栏的步序号 ≤ 任一选填栏的步序号（先把必填按 schema 顺序排完，再排选填）。
   整张表 ≤ 4 栏时全部落一屏，栏序就是 schema 顺序。
5. **确定性**：同 schema + options → 同 `formId:step-N` 与同栏序。
6. **空 schema → `[]`**，不抛错（工作台显示「这张表还没有栏」，不崩）。
7. `requiredFirst: false` 可退回「完全按 schema 顺序切屏」，默认不用；
   `minPerStep` / `maxPerStep` 只允许 2–4，切不开就报 `FORM_GUIDE_INVALID_OPTIONS`，不悄悄放宽。

## 4. 拒绝规则（一律不静默）

| 情形 | 结果 |
| --- | --- |
| schema 不合法（重名字段、空 formId、未知 type、select 无 options、checkbox 带 maxLength、maxLength 越界、非 select 带 options） | 抛 `FORM_GUIDE_INVALID_SCHEMA` |
| formId 不在调用方白名单 / 目录 | 抛 `FORM_GUIDE_UNKNOWN_FORM`（404） |
| 预填引用 schema 之外的字段 | 抛 `FORM_GUIDE_UNKNOWN_FIELD`，一次列出所有可疑字段名（AI 拟稿也不许发明字段） |
| 预填 `null` / 数组 / 未知 origin | 抛 `FORM_GUIDE_INVALID_PREFILL` |
| 预填 checkbox | 跳过：`checkbox`（勾选只能本人点） |
| 预填必填 textarea（创作型） | 跳过：`creative_textarea`（留给本人写） |
| 值非字符串 / 空白 / 不在候选项 / 超 maxLength | 逐条跳过：`invalid_value_type` / `empty_value` / `not_in_options` / `too_long`，**不截断、不改写** |
| 本人已填的栏被 AI 预填 | 跳过：`user_value_kept` |
| 提示指向不存在的字段 / 别的步骤 / 不存在的步骤 | 丢弃：`unknown_field` / `field_not_in_step` / `unknown_step` |
| 提示为空 / 超 80 字 / 含控制字符换行 | 丢弃：`empty_text` / `too_long` / `control_character` |
| 同一栏重复提示 | 先到先得，后到 `duplicate_field` |

## 5. 验证

- 模块测试：`node --experimental-strip-types --test src/modules/form-guide/*.test.ts` → **49 项全通过**
  （steps 15 / hints 15 / prefill 16 / index 3）。
- 类型检查（本模块与依赖）：`node node_modules/typescript/bin/tsc --noEmit --incremental false --strict
  --target ES2022 --module esnext --moduleResolution bundler --allowImportingTsExtensions --skipLibCheck
  src/modules/form-guide/*.ts` → exit 0。
- 全仓 `node node_modules/typescript/bin/tsc --noEmit --incremental false` → **exit 0**（本轮开工前基线亦为 exit 0）。
  过程中曾撞见 `src/modules/team-match/guide.ts` 的瞬时语法错（另一个并行会话的在写文件，随后由该会话修好），
  本模块文件从未出现在报错里，也未被本轮改动。

## 6. 根接入 NEEDS_INTERFACE

### 6.1 谁提供 schema（三张真实表 + 映射表）

模块不认识任何一张具体的表；根需要把三处**既有**表单投影成 `GuideSchema`。以下是当前代码里的真实结构：

| 表单 | 既有定义（只读） | 建议 formId |
| --- | --- | --- |
| **报名表** | `src/modules/event-registration/model.ts` 的 `RegistrationForm.fields: RegistrationField[]`（`id/label/description/required/options/maxLength`，类型 `text \| textarea \| number \| choice \| multichoice \| url`） | `event-registration:<eventId>` |
| **提交表** | `src/modules/event-judging/model.ts` 的 `SubmissionMaterials { title, description, links[], files[] }` | `event-submission:<eventId>` |
| **招募贴** | `src/modules/recruiting/model.ts` 的 `CardDraft { headline, introduction, primaryRoles[], supportingRoles[], purposes[], purposeNote, skills[], city, availableHoursPerDay, workLinks[] }` | `recruiting-post:<projectId>` |

映射（由根适配器做，模块不做类型推断）：

| 既有类型 / 字段 | GuideSchemaField | 说明 |
| --- | --- | --- |
| `text` | `text` | 直通 |
| `textarea` | `textarea` | 直通；`required` 的 textarea 就是模块定义的「创作型字段」，不预填 |
| `url` / `number` | `text` | 都是单行文本，可安全显示；数值 / URL 校验仍是真表单的事 |
| `choice` | `select` | 必须带 `options`（空选项会被 schema 校验拒绝） |
| `multichoice`、`links[]`、`files[]`、`roles[]`、`skills[]`、`workLinks[]` | **无对应类型** | 模块只有 5 类标量字段，**MUST NOT** 用 `select` 假装多选（会丢掉多选语义）；见 6.5 |
| 提交表的 `title` / `description` | `text` / `textarea`（均 required） | 提交表当前是结构化对象而不是 field 列表，需要根写一层两栏投影 |
| 招募贴的 `headline` / `introduction` / `city` | `text` / `textarea` / `text` | `introduction` 若必填即创作型，AI 不代笔 |

### 6.2 根需要新增的只读部件

1. `src/server/form-guide-schema.ts`（建议名）：上述三张表的**只读**投影，签名建议
   `registrationSchema(eventId, actor): Promise<{ formId, revision, fields } | null>` 等三条。
   只读，不新增表、不新增写路径、不改任何既有事实。
2. 一个只读端点，例如 `GET form-guide/registration?eventId=…`：服务端组装 `buildFormGuide`，
   返回 `{ formId, revision, steps, filledFields, skippedFields, acceptedHints, droppedHints, aiDraftedFields }`。
   权限沿用各表单既有读权限（报名表：本人 / 本场工作人员；提交表：本队成员；招募贴：项目成员 + 已发布名片）。
3. 工作台一个「步骤卡」组件（P3 的 P1 阶段：跳转 + 高亮；P2 阶段：内联预填）。

### 6.3 工作台怎么用

```ts
// 1) 取 schema（只读，根提供）
const schema = await ports.formGuideSchema.registrationSchema(eventId, actor);

// 2) 一次算好步骤 / 提示 / 预填（模块纯计算，不写库）
const guide = buildFormGuide({
  schema,
  hints: aiHints,                 // [{ field, text }]，AI 写的「一句人话」
  prefill: aiSuggestedValues,     // { field: value }，只放能推出的值
});

// 3) 界面：第 N/M 步 + 每栏 hint；aiDraftedFields 里的栏显示「AI 拟稿」
//    点栏跳真实表单页并聚焦（P1），或内联展示待确认值（P2）

// 4) 本人确认后走既有写路径（报名表已有 saveDraft / SaveDraftInput），模块不写库、不提交；
//    本人改写过的栏先 markFieldOrigin(steps, field, 'user')
```

### 6.4 版本与权限（根负责，模块不判）

- 报名表有 `revision` / `formRevision`：schema 变了必须**重新 `planSteps` 并丢弃旧 prefill**，
  否则会把旧版本的答案写进新表单（模块不做版本校验，这是业务规则）。
- 建议把 `revision` 随响应返回给工作台，仅用于「步骤卡是否过期」的显示。
- 模块不判断谁有权填哪张表：权限复核留在既有路由；本模块不接收也不缓存 actor 数据。

### 6.5 需要用户拍板的一个类型缺口

当前 `GuideFieldType` 是任务给定的五类（`text/textarea/select/date/checkbox`），
但平台真实表单里有**多选**（报名表 `multichoice`、招募贴 `primaryRoles[]`）和**重复行**
（提交表 `links[]`/`files[]`）。本轮**不擅自扩展枚举**，也不假装映射。两个选项：

- **A（默认，本轮已按此交付）**：向导只覆盖 5 类标量栏；多选与重复行不进步骤卡，
  仍由真实表单页填写（步骤卡只指引、不代替整张表单）。
- **B（需用户点头）**：把 `multichoice` / `repeat` 加进 `GuideFieldType` 并补预填规则
  （多选预填必须逐项落在 options 里，重复行预填需要行级校验）。

## 7. 未接入（如实）

- 未写任何 `src/app` / `src/server` 代码：没有端点、没有页面、没有路由改动。
- 没有迁移、没有新表、没有写路径；模块不落库。
- 没有接真实 AI：`hints` / `prefill` 由调用方传入，模块不调用模型、不记账。

## 8. 明确不做

- 不提交、不写草稿、不改状态（宪法 XIII：助手只出草稿）；
- 不校验业务规则（必填是否合理、日期区间、名额、资格）；
- 不生成 HTML、不生成 CSS、不决定视觉；
- 不按 formId 内置任何表单或字段（模块不持有表单定义）；
- 不发明字段、不编造提示落点、不截断超长值；
- 不把 AI 拟稿混同为本人填写（origin 三分，界面必须区分）。
