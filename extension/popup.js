const DEFAULTS = {
  enabled: true,
  gateClicks: true,
  requiredTerms: [],
  forbiddenTerms: []
};

const $ = (id) => document.getElementById(id);

function toText(value) {
  return Array.isArray(value) ? value.join(", ") : String(value ?? "");
}

chrome.storage.sync.get(DEFAULTS, (settings) => {
  $("enabled").checked = settings.enabled !== false;
  $("gateClicks").checked = settings.gateClicks !== false;
  $("requiredTerms").value = toText(settings.requiredTerms);
  $("forbiddenTerms").value = toText(settings.forbiddenTerms);
});

$("save").addEventListener("click", () => {
  chrome.storage.sync.set({
    enabled: $("enabled").checked,
    gateClicks: $("gateClicks").checked,
    requiredTerms: $("requiredTerms").value,
    forbiddenTerms: $("forbiddenTerms").value
  }, () => {
    $("status").textContent = "已保存。刷新 TapNow 页面后生效。";
  });
});
