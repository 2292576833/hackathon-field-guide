import test from "node:test";
import assert from "node:assert/strict";
import { DEPLOYMENT_MODES, deploymentModeOf, isDeploymentMode } from "./organizer-settings.ts";

test("默认是 public：缺失、非法、非对象都不默认开启白标", () => {
  assert.equal(DEPLOYMENT_MODES.length, 2);
  for (const bad of [undefined, null, {}, { deploymentMode: "nope" }, [], "white_label", 1]) {
    assert.equal(deploymentModeOf(bad), "public");
  }
});

test("合法值原样返回", () => {
  assert.equal(deploymentModeOf({ deploymentMode: "white_label" }), "white_label");
  assert.equal(deploymentModeOf({ deploymentMode: "public" }), "public");
  assert.equal(isDeploymentMode("white_label"), true);
  assert.equal(isDeploymentMode("WHITE_LABEL"), false);
});
