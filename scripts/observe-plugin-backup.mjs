import { chromium } from "playwright";
import fs from "node:fs/promises";
const browser = await chromium.connectOverCDP(process.env.TAPNOW_CDP_URL || "http://127.0.0.1:9223");
try {
  const page = browser.contexts()[0].pages().find(p => /^chrome-extension:.*\/backup\.html/.test(p.url()));
  if (!page) throw new Error("No extension backup page is open");
  const session = await page.context().newCDPSession(page);
  const observed = { extensionOrigin: new URL(page.url()).host, mediaResponses: 0, partialResponses: 0, headersWithTapNowReferer: 0, headersWithAuthorization: 0, durationSeconds: 30 };
  const media = new Set(), extra = new Map();
  session.on("Network.responseReceived", ({ requestId, response }) => {
    if (new URL(response.url).hostname !== "files.tapnow.media") return;
    media.add(requestId); observed.mediaResponses++;
    if (response.status === 206) observed.partialResponses++;
  });
  session.on("Network.requestWillBeSentExtraInfo", ({ requestId, headers }) => {
    const lower = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
    extra.set(requestId, { referer: lower.referer === "https://app.tapnow.ai/", authorization: Boolean(lower.authorization) });
  });
  await session.send("Network.enable");
  await new Promise(resolve => setTimeout(resolve, observed.durationSeconds * 1000));
  for (const id of media) {
    observed.headersWithTapNowReferer += Number(extra.get(id)?.referer || false);
    observed.headersWithAuthorization += Number(extra.get(id)?.authorization || false);
  }
  observed.statusText = await page.locator("#status").innerText();
  observed.observedAt = new Date().toISOString();
  await fs.writeFile("artifacts/private/plugin-network-observation.json", JSON.stringify(observed, null, 2));
  console.log(JSON.stringify(observed, null, 2));
  await session.detach();
} finally { await browser.close(); }
