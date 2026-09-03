import assert from "node:assert/strict";
import test from "node:test";
import {
  redactHeaders,
  redactText,
  redactValue,
} from "../scripts/lib/redact.mjs";

test("redacts sensitive object fields recursively", () => {
  assert.deepEqual(
    redactValue({
      canvasId: "canvas-1",
      email: "owner@example.com",
      nested: {
        access_token: "secret-token",
        nodeCount: 4,
      },
    }),
    {
      canvasId: "canvas-1",
      email: "[REDACTED]",
      nested: {
        access_token: "[REDACTED]",
        nodeCount: 4,
      },
    },
  );
});

test("redacts bearer tokens and sensitive query values in text", () => {
  const result = redactText(
    "Authorization: Bearer abc.def-123 /events?ticket=hello&mode=watch",
  );
  assert.equal(
    result,
    "Authorization: Bearer [REDACTED] /events?ticket=[REDACTED]&mode=watch",
  );
});

test("redacts credential headers case-insensitively", () => {
  assert.deepEqual(
    redactHeaders({
      Authorization: "Bearer example",
      Cookie: "session=example",
      "Content-Type": "application/json",
    }),
    {
      Authorization: "[REDACTED]",
      Cookie: "[REDACTED]",
      "Content-Type": "application/json",
    },
  );
});
