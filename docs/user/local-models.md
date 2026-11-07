# Local models

Run your agents on models served from your own hardware: Ollama, LM Studio,
llama.cpp's `llama-server`, vLLM, SGLang, or anything else that speaks the OpenAI
or Anthropic API. T3 Code does not run models itself. A provider such as Pi or
OpenCode talks to your inference server, and T3 Code drives that provider.

The inference server must be reachable from the environment's machine. `localhost`
means the machine running the T3 Code server, even when you are connected from a
phone or another computer.

## Register your inference servers

Open **Settings → Inference** and add each model server with **Add server**: its **Base URL**
(such as `http://localhost:11434/v1`), an optional name and API key, and optionally **Max
concurrent requests**. T3 Code checks each server and shows whether it is ready, the models it
serves with their context windows, and its current load when the server reports one. **Refresh**
checks again.

Each server also shows when it was last checked, marked overdue when checks have stopped, whether
it reports cached prompt tokens, and the last request through T3 Code that failed or was rejected
in the past hour. Cached tokens show as `unknown` until a request in the last day comes back with a
cached count, so a server that never reports one cannot show its cache reuse anywhere.

A server can name another as its **Fallback server**. When the first cannot take a request before
it is sent, for example because it is down, T3 Code's gateway sends the request to the fallback if
it serves the same model. A request that already started is never moved.

Then link a provider instance to a server with the **Inference server** setting on its card in
**Settings → Providers**. A linked instance counts as local while its server is enabled, and the
model picker shows the server's name and readiness next to the provider, such as `Pi · rtx ·
Ready`. T3 Code also caps the context window it assumes for the instance at what the server
actually serves. Changing the link, or a server's URL, key or enabled switch, applies to sessions
that start afterwards; a running session stays on the server and URL it started with until it ends.

### Pi on a registered server

A Pi instance linked to a server needs no `models.json` entry. T3 Code registers the server in Pi
as `t3-<server>` with every model the server reports, sized from what the server advertises, so
pick a model such as `t3-rtx/your-model-id` in the model picker. These requests go through T3
Code's gateway, which:

- sends at most **Max concurrent requests** to the server at once and queues the rest, so
  parallel threads take turns instead of overloading the GPU. Chat requests go ahead of
  background writing, and a background request that has waited 30 seconds is treated as chat so
  none waits forever. A waiting thread shows `Waiting for <server> · 2 ahead`. A request still
  queued after 10 minutes, or one arriving when 64 are already queued for that server, fails.
- records each request's prompt, cached prompt and output tokens, queue wait, time to first token
  and decode speed, without the prompt or response text. Records are kept for 30 days.

Linked Pi instances also offer Pi a lean set of T3 tools by default; see
[T3 Tools](./providers-pi.md#t3-tools). They also compact long threads from the server's prompt
cache; see [Compaction on Linked Servers](./providers-pi.md#compaction-on-linked-servers).

### See what your hardware did

The **Local compute** section of **Usage → Cost** and **Usage → Tokens** totals those records by server, model and purpose (chat or background
writing) for the last day or week: requests, failures, tokens, the share of the prompt served
from cache, and median and 95th percentile queue wait, time to first token and decode speed. The
cached share counts only requests whose server reported cache use, and shows `–` when none did.
Usage opens on **Tokens** when you have an enabled inference server, until you pick a tab
yourself. Local models show **Local** instead of a price, even when a cloud API sells a model with
the same name, and never add to the cost total. Set a price for one in Usage to see an estimated
equivalent API spend on its row.

In a thread, the details panel's **Last request** row shows the most recent request's prompt
size, cached share and time to first token. Its tooltip names the server that answered,
including when a fallback did, and notes when the instructions or tools changed or a different
server answered than for the previous request. Compare those notes with the cached share when a
request starts slowly.

## Choose a provider

| Provider | Configure the endpoint in                                                           | Needs                               |
| -------- | ----------------------------------------------------------------------------------- | ----------------------------------- |
| Pi       | Pi's `~/.pi/agent/models.json`                                                      | OpenAI Chat Completions             |
| OpenCode | OpenCode's `opencode.json`, or a link to a registered server                        | OpenAI Chat Completions             |
| Claude   | The instance's **Environment variables** in T3 Code                                 | Anthropic Messages (`/v1/messages`) |
| Codex    | Codex's `config.toml`, with the instance's setup set to use your existing Codex CLI | OpenAI Responses (`/v1/responses`)  |

Pi and OpenCode work with the widest range of servers. Use the model's exact ID
as your server reports it at `/v1/models`, and give the provider the context
window you actually deployed so long threads compact in time.

### Pi

Add your server as a provider in `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "local": {
      "name": "Local",
      "baseUrl": "http://localhost:8080/v1",
      "api": "openai-completions",
      "apiKey": "local",
      "models": [{ "id": "your-model-id", "contextWindow": 131072, "maxTokens": 32768 }]
    }
  }
}
```

Set it as Pi's default with `defaultProvider` and `defaultModel` in
`~/.pi/agent/settings.json`, enable Pi in **Settings → Providers**, and refresh
it. See [Pi](./providers-pi.md). To skip this file, register the server in **Settings →
Inference** and link the Pi instance to it instead; see
[Pi on a registered server](#pi-on-a-registered-server).

### OpenCode

Add an OpenAI-compatible provider to `opencode.json`:

```json
{
  "provider": {
    "local": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Local",
      "options": { "baseURL": "http://localhost:8080/v1" },
      "models": { "your-model-id": { "limit": { "context": 131072, "output": 32768 } } }
    }
  }
}
```

OpenCode's **Server URL** setting in T3 Code is for an OpenCode server, not your
inference server. Leave it empty. See [OpenCode](./providers-opencode.md).

To skip this file, register the server in **Settings → Inference** and link the OpenCode
instance to it. T3 Code then adds the server to OpenCode as `t3-<server>` with every model it
reports, sized from what the server advertises, and sends its requests through the gateway, like
[Pi on a registered server](#pi-on-a-registered-server). Pick a model such as
`t3-rtx/your-model-id`. Requests from OpenCode 2 are counted per instance, not per thread, because
one OpenCode server runs all of the instance's threads. This needs the server to serve OpenAI Chat
Completions, and does not apply when **Server URL** points at an OpenCode server you run yourself;
the provider's status says when the link is not used and why.

### Claude

Add a Claude instance with its own config directory, then set these
**Environment variables** on it:

| Variable               | Value                                               |
| ---------------------- | --------------------------------------------------- |
| `ANTHROPIC_BASE_URL`   | Your server's root, such as `http://localhost:8080` |
| `ANTHROPIC_AUTH_TOKEN` | Any value your server accepts                       |
| `ANTHROPIC_API_KEY`    | An explicitly empty value                           |

Add your model's ID with **Add custom model** and select it in the chat model
picker. The built-in Claude models stay listed but your server will not serve
them. See [Claude](./providers-claude.md#other-routers).

### Codex

Codex needs a server with the Responses API. Define it in Codex's `config.toml`:

```toml
model = "your-model-id"
model_provider = "local"

[model_providers.local]
name = "Local"
base_url = "http://localhost:8080/v1"
wire_api = "responses"
```

Use a Codex instance set up with your existing Codex CLI, not a ChatGPT
connection: a ChatGPT connection always uses OpenAI. To keep your main Codex
config on the cloud, put the same settings in the instance's launch arguments
instead, such as `-c model_provider="ollama" -c model="your-model-id"` for
Codex's built-in Ollama or `lmstudio` providers. Use `-c` overrides rather than
`--oss`: chat runs `codex app-server`, which accepts only `-c`.

Linking a Codex instance to a registered server that serves the Responses API does this for you,
and is **experimental**. T3 Code starts Codex with a `t3-<server>` provider that goes through the
gateway, the model picker offers only that server's models, and Codex's multi-agent and web search
tools are turned off. Codex sends T3 Code's own tools as a tool group that some servers reject
("function tools only"); on such a server, threads fail until it accepts them.

## Mark the instance as local

An instance linked to an enabled inference server already counts as local. For any other
instance, in **Settings → Providers**, turn on **Runs local models** for each instance whose
models all run on hardware you control. Leave it off for an instance that mixes
local and cloud models, and split those into separate instances instead.

Marked instances:

- come first in the model picker and in provider lists;
- become the default for new threads when no default model is set;
- write thread titles, commit messages, pull request text, branch names, and voice
  transcript cleanup, until you choose a text generation model yourself. Resetting
  that setting goes back to the local model.

## Background writing fallback

**Settings → Threads → Text generation fallback** decides where background writing
goes when its model cannot run:

- **Local models only** (default): another ready local instance, or an error. Your
  diffs and messages never move to a cloud provider on their own.
- **Any provider**: local instances first, then any signed-in provider.
- **Don't fall back**: report the error.

The fallback never replaces a model you selected that is working. Until you mark
an instance as local, **Local models only** behaves like **Any provider**.

Pull request review guides need an agent that can investigate the checkout, which
means Codex or Claude. To keep them local, point a Claude instance at your server
and mark it local.

## Voice input

Dictation already runs on your own machine. See [Voice input](./voice-input.md).
