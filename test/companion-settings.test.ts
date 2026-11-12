import test from "node:test";
import assert from "node:assert/strict";
import { loadCompanionSettings } from "../utils/companion-settings";
import { DEFAULT_SETTINGS, normalizeSettings } from "../utils/reviewer";

function storage(sync: Record<string, unknown> = {}, local: Record<string, unknown> = {}) {
  const area = (values: Record<string, unknown>) => ({
    get: async (defaults: Record<string, unknown>) => ({ ...defaults, ...values }),
    set: async (update: Record<string, unknown>) => { Object.assign(values, update); }
  });
  return { sync: area(sync), local: area(local), syncValues: sync, localValues: local };
}

test("new installs are ready for image LLM review with the bundled trial key", async () => {
  const store = storage();
  const result = await loadCompanionSettings(store, "fixture-trial-key");
  assert.equal(result.settings.llmModel, "gpt-6.1-sol");
  assert.equal(result.settings.llmEnabled, true);
  assert.equal(result.settings.llmIncludeImages, true);
  assert.equal(result.apiKey, "fixture-trial-key");
  assert.equal(store.localValues.apiKey, "fixture-trial-key");
  assert.equal("apiKey" in store.syncValues, false);
  assert.equal(DEFAULT_SETTINGS.llmEnabled, true);
  assert.equal(normalizeSettings().llmIncludeImages, true);
});

test("upgrade activates LLM and images and migrates the previous default model", async () => {
  const store = storage({ llmModel: "gpt-5.6-luna", llmEnabled: false, llmIncludeImages: false });
  const result = await loadCompanionSettings(store, "fixture-trial-key");
  assert.equal(result.settings.llmModel, "gpt-6.1-sol");
  assert.equal(result.settings.llmEnabled, true);
  assert.equal(result.settings.llmIncludeImages, true);
});

test("existing user key and custom model survive upgrade and repeated loads", async () => {
  const store = storage({ llmModel: "custom-model" }, { apiKey: "fixture-user-key" });
  const first = await loadCompanionSettings(store, "fixture-trial-key");
  const second = await loadCompanionSettings(store, "fixture-other-key");
  assert.equal(first.apiKey, "fixture-user-key");
  assert.equal(second.apiKey, "fixture-user-key");
  assert.equal(second.settings.llmModel, "custom-model");
});

test("a build without trial key never fabricates a usable key", async () => {
  assert.equal((await loadCompanionSettings(storage(), "")).apiKey, "");
});
