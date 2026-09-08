import { sha256 } from "@noble/hashes/sha2.js";
import type { BackupAssetReference } from "./types";

export interface Writable {
  write(data: string | Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}
export interface LocalFile {
  getFile(): Promise<File>;
  createWritable(): Promise<Writable>;
}
export interface LocalDirectory {
  name: string;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<LocalDirectory>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<LocalFile>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
}
export type Asset = BackupAssetReference & { assetId: string; notInLatestScan?: boolean };
export type Result = Omit<Asset, "status"> & {
  status: string; reason?: string; bytes?: number; sha256?: string; file?: string;
  contentType?: string; attempts?: number; reused?: boolean; verifiedAt?: string;
};
export const hex = (value: Uint8Array) => Array.from(value, b => b.toString(16).padStart(2, "0")).join("");
export function assetKey(asset: { url?: string | null; fileId?: string | null }) {
  return `${asset.url || ""}|${asset.fileId || ""}`;
}
export function indexReferences(references: BackupAssetReference[]) {
  const assets = new Map<string, Asset>();
  const refs = references.map(ref => {
    // Do not alias sibling file IDs to URLs: they may represent different variants.
    const key = assetKey(ref);
    let asset = assets.get(key);
    if (!asset) {
      const assetId = `asset-${hex(sha256(new TextEncoder().encode(key)))}`;
      asset = { ...ref, referenceId: assetId, assetId };
      assets.set(key, asset);
    }
    return { ...ref, assetId: asset.assetId };
  });
  return { references: refs, assets: [...assets.values()] };
}
export function reconcileAssets(current: Asset[], previous: Iterable<Result>): Asset[] {
  const targets = new Map(current.map(asset => [asset.assetId, { ...asset, notInLatestScan: false }]));
  for (const old of previous) {
    if (!targets.has(old.assetId)) targets.set(old.assetId, { ...old, status: "discovered", notInLatestScan: true });
  }
  return [...targets.values()];
}
export async function localFile(root: LocalDirectory, file: string, create = false) {
  const parts = file.split("/");
  const name = parts.pop()!;
  if ([...parts, name].some(p => !p || p === ".." || p === "." || p.includes("\\"))) throw new Error("Invalid local path");
  let current = root;
  for (const part of parts) current = await current.getDirectoryHandle(part, { create });
  return current.getFileHandle(name, { create });
}
export async function writeLocal(root: LocalDirectory, file: string, text: string) {
  const writable = await (await localFile(root, file, true)).createWritable();
  try { await writable.write(text); await writable.close(); }
  catch (error) { await writable.abort().catch(() => {}); throw error; }
}
export async function hashFile(file: File) {
  const hash = sha256.create();
  const reader = file.stream().getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return hex(hash.digest());
      hash.update(value);
    }
  } finally { reader.releaseLock(); }
}
export async function verifySaved(root: LocalDirectory, result: Result) {
  if (result.status !== "verified" || !result.file || !result.sha256) return false;
  try {
    const file = await (await localFile(root, result.file)).getFile();
    return file.size === result.bytes && await hashFile(file) === result.sha256;
  } catch { return false; }
}
export function parseRange(value: string, start: number) {
  const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value);
  if (!m) throw new Error("Invalid Content-Range");
  const [from, to, total] = m.slice(1).map(Number);
  if (![from, to, total].every(Number.isSafeInteger) || from !== start || to < from || to >= total) throw new Error("Inconsistent Content-Range");
  return { from, to, total };
}
export function sourceCandidates(asset: Asset) {
  const urls = [asset.url];
  if (asset.url?.startsWith("https://files.tapnow.top/")) urls.push(asset.url.replace("files.tapnow.top", "files.tapnow.media"));
  if (asset.fileId) urls.push(`https://files.tapnow.media/api/conversation/storage/uploads/${encodeURIComponent(asset.fileId)}`);
  return [...new Set(urls.filter((v): v is string => Boolean(v)))];
}
export function allowedSource(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && ["files.tapnow.media", "files.tapnow.top"].includes(url.hostname) && !url.username && !url.password;
  } catch { return false; }
}

export async function downloadToDirectory(
  root: LocalDirectory, asset: Asset,
  options: { claim(bytes: number): void; release(bytes: number): void; fetch?: typeof fetch; signal?: AbortSignal; retryDelayMs?: number }
): Promise<Result> {
  const temp = await root.getDirectoryHandle("partial", { create: true });
  const filename = `${asset.assetId}.part`;
  let reason = "no-download-url", attempts = 0;
  for (const url of sourceCandidates(asset)) {
    if (!allowedSource(url)) { reason = "unsupported-source-host"; continue; }
    for (let attempt = 0; attempt < 4; attempt++) {
      attempts++;
      let writable: Writable | undefined;
      let claimed = 0;
      try {
        const handle = await temp.getFileHandle(filename, { create: true });
        writable = await handle.createWritable();
        const hash = sha256.create();
        let offset = 0, total: number | null = null, contentType = "", etag = "";
        do {
          options.signal?.throwIfAborted();
          const end = offset + 4 * 1024 * 1024 - 1;
          const response = await (options.fetch || fetch)(url, {
            credentials: "omit", cache: "no-store", redirect: "error",
            signal: AbortSignal.any([AbortSignal.timeout(60000), ...(options.signal ? [options.signal] : [])]),
            headers: { Range: `bytes=${offset}-${end}`, ...(etag ? { "If-Range": etag } : {}) }
          });
          if (![200, 206].includes(response.status)) {
            await response.body?.cancel();
            throw new Error(`HTTP ${response.status}`);
          }
          if (!response.body) throw new Error("Missing response body");
          let range: ReturnType<typeof parseRange> | null = null;
          if (response.status === 206) {
            range = parseRange(response.headers.get("content-range") || "", offset);
            if (total !== null && total !== range.total) throw new Error("Resource changed during download");
            total = range.total;
          } else if (offset !== 0) throw new Error("Server ignored continuation range");
          contentType = response.headers.get("content-type") || "application/octet-stream";
          if (/text\/html|application\/json/i.test(contentType)) throw new Error("Unexpected non-media response");
          const newEtag = response.headers.get("etag") || "";
          if (etag && newEtag && etag !== newEtag) throw new Error("ETag changed during download");
          etag = newEtag;
          const reader = response.body.getReader();
          let partBytes = 0;
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              options.claim(value.byteLength);
              claimed += value.byteLength;
              await writable.write(value);
              hash.update(value);
              partBytes += value.byteLength;
            }
          } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
          if (!partBytes) throw new Error("Empty response");
          if (range && partBytes !== range.to - range.from + 1) throw new Error("Truncated range");
          if (!range && response.headers.has("content-length") && !response.headers.has("content-encoding") &&
            partBytes !== Number(response.headers.get("content-length"))) throw new Error("Truncated full response");
          offset += partBytes;
          if (response.status === 200) total = offset;
        } while (offset < total!);
        await writable.close();
        writable = undefined;
        const digest = hex(hash.digest());
        const file = `objects/sha256/${digest.slice(0, 2)}/${digest}`;
        const source = await handle.getFile();
        if (source.size !== offset || await hashFile(source) !== digest) throw new Error("Temporary file verification failed");
        const existing: Result = { ...asset, status: "verified", file, bytes: offset, sha256: digest };
        if (!await verifySaved(root, existing)) {
          const dest = await (await localFile(root, file, true)).createWritable();
          const reader = source.stream().getReader();
          try {
            for (;;) { const { done, value } = await reader.read(); if (done) break; await dest.write(value); }
            await dest.close();
          } catch (error) { await dest.abort().catch(() => {}); throw error; }
          finally { reader.releaseLock(); }
        } else { options.release(claimed); claimed = 0; }
        if (!await verifySaved(root, existing)) throw new Error("Final file verification failed");
        await temp.removeEntry(filename);
        return { ...existing, contentType, attempts, verifiedAt: new Date().toISOString() };
      } catch (error) {
        await writable?.abort().catch(() => {});
        options.release(claimed);
        await temp.removeEntry(filename).catch(() => {});
        reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        if (options.signal?.aborted || /storage-budget|QuotaExceeded|NotAllowed|No space|ENOSPC/i.test(reason)) {
          return { ...asset, status: options.signal?.aborted ? "queued" : "retryable", reason, attempts };
        }
        if (attempt < 3) await new Promise(resolve => setTimeout(resolve, (options.retryDelayMs ?? 400) * 2 ** attempt));
      }
    }
  }
  return { ...asset, status: /HTTP (404|410)\b/.test(reason) ? "unavailable-after-recovery" : "retryable", reason, attempts };
}
