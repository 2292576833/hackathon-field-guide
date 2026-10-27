import assert from "node:assert/strict";
import test from "node:test";
import { deriveLayout, reviewSpec } from "./policy.ts";
import { EVENT_SITE_STARTER_TEMPLATES } from "./templates.ts";
import { normalizeSpec, serializeSpec } from "./validation.ts";

test("每个内置模板都过同一条闸门（规范化/序列化/派生布局/规则体检）", () => {
  for (const template of EVENT_SITE_STARTER_TEMPLATES) {
    const spec = template.build();
    assert.deepEqual(normalizeSpec(spec), spec, template.id + " 规范化后与原规格不一致");
    assert.doesNotThrow(() => serializeSpec(spec), template.id + " 序列化失败");
    const layout = deriveLayout(spec);
    assert.ok(layout.grid.rows.length > 0, template.id + " 没有桌面布局");
    assert.ok(layout.mobile.entries.length > 0, template.id + " 没有手机布局");
    const errors = reviewSpec(spec).filter(finding => finding.level === "error");
    assert.deepEqual(errors, [], template.id + " 有必须处理的问题：" + JSON.stringify(errors));
    const ids = spec.blocks.map(block => block.id);
    assert.equal(new Set(ids).size, ids.length, template.id + " 区块 id 重复");
  }
});

test("标准页覆盖完整流程：报名、提交、结果、申诉与倒计时都在", () => {
  const standard = EVENT_SITE_STARTER_TEMPLATES.find(item => item.id === "standard")!.build();
  const kinds = standard.blocks.map(block => block.kind);
  for (const kind of ["countdown", "actionRegister", "actionSubmit", "actionResults", "actionAppeal", "timeline", "faq"]) {
    assert.ok(kinds.includes(kind as never), "标准页缺少 " + kind);
  }
});

test("路演模板带一个 AI 容器，且它管着两块真实区块", () => {
  const pitch = EVENT_SITE_STARTER_TEMPLATES.find(item => item.id === "pitch")!.build();
  const ai = pitch.blocks.find(block => block.kind === "aiBlock") as { manages: readonly string[]; duty: string | null } | undefined;
  assert.ok(ai, "路演模板应有 AI 容器");
  assert.ok(ai!.manages.length >= 2);
  assert.ok(typeof ai!.duty === "string" && ai!.duty.length > 0);
  for (const id of ai!.manages) assert.ok(pitch.blocks.some(block => block.id === id), "AI 容器管了不存在的块 " + id);
});

test("模板之间不共用区块 id，避免串页", () => {
  const seen = new Set<string>();
  for (const template of EVENT_SITE_STARTER_TEMPLATES) {
    for (const block of template.build().blocks) {
      assert.ok(!seen.has(block.id), "重复 id " + block.id);
      seen.add(block.id);
    }
  }
});

test("四套模板各自带一套视觉皮肤，且四套都被用到", () => {
  const skins = EVENT_SITE_STARTER_TEMPLATES.map(item => item.skin).sort();
  assert.deepEqual(skins, ["classic", "dark", "neon", "paper"]);
  for (const template of EVENT_SITE_STARTER_TEMPLATES) {
    assert.equal(template.build().skin, template.skin, template.id + " 的皮肤要与目录声明一致");
  }
});
