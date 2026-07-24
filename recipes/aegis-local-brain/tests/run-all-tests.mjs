#!/usr/bin/env node
/**
 * Run all brain-backup tests.
 * Usage: node tests/run-all-tests.mjs
 * Or: node --test tests/test-*.mjs
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testGlob = path.join(__dirname, "test-*.mjs");

const result = spawnSync("node", ["--test", testGlob], {
  stdio: "inherit",
  env: {
    ...process.env,
    POSTGREST_URL: "http://localhost:3000",
    SERVICE_ROLE_KEY: "test-key",
    BRAIN_ACCESS_KEY: "test-brain-key",
  },
});

process.exit(result.status ?? 1);