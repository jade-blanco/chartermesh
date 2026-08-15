let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  const envelope = JSON.parse(input);
  const request = envelope.request;
  const userText = request.messages
    .filter((message) => message.role === "user")
    .map((message) => message.content)
    .join("\n");
  const replayed = userText.includes(
    "An exact human-approved pending tool call was replayed successfully",
  );
  if (!replayed) {
    process.stdout.write(
      JSON.stringify({
        text: "",
        toolCalls: [
          {
            id: "approval-write-1",
            name: "workspace.write_file",
            arguments: {
              path: "approval-fixture.txt",
              content: "approved\n",
              beforeSha256: null,
            },
          },
        ],
        finishReason: "tool_call",
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      }),
    );
    return;
  }
  process.stdout.write(
    JSON.stringify({
      text: JSON.stringify({
        apiVersion: "chartermesh.dev/structured-artifact/v1alpha1",
        summary: "Approved call was replayed",
        deliverable: "The exact approved workspace write was executed.",
        checks: ["The replay evidence was supplied by the managed runner."],
        risks: [],
        nextActions: ["Review the immutable artifact hash."],
        confidence: "high",
      }),
      toolCalls: [],
      finishReason: "stop",
      usage: {
        inputTokens: 150,
        outputTokens: 70,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    }),
  );
});
