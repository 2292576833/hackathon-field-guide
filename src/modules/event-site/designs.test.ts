import assert from "node:assert/strict";
import test from "node:test";
import { EVENT_SITE_DESIGN_PRESETS, designPreset } from "./designs.ts";

test("设计灵感：id 唯一、皮肤合法、说明不为空且够短", () => {
  const ids = new Set<string>();
  for (const preset of EVENT_SITE_DESIGN_PRESETS) {
    assert.ok(!ids.has(preset.id), "重复 id " + preset.id);
    ids.add(preset.id);
    assert.ok(["classic", "dark", "paper", "neon"].includes(preset.skin), preset.id + " 皮肤不合法");
    assert.ok(preset.name.length > 0 && preset.mood.length > 0);
    assert.ok(preset.brief.length >= 10 && preset.brief.length <= 200, preset.id + " 风格说明长度不合适");
    assert.equal(preset.swatches.length, 3);
    for (const color of preset.swatches) assert.match(color, /^#[0-9a-f]{6}$/i, preset.id + " 色块不是合法十六进制");
  }
});

test("设计灵感：按 id 取得到，未知 id 返回 null", () => {
  assert.equal(designPreset("swiss")?.name, "瑞士排版");
  assert.equal(designPreset("does-not-exist"), null);
});
