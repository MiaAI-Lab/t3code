# MIA changelog

What this fork ([MiaAI-Lab/t3code](https://github.com/MiaAI-Lab/t3code), branch `local-first`)
changes on top of upstream [T3 Code](https://github.com/pingdotgg/t3code). It is based on upstream
`b90e554e0` (2026-11-06). Newest first. Every change to the client–server protocol is additive, so
the official T3 Code mobile app keeps working against this fork's server.

## 2026-11-07, night: remote machines

### Added

- **SSH machines run this fork's server.** Machines added over SSH used to download upstream's
  release server, which has no inference servers, so **Add server** did nothing there. The desktop
  app now carries its own server for linux-x64 and linux-arm64 (DGX Spark) under a fork version
  (`0.1.7-mia.<commit time>.g<hash>`), uploads the right one over the existing SSH login when a
  machine lacks it, and the machine installs that upload instead of downloading. A new version
  replaces the server the app launched there the next time it connects. Build the archives with
  `scripts/mia-build-remote-runtime.sh [arm64-host]` before `vp run dist:desktop:linux`.
- **Add project dialog.** One window in two steps: pick a machine (this computer, connected
  machines, or a host from `~/.ssh/config`, which connects it), then click through its folders or
  type a path and press **Add project**. It opens from **Add project…** at the bottom of the New
  thread list, **Ctrl+K → Add project**, and the sidebar. Cloning and empty projects moved to
  **Ctrl+K → Clone repository** and the dialog's **Clone or create new…**.
- **Add a server from another machine.** Settings → Inference on one machine lists the servers
  registered on your other connected machines with **Add here**, prefilled with the address this
  machine would use (`localhost` becomes the other machine's name). Keys are entered again.
- Settings → Inference says when a machine's server has no inference servers, instead of an
  **Add server** button that does nothing.

### Changed

- `T3CODE_CLI_SYSTEM_LIBATOMIC=1` builds a server archive without bundling libatomic, for hosts
  that have it installed (no patchelf needed).

## 2026-11-07, evening: local-model polish

### Added

- **Images for local models.** **Check images** on **Settings → Inference** asks a model to name
  the colour of four random test images (64 answer tokens each, 2 minutes at most, through the
  normal request queue) and marks it **Reads images** or **Text only**. A busy server or reasoning
  that runs out of room counts as "could not tell", never as text-only. Results are kept per server
  address and model across restarts, and the button returns a day later in case the weights changed.
- **Vision reported by the engine.** llama.cpp (`/props`), LM Studio (`/api/v0/models`) and Ollama
  (`/api/show`) say whether a model reads images, so those models are marked without a check.
- **Images reach the model.** Pi and OpenCode declare image input for a linked model unless it is
  known to read text only. Attaching an image to an unchecked model starts the check on its own, and
  the message box warns when a model will not see the image.
- **Runaway-reply watchdog.** T3's gateway stops a streamed local reply that repeats the same text
  (a 64–1024 character unit at least 8 times over 4 KB, seen twice), reasons for 128 KB without an
  answer or tool call, or sends nothing for 5 minutes before its first token (including a server
  that holds back its headers) or 2 minutes after. The harness gets the protocol's error event, the
  server's slot is freed, an immediate retry of the same run is refused for a minute, and the thread
  shows why with **Continue** and **Choose model**. Opt out per server with `watchdog.enabled: false`.
- **No longer served.** When a ready server stops listing the model a thread or the default uses,
  the message box says so and offers what it serves now.
- **Use a local model.** One step from first run, the model picker, the command palette or
  **Settings → Inference**: finds model servers on this machine (well-known ports and listening
  sockets, no keys sent), links an agent (Pi, then OpenCode, then Codex) and makes the model the
  default for new threads. Running it again reuses what it set up.
- **Repair a server.** When a server stops answering, **Find server** looks on its machine for where
  it moved and moves it there, keeping its name, key and linked agents; **Change address** edits it
  by hand. A thread whose agent depends on it says so above the message box.
- **The picker says where a model runs.** A local model shows its machine and server.
- **Sidebar thread cards** read title first, with one quiet line for a short project name, the
  branch when it is not the default, the pull request and the diff. Provider icons show only when
  threads use more than one.
- **Settled** collapses to one line, opens to the five most recent threads, and shows
  **Un-settle** on hover.

### Changed

- **Local models only** is strict: background writing never goes to the cloud, even before any
  local model is set up.
- A Codex instance linked to a server waits for it instead of falling back to the OpenAI login, and
  a removed or not-ready server is not a reason to use the cloud. Only turning the server off is.

### Reverted

- The settings restructure (nine destinations, a Models page, plain renames such as "Computers"
  and "Model servers") and the rename of **Settled** to "Done". Settings and thread states keep
  T3 Code's own pages and names so they match the mobile app. Local-model features live on
  **Settings → Inference**.

### Fixed (from Codex and GLM reviews)

- A streamed refusal counted as a tool call and switched off the reasoning limit.
- An idle tick landing as a reply ended could record a stop that never happened.
- Two image checks finishing together could save their results out of order.

## 2026-11-07, afternoon: appearance

- **Dark** is two-tone: gray sidebar and panels over a near-black main area. The original true-black
  dark is kept as **OLED**.
- The README covers only what this fork adds, with screenshots, and credits upstream.

## 2026-11-07, morning: local inference at the core

### Round 6: mobile and evals

- The mobile app shows Settings → Inference, Local compute and a thread's last request, read-only.
- `evals/mcp-tool-use` runs a local model through Pi, Codex and OpenCode side by side (`--harness`).
- Merged tool schemas say which fields each variant requires.

### Round 5: cache health

- Settings → Inference shows a TensorFold server's prompt cache health.
- A fallback server takes requests only while its server is down.

### Round 4: health and attribution

- Each server shows probe freshness, whether it reports cached tokens, and recent failures.
- Shared OpenCode gateway requests are counted per thread.
- Linked Pi compacts long threads from the server's prompt cache.
- Relinking a server applies to new sessions; running ones keep their route.
- Managed Codex gets a model catalog for the served models; an idle shared OpenCode restarts when its
  route changes.

### Round 3: fallback and more harnesses

- A server can name a fallback server; requests record cache observations, the parent run, the
  fallback origin and a static-prefix fingerprint.
- OpenCode and (experimentally) Codex use a linked server through T3's gateway; Responses namespace
  tools are flattened for servers that accept only plain function tools.
- Usage opens on Tokens when local inference is set up, and local runs are never priced as cloud
  spend.
- Relay connection traces are opt-in.

### Round 2: inference servers and the gateway

- **Settings → Inference** registers model servers, probes their models, context windows and load,
  and keeps API keys in the secret store.
- Provider instances link to a server and count as local while it is enabled; handoff budgets use
  the served context window.
- T3's inference gateway queues requests per server (chat before background writing), records
  tokens, queue wait, time to first token and decode speed (never the text), and shows a waiting
  thread its place in the queue.
- **Usage → Local compute** and the thread details' **Last request**.
- Linked Pi gets a managed `t3-<server>` provider and a lean T3 tool set (about 40% fewer prompt
  tokens with the same eval results on GLM).

### Round 1: local first

- Provider instances can be marked local; local instances come first and new threads default to them.
- Background writing (titles, commit messages, PR text, branch names, voice cleanup) prefers local
  models, with **Text generation fallback** defaulting to **Local models only**.
- Codex text generation keeps local launch arguments; handoffs fit small local context windows.
- Product analytics are opt-in.
