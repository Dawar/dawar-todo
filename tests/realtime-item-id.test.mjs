import assert from "node:assert/strict";
import test from "node:test";
import { realtimeConversationItemId } from "../lib/realtime-item-id.ts";

test("Realtime conversation item IDs stay deterministic and within the API limit", () => {
  const uuid = "6f1fd6a8-cf9a-4f84-8221-a0cb9c43ec57";
  const compact = realtimeConversationItemId(uuid);

  assert.equal(compact, "6f1fd6a8cf9a4f848221a0cb9c43ec57");
  assert.equal(compact.length, 32);
  assert.match(compact, /^[A-Za-z0-9_]+$/);

  const longClientId = "offline message with punctuation / and a much longer identifier";
  const first = realtimeConversationItemId(longClientId);
  const second = realtimeConversationItemId(longClientId);
  assert.equal(first, second);
  assert.ok(first.length <= 32);
  assert.match(first, /^[A-Za-z0-9_]+$/);
});
