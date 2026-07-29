export interface IntervalScheduleEvaluation {
  due: boolean;
  tickKey: string;
  intervalMs: number;
}

function intervalMilliseconds(rrule: string): number {
  const fields = new Map<string, string>();
  for (const part of rrule.trim().toUpperCase().split(";")) {
    const [key, value, ...extra] = part.split("=");
    if (!key || !value || extra.length > 0 || fields.has(key)) {
      throw new Error("SCHEDULE_RRULE_UNSUPPORTED");
    }
    fields.set(key, value);
  }
  if ([...fields.keys()].some((key) => !["FREQ", "INTERVAL"].includes(key))) {
    throw new Error("SCHEDULE_RRULE_UNSUPPORTED");
  }
  const unit = fields.get("FREQ");
  const interval = Number(fields.get("INTERVAL") ?? 1);
  if (
    !["MINUTELY", "HOURLY", "DAILY"].includes(unit ?? "") ||
    !Number.isSafeInteger(interval) ||
    interval < 1 ||
    interval > 10_000
  ) {
    throw new Error("SCHEDULE_RRULE_UNSUPPORTED");
  }
  const unitMs =
    unit === "MINUTELY"
      ? 60_000
      : unit === "HOURLY"
        ? 3_600_000
        : 86_400_000;
  return unitMs * interval;
}

export function evaluateIntervalSchedule(input: {
  rrule: string;
  timezone: string;
  now: Date;
  lastStartedAt?: string | null;
}): IntervalScheduleEvaluation {
  try {
    new Intl.DateTimeFormat("en-US", {
      timeZone: input.timezone,
    }).format(input.now);
  } catch {
    throw new Error("SCHEDULE_TIMEZONE_INVALID");
  }
  if (!Number.isFinite(input.now.getTime())) {
    throw new Error("SCHEDULE_TIME_INVALID");
  }
  const intervalMs = intervalMilliseconds(input.rrule);
  const bucket = Math.floor(input.now.getTime() / intervalMs);
  const last = input.lastStartedAt
    ? Date.parse(input.lastStartedAt)
    : Number.NaN;
  return {
    due:
      !Number.isFinite(last) ||
      input.now.getTime() - last >= intervalMs,
    tickKey: `interval-${intervalMs}-${bucket}`,
    intervalMs,
  };
}
