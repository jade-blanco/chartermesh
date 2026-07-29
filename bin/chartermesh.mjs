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
    const message = error instanceof Error ? error.message : String(error);
    if (process.argv.includes("--json")) {
      console.log(
        JSON.stringify(
          {
            apiVersion: "chartermesh.dev/cli/v1alpha1",
            command: process.argv[2] ?? "unknown",
            ok: false,
            error: { message },
          },
          null,
          2,
        ),
      );
    } else {
      console.error(message);
    }
    process.exitCode = 1;
  },
);
