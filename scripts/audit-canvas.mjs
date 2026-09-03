import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright";
import {
  redactHeaders,
  redactText,
  redactValue,
} from "./lib/redact.mjs";

const targetUrl =
  process.env.TAPNOW_CANVAS_URL ??
  "https://app.tapnow.ai/canvas/350073d9-2b5a-4a79-b057-4f9e644c75d4";
const artifactRoot = path.resolve(
  process.env.TAPNOW_ARTIFACT_DIR ?? "artifacts/private",
);
const runDir = path.join(
  artifactRoot,
  new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-"),
);

await fs.mkdir(runDir, { recursive: true });

const events = [];
const sockets = [];
const pageErrors = [];
const capturedBodies = [];

function isFirstPartyApi(url) {
  const parsed = new URL(url);
  return (
    ["app.tapnow.ai", "api.tapnow.ai"].includes(parsed.hostname) &&
    parsed.pathname.includes("/api/")
  );
}

function bodyFileName(method, url, suffix) {
  const parsed = new URL(url);
  const readablePath =
    parsed.pathname
      .replace(/^\/+/, "")
      .replaceAll(/[^A-Za-z0-9._-]+/g, "_")
      .slice(0, 90) || "root";
  const hash = crypto
    .createHash("sha256")
    .update(`${method} ${url}`)
    .digest("hex")
    .slice(0, 10);
  return `${method.toLowerCase()}-${readablePath}-${hash}.${suffix}`;
}

function requestKind(resourceType, url) {
  if (resourceType === "fetch" || resourceType === "xhr") return "api";
  if (url.includes("graphql")) return "graphql";
  return resourceType;
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  locale: "zh-CN",
});

context.on("request", (request) => {
  const resourceType = request.resourceType();
  if (!["fetch", "xhr", "document"].includes(resourceType)) return;
  events.push({
    phase: "request",
    at: new Date().toISOString(),
    kind: requestKind(resourceType, request.url()),
    method: request.method(),
    url: request.url(),
    headers: redactHeaders(request.headers()),
    postDataSize: request.postDataBuffer()?.length ?? 0,
  });

  const postData = request.postData();
  if (
    postData &&
    postData.length <= 1_000_000 &&
    isFirstPartyApi(request.url()) &&
    !/auth|login|register/i.test(request.url())
  ) {
    capturedBodies.push({
      type: "request",
      method: request.method(),
      url: request.url(),
      fileName: bodyFileName(request.method(), request.url(), "request.txt"),
      body: redactText(postData),
    });
  }
});

context.on("response", async (response) => {
  const request = response.request();
  const resourceType = request.resourceType();
  if (!["fetch", "xhr", "document"].includes(resourceType)) return;
  const headers = response.headers();
  events.push({
    phase: "response",
    at: new Date().toISOString(),
    kind: requestKind(resourceType, response.url()),
    method: request.method(),
    url: response.url(),
    status: response.status(),
    contentType: headers["content-type"] ?? "",
    contentLength: headers["content-length"] ?? "",
    headers: redactHeaders(headers),
  });

  if (
    response.ok() &&
    isFirstPartyApi(response.url()) &&
    /json|text|event-stream/i.test(headers["content-type"] ?? "") &&
    !/auth|login|register/i.test(response.url())
  ) {
    try {
      const body = await response.text();
      if (body.length <= 5_000_000) {
        capturedBodies.push({
          type: "response",
          method: request.method(),
          url: response.url(),
          status: response.status(),
          fileName: bodyFileName(request.method(), response.url(), "response.txt"),
          body: redactText(body),
        });
      }
    } catch {
      // Redirected, cached, and streaming responses may not expose a body.
    }
  }
});

const page = await context.newPage();
page.on("pageerror", (error) => pageErrors.push(String(error)));
page.on("websocket", (socket) => {
  const socketEntry = {
    url: socket.url(),
    openedAt: new Date().toISOString(),
    sentFrames: 0,
    receivedFrames: 0,
    frames: [],
  };
  sockets.push(socketEntry);
  socket.on("framesent", (event) => {
    socketEntry.sentFrames++;
    if (socketEntry.frames.length < 200 && typeof event.payload === "string") {
      socketEntry.frames.push({
        direction: "sent",
        payload: redactText(event.payload).slice(0, 100_000),
      });
    }
  });
  socket.on("framereceived", (event) => {
    socketEntry.receivedFrames++;
    if (socketEntry.frames.length < 200 && typeof event.payload === "string") {
      socketEntry.frames.push({
        direction: "received",
        payload: redactText(event.payload).slice(0, 100_000),
      });
    }
  });
});

await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
await page.waitForTimeout(8_000);

await page.screenshot({
  path: path.join(runDir, "page.png"),
  fullPage: true,
});

const snapshot = await page.evaluate(async () => {
  const localStorageKeys = Object.keys(localStorage);
  const sessionStorageKeys = Object.keys(sessionStorage);
  const indexedDbDatabases =
    typeof indexedDB.databases === "function"
      ? await indexedDB.databases()
      : [];

  return {
    url: location.href,
    title: document.title,
    bodyText: document.body?.innerText?.slice(0, 30_000) ?? "",
    links: [...document.querySelectorAll("a[href]")].slice(0, 100).map((link) => ({
      text: link.textContent?.trim().slice(0, 200) ?? "",
      href: link.href,
    })),
    inputs: [...document.querySelectorAll("input")].map((element) => ({
      type: element.type,
      name: element.name,
      placeholder: element.placeholder,
      autocomplete: element.autocomplete,
    })),
    buttons: [...document.querySelectorAll("button")].slice(0, 100).map((button) => ({
      text: button.textContent?.trim().slice(0, 200) ?? "",
      ariaLabel: button.getAttribute("aria-label"),
      title: button.getAttribute("title"),
    })),
    localStorageKeys,
    sessionStorageKeys,
    indexedDbDatabases,
  };
});

await fs.writeFile(
  path.join(runDir, "snapshot.json"),
  JSON.stringify(snapshot, null, 2),
);
await fs.writeFile(
  path.join(runDir, "network.json"),
  JSON.stringify(events, null, 2),
);
await fs.writeFile(
  path.join(runDir, "websockets.json"),
  JSON.stringify(sockets, null, 2),
);
await fs.writeFile(
  path.join(runDir, "page-errors.json"),
  JSON.stringify(pageErrors, null, 2),
);
await fs.mkdir(path.join(runDir, "bodies"), { recursive: true });
for (const capture of capturedBodies) {
  await fs.writeFile(
    path.join(runDir, "bodies", capture.fileName),
    capture.body,
  );
}
await fs.writeFile(
  path.join(runDir, "body-index.json"),
  JSON.stringify(
    capturedBodies.map(({ body: _body, ...metadata }) => metadata),
    null,
    2,
  ),
);

console.log(
  JSON.stringify(
    {
      runDir,
      finalUrl: page.url(),
      title: await page.title(),
      requests: events.filter((event) => event.phase === "request").length,
      responses: events.filter((event) => event.phase === "response").length,
      capturedBodies: capturedBodies.length,
      websockets: sockets.length,
      bodyPreview: snapshot.bodyText.slice(0, 500),
      inputCount: snapshot.inputs.length,
      buttonCount: snapshot.buttons.length,
    },
    null,
    2,
  ),
);

await context.close();
await browser.close();
