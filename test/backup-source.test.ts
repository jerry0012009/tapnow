import test from "node:test";
import assert from "node:assert/strict";
import { backupPageQuery, canvasIdFromUrl, sourceMatches } from "../utils/backup/source";
const id = "00000000-0000-4000-8000-000000000001";
const url = `https://app.tapnow.ai/canvas/${id}`;
test("only concrete TapNow canvas URLs are selectable, never project lists", () => {
  assert.equal(canvasIdFromUrl(url), id);
  assert.equal(canvasIdFromUrl(`${url}?x=1#node`), id);
  for (const bad of ["https://app.tapnow.ai/canvas/projects?scope=team", "https://app.tapnow.ai/canvas/",
    `https://example.com/canvas/${id}`, "https://app.tapnow.ai/canvas/undefined"]) assert.equal(canvasIdFromUrl(bad), null);
});
test("page entry binds both source tab and canvas, independent of tab ordering", () => {
  const query = new URLSearchParams(backupPageQuery({ id: 23, url }));
  assert.equal(query.get("sourceTab"), "23");
  assert.equal(query.get("canvasId"), id);
  assert.equal(sourceMatches({ id: 23, url }, 23, id), true);
  assert.equal(sourceMatches({ id: 24, url }, 23, id), false);
  assert.equal(sourceMatches({ id: 23, url: "https://app.tapnow.ai/canvas/projects" }, 23, id), false);
  assert.equal(backupPageQuery({ id: 23, url: "https://app.tapnow.ai/canvas/projects" }), "from=projects");
});
