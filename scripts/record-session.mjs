import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright";
import { redactText, redactValue } from "./lib/redact.mjs";

const cdpUrl = process.env.TAPNOW_CDP_URL ?? "http://127.0.0.1:9223";
const canvasId =
  process.env.TAPNOW_CANVAS_ID ??
  "350073d9-2b5a-4a79-b057-4f9e644c75d4";
const targetUrl = `https://app.tapnow.ai/canvas/${canvasId}`;
const freshPage = process.argv.includes("--fresh-page");
const runDir = path.resolve(
  "artifacts/private",
  `interactive-${new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")}`,
);
await fs.mkdir(path.join(runDir, "bodies"), { recursive: true });

function isCapturable(url) {
  const parsed = new URL(url);
  return (
    parsed.hostname.endsWith("tapnow.ai") &&
    parsed.pathname.includes("/api/") &&
    !/auth|login|register/i.test(parsed.pathname)
  );
}

function fileName(method, url, direction) {
  const parsed = new URL(url);
  const readable =
    parsed.pathname
      .replace(/^\/+/, "")
      .replaceAll(/[^A-Za-z0-9._-]+/g, "_")
      .slice(0, 90) || "root";
  const hash = crypto
    .createHash("sha256")
    .update(`${method} ${url}`)
    .digest("hex")
    .slice(0, 10);
  return `${method.toLowerCase()}-${readable}-${hash}.${direction}.txt`;
}

const browser = await chromium.connectOverCDP(cdpUrl);
const context = browser.contexts()[0];
let page = freshPage
  ? await context.newPage()
  : context.pages().find((candidate) => candidate.url().includes("app.tapnow.ai"));
if (!page) page = await context.newPage();

const network = [];
const bodyIndex = [];
const sockets = [];
const pageErrors = [];
const pendingWrites = [];

context.on("request", (request) => {
  const resourceType = request.resourceType();
  if (!["document", "xhr", "fetch"].includes(resourceType)) return;

  network.push({
    phase: "request",
    at: new Date().toISOString(),
    resourceType,
    method: request.method(),
    url: request.url(),
    postDataSize: request.postDataBuffer()?.length ?? 0,
  });

  const body = request.postData();
  if (body && body.length <= 2_000_000 && isCapturable(request.url())) {
    const outputName = fileName(request.method(), request.url(), "request");
    bodyIndex.push({
      direction: "request",
      method: request.method(),
      url: request.url(),
      file: outputName,
      size: body.length,
    });
    pendingWrites.push(
      fs.writeFile(path.join(runDir, "bodies", outputName), redactText(body)),
    );
  }
});

context.on("response", async (response) => {
  const request = response.request();
  const resourceType = request.resourceType();
  if (!["document", "xhr", "fetch"].includes(resourceType)) return;

  const contentType = response.headers()["content-type"] ?? "";
  network.push({
    phase: "response",
    at: new Date().toISOString(),
    resourceType,
    method: request.method(),
    url: response.url(),
    status: response.status(),
    contentType,
  });

  if (
    response.ok() &&
    isCapturable(response.url()) &&
    /json|text|event-stream/i.test(contentType)
  ) {
    try {
      const body = await response.text();
      if (body.length <= 10_000_000) {
        const outputName = fileName(request.method(), response.url(), "response");
        bodyIndex.push({
          direction: "response",
          method: request.method(),
          url: response.url(),
          status: response.status(),
          file: outputName,
          size: body.length,
        });
        pendingWrites.push(
          fs.writeFile(path.join(runDir, "bodies", outputName), redactText(body)),
        );
      }
    } catch {
      // Some cached or streaming responses cannot be read after completion.
    }
  }
});

page.on("pageerror", (error) => pageErrors.push(String(error)));
page.on("websocket", (socket) => {
  const record = { url: socket.url(), frames: [] };
  sockets.push(record);
  const saveFrame = (direction, event) => {
    if (record.frames.length >= 500 || typeof event.payload !== "string") return;
    record.frames.push({
      direction,
      payload: redactText(event.payload).slice(0, 200_000),
    });
  };
  socket.on("framesent", (event) => saveFrame("sent", event));
  socket.on("framereceived", (event) => saveFrame("received", event));
});

console.log(`Recorder attached. Waiting for canvas ${canvasId} ...`);
if (freshPage) {
  await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
} else if (new URL(page.url()).pathname !== `/canvas/${canvasId}`) {
  await page.waitForURL((url) => url.pathname === `/canvas/${canvasId}`, {
    timeout: 15 * 60_000,
  });
}
await page.waitForTimeout(20_000);

const storage = await page.evaluate(async () => {
  const databases = [];
  if (typeof indexedDB.databases === "function") {
    for (const metadata of await indexedDB.databases()) {
      if (!metadata.name) continue;
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open(metadata.name);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const stores = [];
      for (const storeName of database.objectStoreNames) {
        const transaction = database.transaction(storeName, "readonly");
        const store = transaction.objectStore(storeName);
        const count = await new Promise((resolve, reject) => {
          const request = store.count();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const sample = await new Promise((resolve, reject) => {
          const request = store.getAll(null, 3);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        stores.push({ name: storeName, count, sample });
      }
      database.close();
      databases.push({ ...metadata, stores });
    }
  }

  const cacheStorage = [];
  if ("caches" in window) {
    for (const cacheName of await caches.keys()) {
      const cache = await caches.open(cacheName);
      cacheStorage.push({
        name: cacheName,
        urls: (await cache.keys()).slice(0, 100).map((request) => request.url),
      });
    }
  }

  async function listDirectory(directory, depth = 0) {
    if (depth > 3) return [];
    const entries = [];
    for await (const [name, handle] of directory.entries()) {
      const entry = { name, kind: handle.kind };
      if (handle.kind === "directory") {
        entry.children = await listDirectory(handle, depth + 1);
      } else {
        const file = await handle.getFile();
        entry.size = file.size;
        entry.type = file.type;
      }
      entries.push(entry);
      if (entries.length >= 200) break;
    }
    return entries;
  }

  let opfs = [];
  try {
    if (navigator.storage?.getDirectory) {
      opfs = await listDirectory(await navigator.storage.getDirectory());
    }
  } catch {
    opfs = [{ error: "OPFS listing failed" }];
  }

  return {
    localStorage: { ...localStorage },
    sessionStorageKeys: Object.keys(sessionStorage),
    databases,
    cacheStorage,
    opfs,
    serviceWorkers: (await navigator.serviceWorker?.getRegistrations?.())?.map(
      (registration) => ({
        scope: registration.scope,
        activeScript: registration.active?.scriptURL ?? null,
      }),
    ),
  };
});

const pageSnapshot = await page.evaluate(() => ({
  url: location.href,
  title: document.title,
  bodyText: document.body?.innerText?.slice(0, 50_000) ?? "",
  canvasElements: document.querySelectorAll("canvas").length,
  svgElements: document.querySelectorAll("svg").length,
  imageSources: [...document.images]
    .map((image) => image.currentSrc || image.src)
    .filter(Boolean)
    .slice(0, 500),
}));

await page.screenshot({ path: path.join(runDir, "canvas.png"), fullPage: true });
await Promise.allSettled(pendingWrites);
await fs.writeFile(
  path.join(runDir, "network.json"),
  JSON.stringify(network, null, 2),
);
await fs.writeFile(
  path.join(runDir, "body-index.json"),
  JSON.stringify(bodyIndex, null, 2),
);
await fs.writeFile(
  path.join(runDir, "websockets.json"),
  JSON.stringify(sockets, null, 2),
);
await fs.writeFile(
  path.join(runDir, "storage.json"),
  JSON.stringify(redactValue(storage), null, 2),
);
await fs.writeFile(
  path.join(runDir, "page.json"),
  JSON.stringify(pageSnapshot, null, 2),
);
await fs.writeFile(
  path.join(runDir, "page-errors.json"),
  JSON.stringify(pageErrors, null, 2),
);

console.log(
  JSON.stringify(
    {
      runDir,
      url: page.url(),
      networkEvents: network.length,
      capturedBodies: bodyIndex.length,
      websockets: sockets.length,
      indexedDbCount: storage.databases.length,
      bodyPreview: pageSnapshot.bodyText.slice(0, 500),
    },
    null,
    2,
  ),
);

await browser.close();
