# form-guide · 表单步骤指引（纯逻辑）

把「**一张表单怎么分步、每栏一句人话、哪些能预填**」做成一个不碰界面的纯逻辑模块，
供 AI 工作台调用。依据：规划 36 §2.2、规划 35 §19.4、宪法 v1.24.0 原则 XIII / XIV / II。

一句话边界：**表单是别人的，模块只负责编排**。

## 它不做什么（先看这条）

- **不持有表单定义**：没有内置字段、没有按 formId 的内置白名单、没有默认表单。
  schema 一律由调用方传入；`formId` 只在调用方给的 schema 或白名单里成立。
- **不发明字段**：schema 之外的字段名一律 `FORM_GUIDE_UNKNOWN_FIELD`。
- **不提交、不写库、不改状态**：产出只是结构化数据，写进表单草稿由根已有的写路径做。
- **不校验业务规则**：必填是否合理、日期能不能选、名额够不够，都是真表单与后端的事。
- **不生成 HTML**：渲染是界面的事，这里连一个标签都不拼。
- **无 IO、无 `Date.now()`、无随机**：同一输入永远同一输出。

## 数据契约

### 输入：调用方提供的 schema

```ts
interface GuideSchema {
  formId: string;
  fields: {
    name: string;              // 字段名，整张表唯一
    label: string;             // 界面标签，原样搬运
    type: "text" | "textarea" | "select" | "date" | "checkbox";
    required: boolean;
    options?: string[];        // 只有 select 能带，且必须非空
    maxLength?: number;        // 只有文本类能带；checkbox 带它就是 schema 错误
  }[];
}
```

### 输出：步骤

```ts
interface GuideStep {
  id: string;          // 稳定：formId:step-N
  formId: string;
  index: number;       // 1 起
  fields: GuideField[];
  fieldCount: number;
  requiredCount: number;
  prefillableCount: number;   // 本步能预填的栏数
}

interface GuideField {
  name; label; type; required;
  options: string[];   // 非 select 恒为 []
  maxLength: number | null;
  schemaIndex: number; // 在原 schema 里的位置
  value: string | null;
  origin: "user" | "ai" | "empty";   // 界面据此标「AI 拟稿」
  hint: string | null;                // 一句人话，见 attachHints
}
```

`origin` 的三种取值都必须在界面上区分：`ai` = AI 预填/拟稿，**必须本人确认**才写草稿；
`user` = 本人填写（含本人改写过 AI 拟稿的栏）；`empty` = 还没填。文案常量见 `GUIDE_ORIGIN_LABELS`。

## API

| 函数 | 作用 |
| --- | --- |
| `planSteps(schema, options?)` | 分步。`options.allowedFormIds` 是 formId 白名单；`minPerStep` / `maxPerStep` 只允许 2–4；`requiredFirst` 默认 `true`。schema 为空返回 `[]`，不抛错。 |
| `applyPrefill(steps, prefill)` | 预填。返回 `{ steps, filledFields, skippedFields }`。 |
| `attachHints(steps, hints)` | 挂提示。返回 `{ steps, accepted, dropped, droppedCount, hintCount }`。 |
| `markFieldOrigin(steps, field, origin)` | 本人改过某栏后撤掉「AI 拟稿」；`empty` 同时清空值。 |
| `buildFormGuide({ schema, steps?, prefill?, hints? })` | 一次做完三步，并给出 `aiDraftedFields`（要标注的栏）。 |
| `resolveSchema(catalog, formId)` | 在调用方的表单目录里按 id 取 schema；取不到 404。 |
| `hintTextRejectReason(text)` | 工作台在调 AI 之前就能用同一套规则自查提示文案。 |

## 分步规则

1. **不丢字段、不重复**：每个字段恰好出现一次。
2. **每步 2–4 栏**：默认 2–4；整张表只有 1 栏时才允许 1 栏一步（唯一例外）。
3. **步内顺序与 schema 一致**：一屏里的栏永远按 schema 原顺序排。
4. **必填优先**：跨屏看，任一必填栏所在屏 ≤ 任一选填栏所在屏。
   整张表 ≤ 4 栏时全部落在一屏，栏序就是 schema 顺序。
5. **确定性**：同样的 schema + options 永远得到同样的 `formId:step-N` 与栏序。

`requiredFirst: false` 可以退回「完全按 schema 顺序切屏」，但默认不用。

## 拒绝规则

| 情形 | 结果 |
| --- | --- |
| schema 不合法（重名字段、空 formId、未知 type、select 无 options、checkbox 带 maxLength、maxLength 越界） | 抛 `FORM_GUIDE_INVALID_SCHEMA`（422） |
| formId 不在调用方白名单 / 目录里 | 抛 `FORM_GUIDE_UNKNOWN_FORM`（404），模块不猜表 |
| 每步栏数选项越界、倒挂、或这张表切不开 | 抛 `FORM_GUIDE_INVALID_OPTIONS` |
| 预填引用了 schema 之外的字段 | 抛 `FORM_GUIDE_UNKNOWN_FIELD`（422），并列出所有可疑字段名 |
| 预填值是 `null` / 数组 / origin 不认识 | 抛 `FORM_GUIDE_INVALID_PREFILL` |
| 预填 checkbox | 跳过，`reason: "checkbox"` |
| 预填「必填的多行文本」 | 跳过，`reason: "creative_textarea"` |
| 预填值不是字符串 / 空白 / 不在候选项 / 超长 | 逐条跳过并给出 reason，**不截断、不改写** |
| 某栏已被本人填写，AI 又来预填 | 跳过，`reason: "user_value_kept"` |
| 提示指向 schema 里没有的字段 | 丢弃，`reason: "unknown_field"`，计入 `droppedCount` |
| 提示指向别的步骤 | 丢弃，`reason: "field_not_in_step"` |
| 提示为空 / 超 80 字 / 含控制字符换行 | 丢弃，`reason: "empty_text"` / `"too_long"` / `"control_character"` |
| 同一栏重复给提示 | 先到先得，后到的 `reason: "duplicate_field"` |

**不静默**是硬约束：提示逐条丢弃并计数，预填逐条列出原因；`droppedCount + accepted === hintCount`
与 `filledFields` / `skippedFields` 都能直接显示给用户。

## 测试

```
node --experimental-strip-types --test src/modules/form-guide/*.test.ts
```

覆盖：不丢字段、每步 2–4、必填优先、步内 schema 顺序、空 schema 返回 `[]`、
单栏例外、未知 formId、非法 schema、每步选项非法、提示 80/81 字边界、控制字符、
跨步指认、重复提示、逐条计数、checkbox 不预填、必填 textarea 不预填、
select 候选项、超长不截断、origin 三种取值、AI 不覆盖本人内容、纯函数不改入参、
提示与预填互不覆盖、`buildFormGuide` 组合结果。

## 接入前必须知道的三件事

1. **schema 谁给**：报名表、提交表、招募贴——由根的表单定义处提供（见交付文档 `NEEDS_INTERFACE`）。
   本模块不认识任何一张具体的表。
2. **AI 只出草稿**：`origin === "ai"` 的栏必须在界面上标注「AI 拟稿」，本人确认后才写草稿；
   本模块不提交、不改状态。
3. **一句人话由 AI 写、由本模块验**：提示文案可以来自 AI，但长度、控制字符、字段归属在这里裁决。
