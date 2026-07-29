import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

interface MaintenanceOwner {
  pid: number;
  reason: string;
  startedAt: string;
}

export function maintenanceLockPath(stateDirectory: string): string {
  return join(resolve(stateDirectory), ".maintenance-lock");
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "EPERM"
    );
  }
}

function readOwner(lock: string): Partial<MaintenanceOwner> {
  try {
    return JSON.parse(
      readFileSync(join(lock, "owner.json"), "utf8"),
    ) as Partial<MaintenanceOwner>;
  } catch {
    return {};
  }
}

export function isMaintenanceActive(stateDirectory: string): boolean {
  const lock = maintenanceLockPath(stateDirectory);
  if (!existsSync(lock)) return false;
  const owner = readOwner(lock);
  if (owner.pid && processIsAlive(owner.pid)) return true;
  return Date.now() - statSync(lock).mtimeMs < 30_000;
}

export function assertMaintenanceInactive(stateDirectory: string): void {
  if (isMaintenanceActive(stateDirectory)) {
    throw new Error("CONTROL_PLANE_MAINTENANCE_ACTIVE");
  }
}

export function acquireMaintenanceLock(
  stateDirectory: string,
  reason: string,
): () => void {
  const root = resolve(stateDirectory);
  mkdirSync(root, { recursive: true });
  const lock = maintenanceLockPath(root);
  try {
    mkdirSync(lock);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      (error as NodeJS.ErrnoException).code !== "EEXIST"
    ) {
      throw error;
    }
    const owner = readOwner(lock);
    if (
      (owner.pid && processIsAlive(owner.pid)) ||
      Date.now() - statSync(lock).mtimeMs < 30_000
    ) {
      throw new Error("CONTROL_PLANE_MAINTENANCE_ACTIVE");
    }
    rmSync(lock, { recursive: true, force: true });
    mkdirSync(lock);
  }
  const owner: MaintenanceOwner = {
    pid: process.pid,
    reason: reason.trim().slice(0, 200) || "maintenance",
    startedAt: new Date().toISOString(),
  };
  writeFileSync(
    join(lock, "owner.json"),
    `${JSON.stringify(owner, null, 2)}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  let released = false;
  return () => {
    if (released) return;
    released = true;
    rmSync(lock, { recursive: true, force: true });
  };
}
