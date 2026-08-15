import { existsSync, writeFileSync } from "node:fs";
import {
  ControlPlane,
  openControlPlaneDatabase,
} from "../../src/index.ts";

const [action, databasePath, artifactPath, barrier, ...rest] =
  process.argv.slice(2);
if (!action || !databasePath || !artifactPath) {
  throw new Error("action, database path, and artifact path are required");
}

const waitFor = async (path) => {
  if (!path || path === "-") return;
  const deadline = Date.now() + 10_000;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error("barrier timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

await waitFor(barrier);
const database = openControlPlaneDatabase(databasePath);
const controlPlane = new ControlPlane(database, artifactPath);
try {
  if (action === "claim") {
    try {
      const value = controlPlane.claim({
        id: rest[0],
        actor: `runner:${process.pid}`,
        idempotencyKey: rest[1],
      });
      console.log(JSON.stringify({ ok: true, value }));
    } catch (error) {
      console.log(
        JSON.stringify({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  } else if (action === "intake") {
    try {
      const value = controlPlane.intake({
        title: "Concurrent idempotent intake",
        summary: "Every process uses one exact command key.",
        actor: "human:process-shared",
        idempotencyKey: rest[0],
      });
      console.log(JSON.stringify({ ok: true, value }));
    } catch (error) {
      console.log(
        JSON.stringify({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  } else if (action === "hold-lock") {
    database.exec("BEGIN IMMEDIATE");
    writeFileSync(rest[0], "locked\n");
    Atomics.wait(
      new Int32Array(new SharedArrayBuffer(4)),
      0,
      0,
      Number(rest[1] ?? 750),
    );
    database.exec("COMMIT");
    console.log(JSON.stringify({ ok: true }));
  } else {
    throw new Error(`unknown action '${action}'`);
  }
} finally {
  database.close();
}
