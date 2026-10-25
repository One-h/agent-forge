import assert from "node:assert/strict";
import test from "node:test";
import { preferredEnvironmentValue } from "./environment.js";

test("workspace configuration retains a unique legacy namespace without hard-coding a private name", () => {
  assert.equal(preferredEnvironmentValue("FORGE_WORKSPACE_ROOT", "_WORKSPACE_ROOT", { PREVIOUS_WORKSPACE_ROOT: "/example/old" }), "/example/old");
  assert.equal(preferredEnvironmentValue("FORGE_WORKSPACE_ROOT", "_WORKSPACE_ROOT", { PREVIOUS_WORKSPACE_ROOT: "/example/old", FORGE_WORKSPACE_ROOT: "/example/new" }), "/example/new");
  assert.equal(preferredEnvironmentValue("FORGE_WORKSPACE_ROOT", "_WORKSPACE_ROOT", { PREVIOUS_WORKSPACE_ROOT: "/example/old", FORGE_WORKSPACE_ROOT: "" }), "");
  assert.throws(() => preferredEnvironmentValue("FORGE_WORKSPACE_ROOT", "_WORKSPACE_ROOT", { FIRST_WORKSPACE_ROOT: "/one", SECOND_WORKSPACE_ROOT: "/two" }));
});
