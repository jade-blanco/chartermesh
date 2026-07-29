# Connecting model engines

CharterMesh core does not depend on a model vendor or an agent product. The
first live adapter implements the OpenAI-compatible
`POST /v1/chat/completions` shape; the endpoint may be a local process, a
self-hosted service, or a remote API.

The adapter sends:

- a system instruction describing the bounded artifact task;
- the WorkItem title and summary;
- acceptance criteria;
- the configured model id.

It does not automatically send the target repository, arbitrary files,
credentials, database contents, prior provider chats, or environment values.

## Offline fake engine

Use this first:

```powershell
node bin/chartermesh.mjs bootstrap --target TARGET --engine fake
```

It is deterministic, free, offline, and exercises the same
WorkItem → Run → Attempt → Artifact → Approval lifecycle.

## Ollama

Ollama documents an OpenAI-compatible Chat Completions endpoint at
`http://localhost:11434/v1/chat/completions`. Pull and serve a model using
Ollama, then configure the base URL:

```powershell
node bin/chartermesh.mjs configure-engine `
  --target TARGET `
  --engine openai-compatible `
  --endpoint http://127.0.0.1:11434/v1 `
  --model YOUR_OLLAMA_MODEL
```

The current CharterMesh adapter does not require a placeholder key for an
unauthenticated local server.

Official reference:
[Ollama OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility).

## LM Studio

Start the local API server from LM Studio's Developer page or with
`lms server start`, load a model, and configure its exact served identifier:

```powershell
node bin/chartermesh.mjs configure-engine `
  --target TARGET `
  --engine openai-compatible `
  --endpoint http://127.0.0.1:1234/v1 `
  --model YOUR_LM_STUDIO_MODEL
```

LM Studio documents port `1234` as its default and exposes
`/v1/chat/completions`. If you enable LM Studio API authentication, set the
token in your shell and name that variable with `--api-key-env`.

Official references:
[local server](https://lmstudio.ai/docs/developer/core/server),
[OpenAI-compatible endpoints](https://lmstudio.ai/docs/developer/openai-compat).

## vLLM

Start vLLM with a chat-capable model and, preferably, an API key. The default
examples use port `8000`:

```powershell
$env:CHARTERMESH_VLLM_API_KEY = "set-outside-the-repository"
node bin/chartermesh.mjs configure-engine `
  --target TARGET `
  --engine openai-compatible `
  --endpoint http://127.0.0.1:8000/v1 `
  --model YOUR_VLLM_MODEL `
  --api-key-env CHARTERMESH_VLLM_API_KEY
```

The selected model must have a compatible chat template or vLLM will reject
Chat Completions.

Official reference:
[vLLM OpenAI-compatible server](https://docs.vllm.ai/en/latest/serving/openai_compatible_server/).

## Remote OpenAI-compatible provider

Set the credential only in the process environment:

```powershell
$env:CHARTERMESH_MODEL_API_KEY = "set-outside-the-repository"
node bin/chartermesh.mjs configure-engine `
  --target TARGET `
  --engine openai-compatible `
  --endpoint https://api.openai.com/v1 `
  --model YOUR_SUPPORTED_CHAT_MODEL `
  --api-key-env CHARTERMESH_MODEL_API_KEY
```

Use the model id supported by the endpoint at the time you configure it.
CharterMesh does not pin a vendor's changing default model in OrgSpec.

## Apply and diagnose

Every command above only previews a runtime-file plan. Repeat the identical
command with the printed `--approve PLAN_HASH`, then run:

```powershell
node bin/chartermesh.mjs doctor --target TARGET
```

`runtime.json` contains the endpoint, model id, timeout, and credential
environment-variable name. It never contains the credential value.

## Protocol requirements

The pre-alpha adapter expects:

- HTTP or HTTPS endpoint;
- `POST /v1/chat/completions` or a base URL to which that path can be appended;
- JSON request with `model`, `messages`, and `stream: false`;
- JSON response with `choices[0].message.content`;
- optional OpenAI-style `usage.prompt_tokens` and `usage.completion_tokens`.

Usage is recorded as `measured` only when the endpoint returns token counts;
otherwise it is `unknown`. Cost is unknown in this slice because vendor price
tables do not belong in the core adapter.

## Security checklist

- Prefer loopback for local engines.
- Do not bind a local engine to a LAN or the public internet without
  authentication, firewall rules, and an explicit threat review.
- Never put a key in an endpoint URL, OrgSpec, `runtime.json`, command history,
  prompt, issue, or commit.
- Run the fake-engine smoke test before the first paid call.
- Treat the WorkItem title, summary, and acceptance criteria as data disclosed
  to the configured endpoint.
- Use a dedicated low-privilege credential and provider-side spending limits.

## Current limitations

- Text-only, one model turn per run.
- Non-streaming Chat Completions only.
- No automatic provider discovery or account creation.
- No provider-hosted tools, files, web search, or MCP calls.
- A protocol that does not match this contract needs a bounded
  `ModelEngine` adapter and capability manifest; it must not add vendor fields
  to OrgSpec core.
