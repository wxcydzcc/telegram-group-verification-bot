import assert from "node:assert/strict";
import test from "node:test";

import { buildChallenge, buildLinkKeyboard, membershipAllowed } from "../src/index.js";

test("all challenge types produce four unique options and one valid answer index", () => {
  for (const [index, kind] of ["arithmetic", "largest", "count", "sequence"].entries()) {
    const challenge = buildChallenge(seededRandom(index + 1), kind);
    assert.equal(challenge.kind, kind);
    assert.ok(challenge.prompt.length > 0);
    assert.equal(challenge.options.length, 4);
    assert.equal(new Set(challenge.options).size, 4);
    assert.ok(challenge.correctIndex >= 0 && challenge.correctIndex < 4);
  }
});

function seededRandom(seed) {
  let state = seed >>> 0;
  return (min, max) => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return min + (state % (max - min + 1));
  };
}

test("membership transition helper accepts active members", () => {
  assert.equal(membershipAllowed({ status: "member" }), true);
  assert.equal(membershipAllowed({ status: "administrator" }), true);
  assert.equal(membershipAllowed({ status: "restricted", is_member: true }), true);
});

test("membership transition helper rejects departed members", () => {
  assert.equal(membershipAllowed({ status: "left" }), false);
  assert.equal(membershipAllowed({ status: "kicked" }), false);
  assert.equal(membershipAllowed({ status: "restricted", is_member: false }), false);
});

test("welcome link menu keeps configured links and omits empty values", () => {
  const keyboard = buildLinkKeyboard({
    CHANNEL_URL: "https://t.me/example",
    WEBSITE_URL: "https://example.com",
    BLOG_URL: "",
  });
  assert.equal(keyboard.inline_keyboard.length, 1);
  assert.equal(keyboard.inline_keyboard[0].length, 2);
  assert.equal(keyboard.inline_keyboard[0][0].url, "https://t.me/example");
});
