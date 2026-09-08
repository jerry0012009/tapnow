import type { BackupAssetReference } from "./types";

const URL_KEYS = new Set(["src", "url", "href", "preview_image", "previewImage"]);
const FILE_KEYS = new Set([
  "fileId",
  "file_id",
  "currentSourceFileId",
  "sourceFileId"
]);

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function roleForPath(path: string): BackupAssetReference["role"] {
  if (/history|queue|variant|derived/i.test(path)) return "history";
  if (/option|alternative|candidate|backup/i.test(path)) return "alternative";
  if (/preview|cover|thumbnail/i.test(path)) return "preview";
  if (/input|source|reference|attachment/i.test(path)) return "input";
  if (/output|result|src/i.test(path)) return "current";
  return "unknown";
}

function normalizeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString();
  } catch {
    return value;
  }
}

export function discoverAssetReferences(
  canvasId: string,
  nodeId: string | null,
  value: unknown,
  options: {
    source?: BackupAssetReference["source"];
    fieldPrefix?: string;
  } = {}
): BackupAssetReference[] {
  const result: BackupAssetReference[] = [];
  const seen = new Map<string, number>();
  const source = options.source ?? "api";
  const fieldPrefix = options.fieldPrefix ?? "data";

  function add(path: string, rawUrl: string | null, fileId: string | null) {
    const url = rawUrl ? normalizeUrl(rawUrl) : null;
    if (!url && !fileId) return;
    const key = `${fileId ?? ""}|${url ?? ""}|${path}`;
    if (seen.has(key)) return;
    const ordinal = result.filter((item) => item.nodeId === nodeId).length + 1;
    seen.set(key, result.length);
    result.push({
      referenceId: `${canvasId}:${nodeId ?? "canvas"}:${result.length + 1}`,
      canvasId,
      nodeId,
      fieldPath: path,
      role: roleForPath(path),
      ordinal,
      fileId,
      url,
      source,
      status: "discovered"
    });
  }

  function walk(current: unknown, path: string) {
    if (typeof current === "string") {
      if (/^https?:\/\//i.test(current)) add(path, current, null);
      return;
    }
    if (Array.isArray(current)) {
      current.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    const record = objectRecord(current);
    if (!record) return;
    const fileId = Object.entries(record).find(([key]) => FILE_KEYS.has(key))?.[1];
    const localFileId =
      typeof fileId === "string" && fileId.trim() ? fileId.trim() : null;
    for (const [key, child] of Object.entries(record)) {
      const childPath = `${path}.${key}`;
      if (
        URL_KEYS.has(key) &&
        typeof child === "string" &&
        /^https?:\/\//i.test(child)
      ) {
        add(childPath, child, localFileId);
      }
      if (FILE_KEYS.has(key) && typeof child === "string") {
        add(childPath, null, child);
      }
      walk(child, childPath);
    }
  }

  walk(value, fieldPrefix);
  return result;
}
