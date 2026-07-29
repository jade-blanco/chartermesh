import assert from "node:assert/strict";
import test from "node:test";
import { evaluateIntervalSchedule } from "../src/index.ts";

test("interval scheduler is immediately due then waits without model work", () => {
  const now = new Date("2026-07-30T00:00:00.000Z");
  const first = evaluateIntervalSchedule({
    rrule: "FREQ=HOURLY;INTERVAL=3",
    timezone: "Asia/Seoul",
    now,
  });
  assert.equal(first.due, true);
  assert.equal(first.intervalMs, 10_800_000);
  assert.equal(
    evaluateIntervalSchedule({
      rrule: "FREQ=HOURLY;INTERVAL=3",
      timezone: "Asia/Seoul",
      now: new Date("2026-07-30T02:59:59.000Z"),
      lastStartedAt: now.toISOString(),
    }).due,
    false,
  );
  assert.equal(
    evaluateIntervalSchedule({
      rrule: "FREQ=HOURLY;INTERVAL=3",
      timezone: "Asia/Seoul",
      now: new Date("2026-07-30T03:00:00.000Z"),
      lastStartedAt: now.toISOString(),
    }).due,
    true,
  );
});

test("scheduler rejects unsupported recurrence and timezone values", () => {
  assert.throws(
    () =>
      evaluateIntervalSchedule({
        rrule: "FREQ=SECONDLY",
        timezone: "Asia/Seoul",
        now: new Date(),
      }),
    /SCHEDULE_RRULE_UNSUPPORTED/u,
  );
  assert.throws(
    () =>
      evaluateIntervalSchedule({
        rrule: "FREQ=DAILY",
        timezone: "Not/A_Timezone",
        now: new Date(),
      }),
    /SCHEDULE_TIMEZONE_INVALID/u,
  );
});
