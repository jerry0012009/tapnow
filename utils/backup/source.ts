export const TAPNOW_ORIGIN = "https://app.tapnow.ai";
export function canvasIdFromUrl(value?: string | null): string | null {
  try {
    const url = new URL(value || "");
    if (url.origin !== TAPNOW_ORIGIN) return null;
    return /^\/canvas\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/?$/i.exec(url.pathname)?.[1] || null;
  } catch { return null; }
}
export function sourceMatches(tab: { id?: number; url?: string }, tabId: number, canvasId: string) {
  return tab.id === tabId && canvasIdFromUrl(tab.url) === canvasId;
}
export function backupPageQuery(tab?: { id?: number; url?: string }) {
  const query = new URLSearchParams();
  const id = canvasIdFromUrl(tab?.url);
  if (tab?.id && id) { query.set("sourceTab", String(tab.id)); query.set("canvasId", id); }
  else if (tab?.url?.startsWith(`${TAPNOW_ORIGIN}/`)) query.set("from", "projects");
  return query.toString();
}
