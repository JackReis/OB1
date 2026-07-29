import { test } from "node:test";
import assert from "node:assert/strict";

// argValue reads from module-level `args` which is set at import time.
// We test the parsing logic independently to verify correctness.

function parseArgs(argv) {
  const args = argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const verify = args.includes("--verify");
  const sideTablesOnly = args.includes("--side-tables-only");

  function argValue(name) {
    const inline = args.find((arg) => arg.startsWith(`${name}=`));
    if (inline) return inline.slice(name.length + 1);
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] || "" : "";
  }

  return { dryRun, verify, sideTablesOnly, argValue };
}

test("argValue: extracts inline value with --flag=value syntax", () => {
  const { argValue } = parseArgs(["node", "script.js", "--start-at-source-id=abc-123"]);
  assert.equal(argValue("--start-at-source-id"), "abc-123");
});

test("argValue: extracts value from space-separated flag", () => {
  const { argValue } = parseArgs(["node", "script.js", "--start-at-source-id", "def-456"]);
  assert.equal(argValue("--start-at-source-id"), "def-456");
});

test("argValue: returns empty string for missing flag", () => {
  const { argValue } = parseArgs(["node", "script.js"]);
  assert.equal(argValue("--start-at-source-id"), "");
});

test("flags: dry-run, verify, side-tables-only parsed correctly", () => {
  const { dryRun, verify, sideTablesOnly } = parseArgs(["node", "script.js", "--dry-run", "--verify"]);
  assert.equal(dryRun, true);
  assert.equal(verify, true);
  assert.equal(sideTablesOnly, false);
});

test("flags: all false when no flags present", () => {
  const { dryRun, verify, sideTablesOnly } = parseArgs(["node", "script.js", "some-backup-dir"]);
  assert.equal(dryRun, false);
  assert.equal(verify, false);
  assert.equal(sideTablesOnly, false);
});