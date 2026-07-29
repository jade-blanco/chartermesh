import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const directory = mkdtempSync(join(tmpdir(), "chartermesh-package-"));
const packageDirectory = join(directory, "package");
const consumer = join(directory, "consumer");
const target = join(directory, "clean-project");
mkdirSync(packageDirectory);
mkdirSync(consumer);
mkdirSync(target);

const npmCli = join(
  dirname(process.execPath),
  "node_modules",
  "npm",
  "bin",
  "npm-cli.js",
);
const npm = existsSync(npmCli) ? process.execPath : "npm";
const npmPrefix = existsSync(npmCli) ? [npmCli] : [];
const run = (executable, args, options = {}) => {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    env: {
      ...process.env,
      CHARTERMESH_NO_UPDATE_CHECK: "1",
      npm_config_cache: join(directory, "npm-cache"),
      npm_config_update_notifier: "false",
    },
    ...options,
  });
  assert.equal(
    result.status,
    0,
    `${executable} ${args.join(" ")}\n${result.error?.message ?? ""}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  );
  return result.stdout;
};

const packed = JSON.parse(
  run(npm, [
    ...npmPrefix,
    "pack",
    "--json",
    "--ignore-scripts",
    "--pack-destination",
    packageDirectory,
  ]),
);
assert.equal(packed.length, 1);
const archive = join(packageDirectory, packed[0].filename);
assert.equal(existsSync(archive), true);
run(npm, [
  ...npmPrefix,
  "install",
  "--no-audit",
  "--no-fund",
  "--prefix",
  consumer,
  archive,
]);

const installed = join(
  consumer,
  "node_modules",
  "chartermesh",
);
const executable = join(installed, "bin", "chartermesh.mjs");
assert.equal(existsSync(executable), true);
assert.equal(
  existsSync(
    join(
      consumer,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "chartermesh.cmd" : "chartermesh",
    ),
  ),
  true,
);
const version = JSON.parse(
  run(process.execPath, [executable, "version", "--json"], {
    cwd: target,
  }),
);
assert.equal(version.data.currentVersion, "0.0.5-alpha.1");

const proposal = JSON.parse(
  run(
    process.execPath,
    [executable, "propose", "--target", target, "--json"],
  ),
);
assert.equal(proposal.data.organization.kind, "Organization");
const preview = JSON.parse(
  run(
    process.execPath,
    [
      executable,
      "bootstrap",
      "--target",
      target,
      "--engine",
      "fake",
      "--json",
    ],
  ),
);
assert.equal(preview.data.approvalRequired, true);
assert.equal(existsSync(join(target, ".chartermesh")), false);
run(process.execPath, [
  executable,
  "bootstrap",
  "--target",
  target,
  "--engine",
  "fake",
  "--json",
  "--approve",
  preview.data.planHash,
]);
const doctor = JSON.parse(
  run(process.execPath, [
    executable,
    "doctor",
    "--target",
    target,
    "--json",
  ]),
);
assert.equal(doctor.ok, true);
assert.equal(
  JSON.parse(
    readFileSync(
      join(target, ".chartermesh", "installation.json"),
      "utf8",
    ),
  ).charterMeshVersion,
  "0.0.5-alpha.1",
);
console.log(`Package install check passed: ${packed[0].filename}`);
