import test from "node:test";
import assert from "node:assert/strict";
import {
  inferNodeTypeFromId,
  inferPromptFromNodeText,
  normalizeSettings,
  reviewDraft
} from "../utils/reviewer";
import { MAX_LLM_PROMPT_LENGTH } from "../utils/limits";

test("infers the node type from TapNow's real node id", () => {
  assert.equal(
    inferNodeTypeFromId("text-ab4e1f84-7a43-4e82-9093-f4205deb8825"),
    "text"
  );
  assert.equal(inferNodeTypeFromId(""), null);
});

test("keeps a custom LLM prompt bounded and restores the default when absent", () => {
  const custom = normalizeSettings({ llmPrompt: "检查提示词" });
  assert.equal(custom.llmPrompt, "检查提示词");
  assert.equal(normalizeSettings().llmPrompt.length > 0, true);
  assert.equal(
    normalizeSettings({ llmPrompt: "x".repeat(MAX_LLM_PROMPT_LENGTH + 100) }).llmPrompt.length,
    MAX_LLM_PROMPT_LENGTH
  );
});

test("recovers prompt text rendered by a non-editing Text node", () => {
  const rendered =
    "TextPin双击开始编辑... To pick up a draggable item, press the space bar. While dragging, use the arrow keys to move the item. Press space again to drop the item in its new position, or press escape to cancel. 让两个furry 男孩 暧昧的交互请帮我写提示词Gemini 3.1 Flash Lite1×1";
  assert.equal(
    inferPromptFromNodeText(rendered),
    "让两个furry 男孩 暧昧的交互请帮我写提示词"
  );
});

test("recovers the real TapNow English placeholder form", () => {
  assert.equal(
    inferPromptFromNodeText(
      "Text Double-click to start editing... 让两个furry 男孩 暧昧的交互，请帮我写提示词1"
    ),
    "让两个furry 男孩 暧昧的交互，请帮我写提示词"
  );
});

test("does not treat the image node placeholder as a prompt", () => {
  assert.equal(
    inferPromptFromNodeText(
      "Image图片生成描述任何你想要生成的内容，按@引用素材，/呼出指令5"
    ),
    ""
  );
  assert.equal(
    inferPromptFromNodeText(
      "图片生成Describe anything you want to generate, press@for context"
    ),
    ""
  );
});

test("removes the real node model badge and trailing controls", () => {
  assert.equal(
    inferPromptFromNodeText(
      "Pin Double-click to start editing... 让两个furry 男孩 暧昧的交互，请帮我写提示词 Gemini 3.1 Flash Lite 1× - -"
    ),
    "让两个furry 男孩 暧昧的交互，请帮我写提示词"
  );
});

test("removes controls when TapNow renders trailing dashes without a space", () => {
  assert.equal(
    inferPromptFromNodeText(
      "让两个furry 男孩 暧昧的交互，请帮我写提示词--"
    ),
    "让两个furry 男孩 暧昧的交互，请帮我写提示词"
  );
});

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
