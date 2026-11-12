import { DEFAULT_SETTINGS, normalizeSettings, type ReviewSettings } from "./reviewer";

declare const __TAPNOW_TRIAL_API_KEY__: string;

const TRIAL_DEFAULTS_VERSION = 1;
const bundledTrialKey = typeof __TAPNOW_TRIAL_API_KEY__ === "string"
  ? __TAPNOW_TRIAL_API_KEY__
  : "";

interface SettingsStorage {
  sync: {
    get(defaults: Record<string, unknown>): Promise<Record<string, unknown>>;
    set(values: Record<string, unknown>): Promise<void>;
  };
  local: {
    get(defaults: Record<string, unknown>): Promise<Record<string, unknown>>;
    set(values: Record<string, unknown>): Promise<void>;
  };
}

export async function loadCompanionSettings(
  storage: SettingsStorage,
  trialKey = bundledTrialKey
): Promise<{ settings: ReviewSettings; apiKey: string }> {
  const [saved, local] = await Promise.all([
    storage.sync.get({ ...DEFAULT_SETTINGS }),
    storage.local.get({ apiKey: "", companionTrialDefaultsVersion: 0 })
  ]);
  if (local.companionTrialDefaultsVersion !== TRIAL_DEFAULTS_VERSION) {
    const update = {
      llmEnabled: true,
      llmIncludeImages: true,
      llmModel: !saved.llmModel || saved.llmModel === "gpt-5.6-luna"
        ? DEFAULT_SETTINGS.llmModel
        : saved.llmModel
    };
    Object.assign(saved, update);
    await storage.sync.set(update);
    // Only local storage receives the trial key. Never replace a user's key.
    if (!local.apiKey && trialKey) local.apiKey = trialKey;
    await storage.local.set({
      companionTrialDefaultsVersion: TRIAL_DEFAULTS_VERSION,
      ...(local.apiKey ? { apiKey: local.apiKey } : {})
    });
  }
  return {
    settings: normalizeSettings(saved),
    apiKey: String(local.apiKey || "")
  };
}
