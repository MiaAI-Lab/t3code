/** Wire protocols the gateway forwards. */
export type InferenceApi = "chat-completions" | "completions" | "responses" | "messages";

export interface InferenceUsage {
  /** Every prompt token, cached ones included. */
  readonly promptTokens: number | null;
  readonly cachedPromptTokens: number | null;
  readonly completionTokens: number | null;
}

export interface UsageMeter {
  /** Returns true when this chunk carried the response's first generated content. */
  readonly push: (chunk: Uint8Array) => boolean;
  /** Whether a stream reached its protocol's terminal event; clients may disconnect right after it. */
  readonly finished: () => boolean;
  readonly finish: () => InferenceUsage;
}

// Accounting never holds more than this per SSE line or per non-streaming body.
const MAX_LINE_CHARS = 2 * 1024 * 1024;
const MAX_BODY_CHARS = 4 * 1024 * 1024;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;

const field = (value: unknown, ...path: ReadonlyArray<string>): unknown => {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
};

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const nonEmpty = (value: unknown) =>
  (typeof value === "string" && value.length > 0) || (Array.isArray(value) && value.length > 0);

interface Tally {
  prompt?: number;
  cached?: number;
  completion?: number;
  terminal?: boolean;
}

/** OpenAI chat and legacy completions. */
function readOpenAiUsage(usage: unknown, tally: Tally) {
  if (!isRecord(usage)) return;
  const prompt = count(usage.prompt_tokens);
  const completion = count(usage.completion_tokens);
  if (prompt !== undefined) tally.prompt = prompt;
  if (completion !== undefined) tally.completion = completion;
  const cached = count(field(usage, "prompt_tokens_details", "cached_tokens"));
  if (cached !== undefined) tally.cached = cached;
}

function readResponsesUsage(usage: unknown, tally: Tally) {
  if (!isRecord(usage)) return;
  const prompt = count(usage.input_tokens);
  const completion = count(usage.output_tokens);
  if (prompt !== undefined) tally.prompt = prompt;
  if (completion !== undefined) tally.completion = completion;
  const cached = count(field(usage, "input_tokens_details", "cached_tokens"));
  if (cached !== undefined) tally.cached = cached;
}

/** Anthropic's input_tokens excludes cache reads and writes; the prompt is their sum. */
function readAnthropicUsage(usage: unknown, tally: Tally) {
  if (!isRecord(usage)) return;
  const input = count(usage.input_tokens);
  const read = count(usage.cache_read_input_tokens);
  const written = count(usage.cache_creation_input_tokens);
  if (input !== undefined) tally.prompt = input + (read ?? 0) + (written ?? 0);
  if (read !== undefined) tally.cached = read;
  const completion = count(usage.output_tokens);
  if (completion !== undefined) tally.completion = completion;
}

/** Reads one streamed event; returns true when it carries generated content. */
function readEvent(api: InferenceApi, event: unknown, tally: Tally): boolean {
  if (!isRecord(event)) return false;
  switch (api) {
    case "chat-completions":
    case "completions": {
      if (event.usage !== undefined && event.usage !== null) readOpenAiUsage(event.usage, tally);
      const choices = Array.isArray(event.choices) ? event.choices : [];
      if (choices.some((choice) => typeof field(choice, "finish_reason") === "string")) {
        tally.terminal = true;
      }
      return choices.some((choice) => {
        if (api === "completions") return nonEmpty(field(choice, "text"));
        const delta = field(choice, "delta");
        return (
          nonEmpty(field(delta, "content")) ||
          nonEmpty(field(delta, "reasoning_content")) ||
          nonEmpty(field(delta, "reasoning")) ||
          nonEmpty(field(delta, "tool_calls"))
        );
      });
    }
    case "responses": {
      const type = typeof event.type === "string" ? event.type : "";
      if (
        type === "response.completed" ||
        type === "response.incomplete" ||
        type === "response.failed"
      ) {
        readResponsesUsage(field(event, "response", "usage"), tally);
        tally.terminal = true;
      }
      return type.endsWith(".delta") && nonEmpty(event.delta);
    }
    case "messages": {
      if (event.type === "message_start")
        readAnthropicUsage(field(event, "message", "usage"), tally);
      if (event.type === "message_delta") {
        // Cumulative output; message_start already carried the prompt.
        const completion = count(field(event, "usage", "output_tokens"));
        if (completion !== undefined) tally.completion = completion;
      }
      if (event.type === "message_stop") tally.terminal = true;
      return event.type === "content_block_delta";
    }
  }
}

function readBody(api: InferenceApi, body: unknown, tally: Tally) {
  const usage = field(body, "usage");
  if (api === "responses") readResponsesUsage(usage, tally);
  else if (api === "messages") readAnthropicUsage(usage, tally);
  else readOpenAiUsage(usage, tally);
}

/**
 * Tees a response body into usage counts. Never throws: anything it cannot read reports as
 * unknown (null), and an oversized line or body is dropped rather than buffered.
 */
export function makeUsageMeter(api: InferenceApi, streaming: boolean): UsageMeter {
  const decoder = new TextDecoder();
  const tally: Tally = {};
  let pending = "";
  let skippingLine = false;
  let bodyTooLarge = false;
  let sawContent = false;

  const readLine = (line: string): boolean => {
    if (!line.startsWith("data:")) return false;
    const data = line.slice(5).trim();
    if (data === "[DONE]") tally.terminal = true;
    if (data === "" || data === "[DONE]") return false;
    return readEvent(api, parseJson(data), tally);
  };

  const push = (chunk: Uint8Array): boolean => {
    const text = decoder.decode(chunk, { stream: true });
    if (!streaming) {
      if (bodyTooLarge) return false;
      if (pending.length + text.length > MAX_BODY_CHARS) {
        bodyTooLarge = true;
        pending = "";
      } else {
        pending += text;
      }
      return false;
    }
    let content = false;
    let start = 0;
    for (let newline = text.indexOf("\n"); newline !== -1; newline = text.indexOf("\n", start)) {
      const piece = text.slice(start, newline);
      start = newline + 1;
      if (skippingLine) {
        skippingLine = false;
        pending = "";
        continue;
      }
      const line = (pending + piece).replace(/\r$/, "");
      pending = "";
      if (readLine(line)) content = true;
    }
    if (!skippingLine) {
      pending += text.slice(start);
      if (pending.length > MAX_LINE_CHARS) {
        skippingLine = true;
        pending = "";
      }
    }
    if (content && !sawContent) {
      sawContent = true;
      return true;
    }
    return false;
  };

  const finish = (): InferenceUsage => {
    const rest = decoder.decode();
    if (streaming) {
      if (!skippingLine) readLine((pending + rest).trim());
    } else if (!bodyTooLarge && pending.length + rest.length <= MAX_BODY_CHARS) {
      readBody(api, parseJson(pending + rest), tally);
    }
    pending = "";
    return {
      promptTokens: tally.prompt ?? null,
      cachedPromptTokens: tally.cached ?? null,
      completionTokens: tally.completion ?? null,
    };
  };

  return { push, finished: () => tally.terminal === true, finish };
}
