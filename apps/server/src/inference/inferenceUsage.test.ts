import { describe, expect, it } from "@effect/vitest";

import { makeUsageMeter, type InferenceApi } from "./inferenceUsage.ts";

const encoder = new TextEncoder();
const sse = (events: ReadonlyArray<unknown>) =>
  events
    .map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`)
    .join("");

/** Feeds text in `size`-byte pieces so events straddle chunk boundaries; returns the chunk index of first content. */
function meter(api: InferenceApi, streaming: boolean, text: string, size = 7) {
  const usage = makeUsageMeter(api, streaming);
  const bytes = encoder.encode(text);
  let firstContentAt: number | undefined;
  for (let offset = 0, index = 0; offset < bytes.length; offset += size, index += 1) {
    if (usage.push(bytes.subarray(offset, offset + size)) && firstContentAt === undefined) {
      firstContentAt = index;
    }
  }
  const finished = usage.finished();
  return {
    usage: usage.finish(),
    firstContentAt,
    finished,
    chunks: Math.ceil(bytes.length / size),
  };
}

describe("makeUsageMeter", () => {
  it("reads the final OpenAI chat usage chunk and spots the first content delta", () => {
    const text = sse([
      { choices: [{ delta: { role: "assistant" } }] },
      { choices: [{ delta: { reasoning_content: "hm" } }] },
      { choices: [{ delta: { content: "Hi" } }] },
      {
        choices: [],
        usage: {
          prompt_tokens: 15,
          completion_tokens: 13,
          prompt_tokens_details: { cached_tokens: 4 },
        },
      },
      "[DONE]",
    ]);
    const result = meter("chat-completions", true, text);
    expect(result.usage).toEqual({ promptTokens: 15, cachedPromptTokens: 4, completionTokens: 13 });
    const roleOnly = encoder.encode(sse([{ choices: [{ delta: { role: "assistant" } }] }])).length;
    expect(result.firstContentAt).toBeGreaterThanOrEqual(Math.floor(roleOnly / 7));
    expect(result.firstContentAt).toBeLessThan(result.chunks);
  });

  it("reads OpenAI Responses usage from response.completed", () => {
    const text = sse([
      { type: "response.created", response: {} },
      { type: "response.output_text.delta", delta: "Hi" },
      {
        type: "response.completed",
        response: {
          usage: {
            input_tokens: 30,
            output_tokens: 5,
            input_tokens_details: { cached_tokens: 10 },
          },
        },
      },
    ]);
    const result = meter("responses", true, text);
    expect(result.usage).toEqual({ promptTokens: 30, cachedPromptTokens: 10, completionTokens: 5 });
    expect(result.firstContentAt).toBeDefined();
  });

  it("totals Anthropic message_start input with cache reads and takes output from message_delta", () => {
    const text = sse([
      {
        type: "message_start",
        message: {
          usage: {
            input_tokens: 20,
            cache_read_input_tokens: 100,
            cache_creation_input_tokens: 5,
            output_tokens: 1,
          },
        },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 12 } },
      { type: "message_stop" },
    ]);
    expect(meter("messages", true, text).usage).toEqual({
      promptTokens: 125,
      cachedPromptTokens: 100,
      completionTokens: 12,
    });
  });

  it.each([
    [
      "chat-completions",
      { usage: { prompt_tokens: 9, completion_tokens: 3 } },
      { promptTokens: 9, cachedPromptTokens: null, completionTokens: 3 },
    ],
    [
      "responses",
      { usage: { input_tokens: 9, output_tokens: 3, input_tokens_details: { cached_tokens: 0 } } },
      { promptTokens: 9, cachedPromptTokens: 0, completionTokens: 3 },
    ],
    [
      "messages",
      { usage: { input_tokens: 9, output_tokens: 3 } },
      { promptTokens: 9, cachedPromptTokens: null, completionTokens: 3 },
    ],
  ] as const)("reads non-streaming %s usage", (api, body, expected) => {
    const result = meter(api, false, JSON.stringify(body));
    expect(result.usage).toEqual(expected);
    expect(result.firstContentAt).toBeUndefined();
  });

  // Clients close the connection once they read the terminal event, before upstream ends.
  it.each([
    ["chat-completions", sse([{ choices: [{ delta: { content: "Hi" } }] }, "[DONE]"])],
    ["chat-completions", sse([{ choices: [{ delta: { content: "Hi" }, finish_reason: "stop" }] }])],
    [
      "responses",
      sse([
        { type: "response.output_text.delta", delta: "Hi" },
        { type: "response.completed", response: {} },
      ]),
    ],
    [
      "messages",
      sse([{ type: "content_block_delta", delta: { text: "Hi" } }, { type: "message_stop" }]),
    ],
  ] as const)("knows a %s stream reached its terminal event", (api, text) => {
    expect(meter(api, true, text).finished).toBe(true);
  });

  it("does not treat a stream cut before its terminal event as finished", () => {
    expect(
      meter("chat-completions", true, sse([{ choices: [{ delta: { content: "Hi" } }] }])).finished,
    ).toBe(false);
    expect(
      meter("messages", true, sse([{ type: "content_block_delta", delta: { text: "Hi" } }]))
        .finished,
    ).toBe(false);
  });

  it("reports unknown usage instead of failing on missing or malformed data", () => {
    const empty = { promptTokens: null, cachedPromptTokens: null, completionTokens: null };
    expect(meter("chat-completions", true, sse([{ choices: [] }, "[DONE]"])).usage).toEqual(empty);
    expect(meter("chat-completions", true, "data: {not json\n\n").usage).toEqual(empty);
    expect(meter("messages", false, "<html>bad gateway</html>").usage).toEqual(empty);
    expect(
      meter(
        "chat-completions",
        true,
        sse([{ usage: { prompt_tokens: -1, completion_tokens: "x" } }]),
      ).usage,
    ).toEqual(empty);
  });

  it("drops an oversized line or body without holding it", () => {
    const huge = "x".repeat(3 * 1024 * 1024);
    const text = `data: {"pad":"${huge}"}\n\n${sse([{ choices: [], usage: { prompt_tokens: 1, completion_tokens: 2 } }])}`;
    expect(meter("chat-completions", true, text, 64 * 1024).usage).toEqual({
      promptTokens: 1,
      cachedPromptTokens: null,
      completionTokens: 2,
    });
    const body = JSON.stringify({ pad: huge + huge + huge, usage: { prompt_tokens: 1 } });
    expect(meter("chat-completions", false, body, 64 * 1024).usage.promptTokens).toBeNull();
  });
});
