import assert from "node:assert/strict";
import test from "node:test";
import { messageListener } from "../utils/messages";

test("unrelated listeners ignore messages synchronously without stealing the response", async () => {
  const replies: unknown[] = [];
  const companion = messageListener(["review"], async () => ({ review: true }));
  const backup = messageListener(["backup"], async () => ({ ok: true }));
  const reply = (value: unknown) => replies.push(value);
  assert.equal(companion({ type: "backup" }, {}, reply), false);
  assert.equal(backup({ type: "backup" }, {}, reply), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(replies, [{ ok: true }]);
});

test("async failures produce one explicit error response", async () => {
  const listener = messageListener(["backup"], async () => { throw new Error("connection lost"); });
  const response = new Promise(resolve => {
    assert.equal(listener({ type: "backup" }, {}, resolve), true);
  });
  assert.deepEqual(await response, { ok: false, error: "connection lost" });
});
