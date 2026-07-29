# Connecting model engines

CharterMesh core does not depend on a model vendor or agent product. The first
live HTTP adapter implements OpenAI-compatible `POST /v1/chat/completions`.
The command-process adapter also connects an arbitrary local executable over a
neutral JSON stdin/stdout contract.

The adapter sends the bounded system instruction, WorkItem title and summary,
acceptance criteria, response schema when enabled, and configured model id. It
does not automatically send repository files, credentials, database contents,
provider chats, or environment values.

## Offline fake engine

```powershell
node bin/chartermesh.mjs bootstrap --target TARGET --engine fake
```

Use this first. It is deterministic, free, offline, and exercises the same
WorkItem → Run → Attempt → Artifact → Approval lifecycle.

## Local OpenAI-compatible server

Start a server that exposes Chat Completions, then configure its exact base URL
and served model id:

```powershell
node bin/chartermesh.mjs configure-engine `
  --target TARGET `
  --engine openai-compatible `
  --endpoint http://127.0.0.1:8080/v1 `
  --model LOCAL_MODEL_ID `
  --structured-output prompt `
  --reasoning disabled
```

Typical local ports include:

| Runtime | Common base URL |
|---|---|
| llama.cpp server | `http://127.0.0.1:8080/v1` |
| Ollama | `http://127.0.0.1:11434/v1` |
| LM Studio | `http://127.0.0.1:1234/v1` |
| vLLM | `http://127.0.0.1:8000/v1` |

Ports and model identifiers are runtime configuration, not CharterMesh
assumptions. Confirm them in the selected runtime.

## Arbitrary local command process

Use this when a local runtime or wrapper does not expose an OpenAI-compatible
HTTP endpoint:

```powershell
node bin/chartermesh.mjs configure-engine `
  --target TARGET `
  --engine command-process `
  --command C:\absolute\path\to\engine.exe `
  --command-arg --chartermesh-json `
  --model LOCAL_MODEL_LABEL `
  --pass-env LOCAL_MODEL_HOME `
  --timeout-ms 60000
```

The executable receives one JSON document on stdin with
`apiVersion: chartermesh.dev/command-process-request/v1alpha1` and the neutral
`InferenceRequest`. It must write one JSON object to stdout containing `text`,
optional `toolCalls`, `finishReason`, and optional token/cost `usage`. The
complete `text` value still has to satisfy the managed runner's structured
artifact schema.

The no-write configuration plan calculates and stores the executable's
SHA-256. CharterMesh verifies that digest when loading the engine, immediately
before spawn, and after exit. A legitimate executable upgrade therefore
requires a new `configure-engine` plan and human approval.

CharterMesh starts the absolute executable directly with `shell: false`, uses
`.chartermesh/engine-work/ENGINE_ID` rather than the project root as cwd,
allows at most 1 MiB combined stdout/stderr, applies a timeout, and does not
inherit the whole parent environment. Repeat `--command-arg` and `--pass-env`
as needed. stderr content is not surfaced in Control Plane errors. The digest
and dedicated cwd are tamper detection and accidental-exposure reduction, not
an operating-system sandbox; the operator must trust the executable and its
explicit arguments.

## Native JSON Schema mode

By default CharterMesh requests JSON in the prompt and validates it locally:

```text
--structured-output prompt
```

Prompt mode includes the exact versioned artifact shape in every request; it
does not rely on a model inferring what "structured output" means.

If the server implements the OpenAI `response_format: json_schema` shape:

```text
--structured-output json-schema
```

The managed runner always validates locally. If output is invalid, it permits
one bounded repair turn and then marks the run failed with
`STRUCTURED_ARTIFACT_INVALID`.

## Reasoning mode

Reasoning-capable local models can spend the output budget on analysis before
emitting the required artifact. Use `--reasoning disabled` for bounded
structured work. The adapter sends `reasoning_effort: none` and
`chat_template_kwargs.enable_thinking: false`; compatible servers honor the
field they support. `default` preserves server/model behavior.

## Tool execution

`--tool-calling` advertises native OpenAI-style tool-call transport for an
endpoint that supports it. This only declares the engine capability; it does
not grant tools or bypass OrgSpec tool policy.

The built-in ManagedRunner drives a common bounded loop. It passes allowed
tool definitions to the engine, transports assistant tool calls and tool
results, and stops when the engine emits a final structured artifact. OrgSpec
enforces:

- exact tool allowlist;
- project-relative `workspaceRoots`;
- exact-call human approval for writes;
- `maxIterations` from 1 through 12.

The first built-ins list a directory, read bounded UTF-8 text, and create or
replace bounded UTF-8 text. There is no shell or network tool. Tool execution
evidence stores hashes and bounded relative paths; raw inputs and results are
not copied into the audit ledger.

## Remote provider

Set the credential in the process environment and configure only its variable
name:

```powershell
$env:CHARTERMESH_MODEL_API_KEY = "set-outside-the-repository"
node bin/chartermesh.mjs configure-engine `
  --target TARGET `
  --engine openai-compatible `
  --endpoint https://provider.example/v1 `
  --model SUPPORTED_MODEL_ID `
  --api-key-env CHARTERMESH_MODEL_API_KEY `
  --max-response-bytes 8388608
```

CharterMesh rejects sending configured credentials to non-loopback plain HTTP.
It never writes the credential value. Redirect following is disabled so an
endpoint cannot forward the request or credential to another origin. Response
bodies default to an 8 MiB ceiling and may be configured from 1 KiB through
64 MiB; oversized bodies fail before JSON parsing.

## Apply and diagnose

Every configuration command first prints a no-write plan. Repeat the identical
command with `--approve PLAN_HASH`, then:

```powershell
node bin/chartermesh.mjs doctor --target TARGET
```

`doctor` validates configuration without making a model call.
The complete runtime document is checked against
`schemas/runtime-config-v1alpha1.schema.json` before adapter-specific
validation, so malformed hand edits and dangling engine references fail
before inference.

## Cost visibility is a user policy

CharterMesh itself has no model price. The operator who chooses the engine
also chooses how unknown cost is handled in OrgSpec:

- `warn` allows a run and preserves cost as unknown;
- `block` refuses engines without known/estimated cost and later claims when
  the current month already contains unknown-cost invocations;
- `estimate` requires operator-supplied token prices.

Supply prices only when they match the selected model/account:

```text
--input-price-per-million 0.20 --output-price-per-million 0.60
```

Both values are required together. They are configuration, not CharterMesh
product pricing. Estimates cannot reserve a provider bill in advance, so
provider-side account limits remain the hard outer control.

## Protocol requirements

- HTTP or HTTPS endpoint.
- Chat Completions base URL or full `/chat/completions` URL.
- JSON request with `model`, `messages`, and `stream: false`.
- JSON response with `choices[0].message.content` or tool calls.
- Optional OpenAI-style prompt/completion token usage.
- No redirect response; the configured endpoint must answer directly.
- Response body within `maxResponseBytes` (8 MiB by default).

Token counts are retained when the endpoint returns them. Cost remains unknown
unless the process reports a measured cost or the user supplies both token
prices, in which case it is explicitly marked `estimated`.

CharterMesh records the invocation as `running` before calling the engine.
When a process is killed or a caller cancels, the same Control Plane
cancellation path closes it as `canceled`; lease recovery closes an orphan as
`abandoned`. Unknown usage or cost stays unknown rather than disappearing.
ModelEngine adapters should honor the supplied `AbortSignal`.

## Security checklist

- Prefer loopback for local engines.
- Do not expose a local engine to LAN/public networks without an explicit
  authentication, firewall, and threat review.
- Never put a key in a URL, OrgSpec, runtime file, command, prompt, issue, or
  commit.
- Run the fake-engine path before the first paid call.
- Treat WorkItem title, summary, and criteria as disclosed to the endpoint.
- Use low-privilege credentials and provider-side limits.

## Current limitations

- Text-only, non-streaming Chat Completions.
- Structured artifact generation with at most one repair turn.
- Built-in tools cover bounded workspace list/read/write only; command,
  network, package-manager, and deployment tools are not implemented.
- An approval-required call ends the current attempt; approval is followed by
  an explicit retry with a new fenced generation.
- No automatic account creation or provider discovery.
- A protocol that cannot use HTTP or the command-process JSON contract requires
  a bounded `ModelEngine` adapter and manifest; it must not add vendor fields
  to OrgSpec.
