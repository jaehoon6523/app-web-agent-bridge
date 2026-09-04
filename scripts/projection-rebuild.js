#!/usr/bin/env node
import process from "node:process";
import {
  executeProjectionRebuild,
  parseProjectionRebuildArguments,
  PROJECTION_REBUILD_USAGE,
} from "../src/repository/projection-rebuild-command.js";

async function main() {
  const options = parseProjectionRebuildArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${PROJECTION_REBUILD_USAGE}\n`);
    return;
  }
  const result = await executeProjectionRebuild(options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  const code = typeof error?.code === "string" ? error.code : "PROJECTION_REBUILD_FAILED";
  const message = error instanceof Error ? error.message : "Projection rebuild failed";
  process.stderr.write(`${JSON.stringify({ ok: false, code, message })}\n`);
  process.exitCode = code === "CLI_USAGE_ERROR" ? 2 : 1;
});

