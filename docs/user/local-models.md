# Local models

Run your agents on models served from your own hardware: Ollama, LM Studio,
llama.cpp's `llama-server`, vLLM, SGLang, or anything else that speaks the OpenAI
or Anthropic API. T3 Code does not run models itself. A provider such as Pi or
OpenCode talks to your inference server, and T3 Code drives that provider.

The inference server must be reachable from the environment's machine. `localhost`
means the machine running the T3 Code server, even when you are connected from a
phone or another computer.

## Choose a provider

| Provider | Configure the endpoint in                                                           | Needs                               |
| -------- | ----------------------------------------------------------------------------------- | ----------------------------------- |
| Pi       | Pi's `~/.pi/agent/models.json`                                                      | OpenAI Chat Completions             |
| OpenCode | OpenCode's `opencode.json`                                                          | OpenAI Chat Completions             |
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
it. See [Pi](./providers-pi.md). A Pi instance linked to an inference server offers Pi a lean set
of T3 tools by default; see [T3 Tools](./providers-pi.md#t3-tools).

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

## Mark the instance as local

In **Settings → Providers**, turn on **Runs local models** for each instance whose
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
