import test from "node:test";
import assert from "node:assert/strict";
import { reviewDraft } from "../utils/reviewer";

test("blocks an empty prompt", () => {
  const result = reviewDraft({ prompt: "" });
  assert.equal(result.decision, "block");
  assert.equal(result.issues[0].code, "empty-prompt");
});

test("warns when a prompt misses team terms", () => {
  const result = reviewDraft(
    { prompt: "一个人在城市里走路" },
    { requiredTerms: ["电影感"] }
  );
  assert.equal(result.decision, "warn");
  assert.ok(result.issues.some((issue) => issue.code === "missing-required-term"));
});

test("blocks forbidden terms and allows a detailed clean prompt", () => {
  const blocked = reviewDraft(
    { prompt: "一个品牌角色，低俗姿势" },
    { forbiddenTerms: ["低俗"] }
  );
  assert.equal(blocked.decision, "block");

  const allowed = reviewDraft({
    prompt: "白色狐狸男孩坐在阳光草地上读书，浅蓝色连帽衫，柔和插画风格",
    nodeType: "text",
    upstreamSummary: "角色设定"
  });
  assert.equal(allowed.decision, "allow");
});
