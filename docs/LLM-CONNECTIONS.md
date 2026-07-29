# Connecting model engines

CharterMesh core does not depend on a model vendor or agent product. The first
live adapter implements OpenAI-compatible `POST /v1/chat/completions`. The
endpoint may be a local process, self-hosted service, or remote API.

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

## Tool-call transport

`--tool-calling` advertises native OpenAI-style tool-call transport for an
endpoint that supports it. This only declares the engine capability; it does
not grant tools or bypass OrgSpec tool policy. Unsupported features remain
explicitly unsupported rather than silently downgraded.

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
  --api-key-env CHARTERMESH_MODEL_API_KEY
```

CharterMesh rejects sending configured credentials to non-loopback plain HTTP.
It never writes the credential value.

## Apply and diagnose

Every configuration command first prints a no-write plan. Repeat the identical
command with `--approve PLAN_HASH`, then:

```powershell
node bin/chartermesh.mjs doctor --target TARGET
```

`doctor` validates configuration without making a model call.

## Protocol requirements

- HTTP or HTTPS endpoint.
- Chat Completions base URL or full `/chat/completions` URL.
- JSON request with `model`, `messages`, and `stream: false`.
- JSON response with `choices[0].message.content` or tool calls.
- Optional OpenAI-style prompt/completion token usage.

Usage is `measured` only when the endpoint returns token counts. Cost remains
unknown unless an adapter can report it without embedding volatile vendor
pricing in the core.

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
- Tool-call transport exists, but a general tool-execution loop is not yet
  enabled.
- No automatic account creation or provider discovery.
- A different protocol requires a bounded `ModelEngine` adapter and manifest;
  it must not add vendor fields to OrgSpec.
