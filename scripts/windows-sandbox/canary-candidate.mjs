import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";

const [mode, hostSentinelPath, mappedOutputPath] =
  process.argv.slice(2);

if (mode === "hang") {
  setInterval(() => undefined, 60_000);
} else if (
  mode !== "probe" ||
  !hostSentinelPath ||
  !mappedOutputPath
) {
  process.stderr.write("invalid canary invocation\n");
  process.exitCode = 2;
} else {
  const deniedOperation = async (operation) => {
    try {
      await operation();
      return { denied: false, errorCode: "NONE" };
    } catch (error) {
      const errorCode =
        error &&
        typeof error === "object" &&
        typeof error.code === "string"
          ? error.code
          : "UNKNOWN";
      return {
        denied: errorCode === "ERR_ACCESS_DENIED",
        errorCode,
      };
    }
  };

  const hostRead = await deniedOperation(() =>
    readFile(hostSentinelPath, "utf8"),
  );
  const hostWrite = await deniedOperation(() =>
    writeFile(hostSentinelPath, "candidate-host-write", "utf8"),
  );
  const mappedOutputWrite = await deniedOperation(() =>
    writeFile(mappedOutputPath, "candidate-output-write", "utf8"),
  );

  let childProcess;
  try {
    const result = spawnSync(
      process.execPath,
      ["-e", "process.exit(0)"],
      {
        stdio: "ignore",
        timeout: 1_000,
        windowsHide: true,
      },
    );
    const errorCode =
      result.error &&
      typeof result.error === "object" &&
      typeof result.error.code === "string"
        ? result.error.code
        : "NONE";
    childProcess = {
      denied: errorCode === "ERR_ACCESS_DENIED",
      errorCode,
      status: result.status,
    };
  } catch (error) {
    const errorCode =
      error &&
      typeof error === "object" &&
      typeof error.code === "string"
        ? error.code
        : "UNKNOWN";
    childProcess = {
      denied: errorCode === "ERR_ACCESS_DENIED",
      errorCode,
      status: null,
    };
  }

  const interfaces = Object.entries(networkInterfaces())
    .flatMap(([name, addresses]) =>
      (addresses ?? []).map((address) => ({
        name,
        address: address.address,
        family: address.family,
        internal: address.internal,
      })),
    )
    .filter(({ internal }) => !internal);

  process.stdout.write(
    `${JSON.stringify({
      apiVersion:
        "chartermesh.dev/windows-sandbox-canary-candidate/v1alpha1",
      evidence: {
        networkDenied: interfaces.length === 0,
        hostReadDenied: hostRead.denied,
        hostWriteDenied:
          hostWrite.denied && mappedOutputWrite.denied,
        childEscapeDenied: childProcess.denied,
      },
      observations: {
        nonLoopbackInterfaces: interfaces,
        hostRead,
        hostWrite,
        mappedOutputWrite,
        childProcess,
      },
    })}\n`,
  );
}
