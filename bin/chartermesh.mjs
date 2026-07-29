#!/usr/bin/env node

import { existsSync } from "node:fs";

const built = new URL("../dist/apps/cli/src/main.js", import.meta.url);
const source = new URL("../apps/cli/src/main.ts", import.meta.url);
const { main } = await import(existsSync(source) ? source.href : built.href);

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  },
);
