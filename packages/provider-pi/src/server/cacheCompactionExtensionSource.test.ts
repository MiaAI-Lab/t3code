import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import { assert, describe, it } from "@effect/vitest";

import {
  PI_T3_CACHE_COMPACTION_SNIPPET,
  PI_T3_COMPACTION_INSTRUCTION,
} from "./cacheCompactionExtensionSource.ts";

type Message = { readonly role: string; readonly content?: unknown };
type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

const managedModel = {
  provider: "t3-local",
  api: "openai-completions",
  id: "GLM",
  reasoning: true,
  contextWindow: 100_000,
  maxTokens: 32_768,
};

const toolCall = (name: string, path: string) => ({
  role: "assistant",
  content: [{ type: "toolCall", id: `${name}-${path}`, name, arguments: { path } }],
});
const entry = (id: string, ...messages: Message[]) => ({
  sourceEntry: { id, type: "message" },
  messages,
});
const entries = [
  entry("sys", { role: "system" }),
  entry("u1", { role: "user", content: "Build it. No new dependencies." }),
  entry("a1", toolCall("read", "src/a.ts")),
  entry("r1", { role: "toolResult" }),
  entry("a2", toolCall("edit", "src/b.ts")),
  entry("r2", { role: "toolResult" }),
  entry("u2", { role: "user", content: "Status?" }),
  entry("a3", { role: "assistant", content: [{ type: "text", text: "Halfway." }] }),
];
const transcript = entries.flatMap((current) => current.messages);

// Stands in for pi-ai's payload builder: deterministic in the context and reasoning level.
const payloadFor = (messages: ReadonlyArray<Message>, reasoning: unknown, maxTokens?: number) => ({
  model: "GLM",
  messages: messages.map(({ role, content }) => ({ role, content })),
  tools: [{ name: "read" }],
  reasoning_effort: reasoning,
  ...(maxTokens === undefined ? {} : { max_completion_tokens: maxTokens }),
});

async function compactWith(
  options: {
    readonly model?: typeof managedModel;
    readonly recorded?: unknown;
    readonly tokensBefore?: number;
    readonly reply?: ReadonlyArray<{ type: string; text?: string }>;
  } = {},
) {
  const handlers = new Map<string, Handler>();
  const source = NodeModule.stripTypeScriptTypes(PI_T3_CACHE_COMPACTION_SNIPPET);
  NodeVM.runInNewContext(`${source}\nregisterT3CacheCompaction(pi)`, {
    process: { env: { T3_GATEWAY_PROVIDER: "t3-local" } },
    pi: {
      on: (name: string, handler: Handler) => handlers.set(name, handler),
      getThinkingLevel: () => "low",
    },
    convertToLlm: (messages: ReadonlyArray<Message>) => messages,
    Date,
  });
  const model = options.model ?? managedModel;
  const recorded = "recorded" in options ? options.recorded : payloadFor(transcript, "low", 1_000);
  if (recorded !== undefined)
    await handlers.get("before_provider_request")!({ payload: recorded }, { model });

  const sent: Array<{ readonly payload: unknown; readonly maxTokens: number }> = [];
  const controller = new AbortController();
  const result = await handlers.get("session_before_compact")!(
    {
      preparation: { firstKeptEntryId: "a1", tokensBefore: options.tokensBefore ?? 40_000 },
      branchEntries: [
        { type: "compaction", details: { readFiles: ["old.ts"], modifiedFiles: ["src/a.ts"] } },
      ],
      customInstructions: "Focus on tests.",
      signal: controller.signal,
    },
    {
      model,
      sessionManager: {
        buildSessionProjection: () => ({ entries, messages: transcript }),
        getSessionId: () => "session-1",
      },
      modelRegistry: {
        streamSimple: (
          _model: unknown,
          context: { messages: ReadonlyArray<Message> },
          request: {
            reasoning?: string;
            maxTokens: number;
            onPayload: (payload: unknown) => unknown;
          },
        ) => ({
          result: async () => {
            const payload = payloadFor(context.messages, request.reasoning, request.maxTokens);
            try {
              request.onPayload(payload);
            } catch (error) {
              return { stopReason: "error", content: [], errorMessage: String(error) };
            }
            sent.push({ payload, maxTokens: request.maxTokens });
            return {
              stopReason: "stop",
              content: options.reply ?? [
                { type: "thinking", text: "hmm" },
                { type: "text", text: "## Goal\nShip it." },
              ],
              usage: { cacheRead: 39_936 },
            };
          },
        }),
      },
    },
  );
  return { result: result as { compaction: Record<string, unknown> } | undefined, sent };
}

describe("Pi prefix-reusing compaction", () => {
  it("sends the last request plus one instruction and keeps the latest turns", async () => {
    const { result, sent } = await compactWith();
    assert.equal(sent.length, 1);
    const payload = sent[0]!.payload as ReturnType<typeof payloadFor>;
    assert.deepEqual(payload.messages.slice(0, -1), payloadFor(transcript, "low").messages);
    assert.deepEqual(payload.messages.at(-1), {
      role: "user",
      content: [
        {
          type: "text",
          text: `${PI_T3_COMPACTION_INSTRUCTION}\n\nAdditional focus: Focus on tests.`,
        },
      ],
    });
    assert.equal(payload.reasoning_effort, "low");
    assert.isAtLeast(sent[0]!.maxTokens, 8_192);
    // Two turns: the edit and its result, then the status prompt with its answer.
    assert.equal(result?.compaction.firstKeptEntryId, "a2");
    assert.deepEqual(result?.compaction.details, {
      readFiles: ["old.ts"],
      modifiedFiles: ["src/a.ts"],
    });
    assert.equal(
      result?.compaction.summary,
      "## Goal\nShip it.\n\n<read-files>\nold.ts\n</read-files>\n\n<modified-files>\nsrc/a.ts\n</modified-files>",
    );
    assert.deepEqual(result?.compaction.usage, { cacheRead: 39_936 });
  });

  it.each([
    {
      name: "another provider's model",
      options: { model: { ...managedModel, provider: "openrouter" } },
      sends: false,
    },
    { name: "no request recorded in this process", options: { recorded: undefined }, sends: false },
    {
      name: "a rendered request that does not extend the recorded one",
      options: { recorded: payloadFor(transcript.slice(0, 3), "high") },
      sends: false,
    },
    { name: "too little room for the summary", options: { tokensBefore: 95_000 }, sends: false },
    {
      name: "a summary that calls a tool",
      options: { reply: [{ type: "toolCall" }] },
      sends: true,
    },
  ])("leaves $name to Pi's compaction", async ({ options, sends }) => {
    const { result, sent } = await compactWith(options);
    assert.isUndefined(result);
    assert.equal(sent.length, sends ? 1 : 0);
  });
});
