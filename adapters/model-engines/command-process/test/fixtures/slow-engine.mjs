process.stdin.resume();

const timer = setTimeout(() => {
  process.stdout.write(
    JSON.stringify({
      text: JSON.stringify({
        apiVersion: "chartermesh.dev/structured-artifact/v1alpha1",
        summary: "Slow fixture completed.",
        deliverables: ["fixture"],
        checks: ["completed"],
        risks: [],
        nextActions: [],
        confidence: "high",
      }),
      finishReason: "stop",
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cost: 0,
      },
    }),
  );
}, 30_000);

const stop = () => {
  clearTimeout(timer);
  process.exit(20);
};

process.once("SIGINT", stop);
process.once("SIGTERM", stop);
