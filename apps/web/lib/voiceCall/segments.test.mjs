// node --test lib/voiceCall/segments.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { isNewSegment } from "./segments.ts";

test("a sentence reported once per spoken word is one caption", () => {
  const seen = new Set();
  const events = [{ segment_id: 11444 }, ...Array.from({ length: 30 }, () => ({ segment_id: 11444 })), { segment_id: 11445 }];
  assert.equal(events.filter((e) => isNewSegment(seen, e)).length, 2);
});

test("events without a segment id (older servers) always count", () => {
  const seen = new Set();
  assert.deepEqual([{}, {}, { segment_id: undefined }].map((e) => isNewSegment(seen, e)), [true, true, true]);
});
