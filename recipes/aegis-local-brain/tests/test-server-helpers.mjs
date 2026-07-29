import { test } from "node:test";
import assert from "node:assert/strict";

// Set required env vars before importing server.mjs
process.env.POSTGREST_URL = "http://localhost:3000";
process.env.SERVICE_ROLE_KEY = "test-key";
process.env.BRAIN_ACCESS_KEY = "test-brain-key";

const {
  textOrNull, numberOrNull, boolOrFalse, boolOrTrue,
  jsonObjectOrEmpty, jsonArrayOrEmpty,
} = await import("../api/server.mjs");

test("textOrNull: returns null for undefined, null, or empty string", () => {
  assert.equal(textOrNull(undefined), null);
  assert.equal(textOrNull(null), null);
  assert.equal(textOrNull(""), null);
});

test("textOrNull: converts non-empty value to string", () => {
  assert.equal(textOrNull("hello"), "hello");
  assert.equal(textOrNull(42), "42");
  assert.equal(textOrNull(true), "true");
});

test("numberOrNull: returns number for numeric input", () => {
  assert.equal(numberOrNull(42), 42);
  assert.equal(numberOrNull("3.14"), 3.14);
  assert.equal(numberOrNull(0), 0);
});

test("numberOrNull: returns null for non-finite values", () => {
  assert.equal(numberOrNull("not-a-number"), null);
  assert.equal(numberOrNull(NaN), null);
  assert.equal(numberOrNull(Infinity), null);
  assert.equal(numberOrNull(-Infinity), null);
});

test("numberOrNull: Number(null) is 0, so numberOrNull(null) returns 0", () => {
  // Number(null) === 0, which is finite, so this returns 0
  assert.equal(numberOrNull(null), 0);
  // Number(undefined) is NaN, so this returns null
  assert.equal(numberOrNull(undefined), null);
});

test("boolOrFalse: returns true only for literal true", () => {
  assert.equal(boolOrFalse(true), true);
  assert.equal(boolOrFalse(false), false);
  assert.equal(boolOrFalse(undefined), false);
  assert.equal(boolOrFalse(null), false);
  assert.equal(boolOrFalse("true"), false); // string, not boolean
  assert.equal(boolOrFalse(1), false);
});

test("boolOrTrue: returns false only for literal false", () => {
  assert.equal(boolOrTrue(false), false);
  assert.equal(boolOrTrue(true), true);
  assert.equal(boolOrTrue(undefined), true);
  assert.equal(boolOrTrue(null), true);
  assert.equal(boolOrTrue("false"), true); // string, not boolean false
});

test("jsonObjectOrEmpty: returns object for plain objects", () => {
  assert.deepEqual(jsonObjectOrEmpty({ a: 1 }), { a: 1 });
  assert.deepEqual(jsonObjectOrEmpty({}), {});
});

test("jsonObjectOrEmpty: returns {} for non-objects and arrays", () => {
  assert.deepEqual(jsonObjectOrEmpty(null), {});
  assert.deepEqual(jsonObjectOrEmpty(undefined), {});
  assert.deepEqual(jsonObjectOrEmpty("string"), {});
  assert.deepEqual(jsonObjectOrEmpty([1, 2]), {}); // arrays are not objects
  assert.deepEqual(jsonObjectOrEmpty(42), {});
});

test("jsonArrayOrEmpty: returns array for arrays", () => {
  assert.deepEqual(jsonArrayOrEmpty([1, 2]), [1, 2]);
  assert.deepEqual(jsonArrayOrEmpty([]), []);
});

test("jsonArrayOrEmpty: returns [] for non-arrays", () => {
  assert.deepEqual(jsonArrayOrEmpty(null), []);
  assert.deepEqual(jsonArrayOrEmpty(undefined), []);
  assert.deepEqual(jsonArrayOrEmpty("string"), []);
  assert.deepEqual(jsonArrayOrEmpty({ a: 1 }), []);
});