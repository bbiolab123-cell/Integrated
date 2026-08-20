import test from "node:test";
import assert from "node:assert/strict";

import { normalizeRoute } from "./errorEvents";

test("the same bug on different experiments collapses to one route", () => {
  assert.equal(normalizeRoute("/api/experiments/41/layout"), "/api/experiments/:id/layout");
  assert.equal(
    normalizeRoute("/api/experiments/41/layout"),
    normalizeRoute("/api/experiments/78/layout"),
  );
});

test("share tokens are collapsed rather than stored in the clear", () => {
  const token = "a1b2c3d4".repeat(8); // 64 hex chars
  assert.equal(normalizeRoute(`/api/public/experiments/${token}`), "/api/public/experiments/:token");
});

test("query strings are dropped, since they can carry user input", () => {
  assert.equal(normalizeRoute("/api/experiments?search=compound-x"), "/api/experiments");
});

test("routes with no variable parts are left alone", () => {
  assert.equal(normalizeRoute("/api/experiments"), "/api/experiments");
  assert.equal(normalizeRoute("/api/healthz"), "/api/healthz");
});

test("words that merely contain digits are not mistaken for ids", () => {
  assert.equal(normalizeRoute("/api/ai/general-chat"), "/api/ai/general-chat");
  assert.equal(normalizeRoute("/api/v2/experiments"), "/api/v2/experiments");
});
