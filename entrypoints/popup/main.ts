import { browser } from "wxt/browser";
import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  type ReviewSettings
} from "../../utils/reviewer";

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <style>
    :root { color-scheme: light; font-family: system-ui, -apple-system, sans-serif; }
    body { width: 330px; margin: 0; padding: 16px; color: #0f172a; background: #f8fafc; }
    h1 { margin: 0 0 4px; font-size: 17px; }
    p { margin: 0 0 14px; color: #64748b; font-size: 12px; line-height: 1.4; }
    label { display: block; margin: 12px 0 6px; font-size: 12px; font-weight: 700; color: #475569; }
    input[type="text"], input[type="password"], textarea, select { box-sizing: border-box; width: 100%; padding: 8px; border: 1px solid #cbd5e1; border-radius: 6px; background: white; font: 13px/1.4 system-ui, sans-serif; }
    textarea { min-height: 52px; resize: vertical; }
    .row { display: flex; align-items: center; gap: 8px; font-size: 13px; }
    .row label { margin: 0; font-weight: 600; color: #0f172a; }
    button { width: 100%; margin-top: 14px; min-height: 36px; border: 0; border-radius: 6px; background: #2563eb; color: white; font: 600 13px system-ui, sans-serif; cursor: pointer; }
    .section { border-top: 1px solid #e2e8f0; margin-top: 15px; padding-top: 3px; }
    .hint { color: #64748b; font-size: 11px; line-height: 1.4; margin-top: 5px; }
    #status { min-height: 18px; margin-top: 8px; color: #15803d; font-size: 12px; }
  </style>
  <h1>TapNow Companion 0.1</h1>
  <p>运行前审核。页面脚本不读取 Token；API Key 仅保存在本机扩展存储。</p>
  <div class="row"><input id="enabled" type="checkbox"><label for="enabled">启用副驾驶</label></div>
  <label for="requiredTerms">团队要求词（逗号或换行分隔）</label>
  <textarea id="requiredTerms" placeholder="例如：电影感, 品牌色"></textarea>
  <label for="forbiddenTerms">团队禁用词（逗号或换行分隔）</label>
  <textarea id="forbiddenTerms" placeholder="例如：未授权品牌"></textarea>
    <div class="section">
      <div class="row"><input id="llmEnabled" type="checkbox"><label for="llmEnabled">启用 LLM 审阅</label></div>
      <div class="row"><input id="llmIncludeImages" type="checkbox"><label for="llmIncludeImages">检测时发送图片素材</label></div>
    <label for="llmProtocol">接口协议</label>
    <select id="llmProtocol">
      <option value="responses">Responses</option>
      <option value="chat_completions">Chat Completions</option>
    </select>
    <label for="llmModel">模型</label>
    <input id="llmModel" type="text" placeholder="gpt-5.6-luna">
    <label for="llmBaseUrl">API Base URL</label>
    <input id="llmBaseUrl" type="text" placeholder="https://api.acucompute.com/v1">
    <label for="apiKey">API Key</label>
    <input id="apiKey" type="password" placeholder="留空表示不修改已保存的 Key">
    <div class="hint">0.1 支持 OpenAI/ACU HTTPS API；Key 不会同步到 Chrome 账号。</div>
  </div>
  <button id="save" type="button">保存设置</button>
  <div id="status" role="status"></div>
`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const [syncSettings, localSettings] = await Promise.all([
  browser.storage.sync.get(DEFAULT_SETTINGS),
  browser.storage.local.get({ apiKey: "" })
]);
const settings = normalizeSettings(syncSettings);

($("enabled") as HTMLInputElement).checked = settings.enabled;
($("llmEnabled") as HTMLInputElement).checked = settings.llmEnabled;
($("llmIncludeImages") as HTMLInputElement).checked = settings.llmIncludeImages;
($("llmProtocol") as HTMLSelectElement).value = settings.llmProtocol;
($("llmModel") as HTMLInputElement).value = settings.llmModel;
($("llmBaseUrl") as HTMLInputElement).value = settings.llmBaseUrl;
($("requiredTerms") as HTMLTextAreaElement).value = settings.requiredTerms.join(", ");
($("forbiddenTerms") as HTMLTextAreaElement).value = settings.forbiddenTerms.join(", ");
($("apiKey") as HTMLInputElement).placeholder = localSettings.apiKey
  ? "已配置，留空表示不修改"
  : "sk-...";

$("save").addEventListener("click", async () => {
  const next: ReviewSettings = normalizeSettings({
    enabled: ($("enabled") as HTMLInputElement).checked,
    llmEnabled: ($("llmEnabled") as HTMLInputElement).checked,
    llmIncludeImages: ($("llmIncludeImages") as HTMLInputElement).checked,
    llmProtocol: ($("llmProtocol") as HTMLSelectElement).value as ReviewSettings["llmProtocol"],
    llmModel: ($("llmModel") as HTMLInputElement).value,
    llmBaseUrl: ($("llmBaseUrl") as HTMLInputElement).value,
    requiredTerms: ($("requiredTerms") as HTMLTextAreaElement).value,
    forbiddenTerms: ($("forbiddenTerms") as HTMLTextAreaElement).value
  });
  const apiKey = ($("apiKey") as HTMLInputElement).value.trim();
  await browser.storage.sync.set(next);
  if (apiKey) await browser.storage.local.set({ apiKey });
  $("status").textContent = "已保存。刷新 TapNow 页面后生效。";
});
