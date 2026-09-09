let source;
export function setDataSource(value) { source = value; }
export async function get(url, signal) {
  signal?.throwIfAborted();
  if (source) return source.get(url, signal);
  if (typeof document !== "undefined" && document.documentElement.hasAttribute("data-local-viewer")) throw new Error("尚未打开本地备份");
  const response = await fetch(url, { signal });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}
export async function mediaSource(asset) {
  if (source) return source.media(asset);
  const url = `/api/media/${encodeURIComponent(asset.assetId || asset.referenceId)}`;
  return { url, downloadUrl: `${url}?download=1`, release() {} };
}
