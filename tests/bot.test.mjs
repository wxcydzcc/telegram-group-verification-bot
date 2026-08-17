import assert from "node:assert/strict";
import test from "node:test";

import { buildChallenge, buildLinkKeyboard, membershipAllowed } from "../src/index.js";

test("challenge has one correct answer and four distinct options", () => {
  const sequence = [5, 7, -2, 3, 4, 1, 0, 0, 0, 0];
  let index = 0;
  const deterministic = (min, max) => {
    const value = sequence[index++] ?? min;
    return Math.min(max, Math.max(min, value));
  };
  const challenge = buildChallenge(deterministic);
  assert.equal(challenge.correct, challenge.a + challenge.b);
  assert.equal(challenge.options.length, 4);
  assert.equal(new Set(challenge.options).size, 4);
  assert.ok(challenge.options.includes(challenge.correct));
});

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
