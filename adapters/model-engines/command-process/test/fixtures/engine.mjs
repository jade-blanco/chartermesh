let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  const envelope = JSON.parse(input);
  const request = envelope.request;
  const user = [...request.messages]
    .reverse()
    .find((message) => message.role === "user");
  const artifact = {
    apiVersion: "chartermesh.dev/structured-artifact/v1alpha1",
    summary: "Command-process fixture completed",
    deliverable: user?.content?.slice(0, 300) ?? "No user message.",
    checks: [
      `cwd:${process.cwd()}`,
      `allowed-env:${Boolean(process.env.CHARTERMESH_FIXTURE_ALLOWED)}`,
      `hidden-env:${Boolean(process.env.CHARTERMESH_FIXTURE_HIDDEN)}`,
    ],
    risks: ["This fixture performs no external side effects."],
    nextActions: ["Review the exact artifact hash."],
    confidence: "high",
  };
  process.stdout.write(
    JSON.stringify({
      text: JSON.stringify(artifact),
      toolCalls: [],
      finishReason: "stop",
      usage: {
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 0,
        cacheWriteTokens: 0
      }
    }),
  );
});
