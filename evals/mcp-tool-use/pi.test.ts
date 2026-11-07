import { assert, it } from "@effect/vitest";
import { T3_CODE_ORCHESTRATION_INSTRUCTIONS } from "@t3tools/provider-core/server/orchestrationInstructions";

import { chatMessages, fromChatCompletion, piParameters, piSystemPrompt } from "./pi.ts";
import { normalizeToolName } from "./run.ts";

it("replays a transcript in Pi's chat shape, with Claude-shaped prior file calls converted", () => {
  const messages = chatMessages([
    { role: "user", content: [{ type: "text", text: "Fix it." }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Look first.", field: "reasoning_content" },
        { type: "text", text: "Reading." },
        { type: "tool_use", id: "c1", name: "read", input: { file_path: "/a.ts" } },
        { type: "tool_use", id: "c2", name: "mcp__t3-code__task_status", input: { taskId: "t" } },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "c1", content: "1\tx" },
        { type: "tool_result", tool_use_id: "c2", content: "done" },
        { type: "text", text: "Tool loaded." },
      ],
    },
  ]);
  assert.deepStrictEqual(messages, [
    { role: "user", content: [{ type: "text", text: "Fix it." }] },
    {
      role: "assistant",
      content: "Reading.",
      reasoning_content: "Look first.",
      tool_calls: [
        { id: "c1", type: "function", function: { name: "read", arguments: '{"path":"/a.ts"}' } },
        {
          id: "c2",
          type: "function",
          function: { name: "mcp__t3-code__task_status", arguments: '{"taskId":"t"}' },
        },
      ],
    },
    { role: "tool", tool_call_id: "c1", content: "1\tx" },
    { role: "tool", tool_call_id: "c2", content: "done" },
    { role: "user", content: [{ type: "text", text: "Tool loaded." }] },
  ]);
});

it("reads a chat completion as the runner's response", () => {
  const response = fromChatCompletion({
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          content: null,
          reasoning_content: "Need the shell.",
          tool_calls: [
            { id: "x", function: { name: "bash", arguments: '{"command":"ls"}' } },
            { id: "y", function: { name: "bash", arguments: "{not json" } },
          ],
        },
      },
    ],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 7,
      prompt_tokens_details: { cached_tokens: 60 },
    },
  });
  assert.deepStrictEqual(response, {
    content: [
      { type: "thinking", thinking: "Need the shell.", field: "reasoning_content" },
      { type: "tool_use", id: "x", name: "bash", input: { command: "ls" } },
      { type: "tool_use", id: "y", name: "bash", input: { arguments: "{not json" } },
    ],
    stop_reason: "tool_use",
    usage: { input_tokens: 40, output_tokens: 7, cache_read_input_tokens: 60 },
  });
  assert.equal(
    fromChatCompletion({ choices: [{ finish_reason: "length", message: { content: "a" } }] })
      .stop_reason,
    "max_tokens",
  );
});

it("puts this checkout's T3 section into Pi's prompt and grades Pi's tools by their usual names", () => {
  const system = piSystemPrompt({
    messages: [
      {
        role: "developer",
        content:
          "Pi.\n\n<cwd>\n/tmp/x\n</cwd>\n\n<t3_code_orchestration>\nold\n</t3_code_orchestration>",
      },
    ],
    tools: [],
  });
  assert.equal(
    system,
    `Pi.\n\n<cwd>\n/home/user/app\n</cwd>\n\n<t3_code_orchestration>\n${T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim()}\n</t3_code_orchestration>`,
  );
  assert.deepStrictEqual(piParameters({}), { type: "object", properties: {} });
  assert.deepStrictEqual(
    ["bash", "read", "edit", "write", "tool_search", "mcp__t3-code__delegate_task"].map(
      normalizeToolName,
    ),
    ["Bash", "Read", "Edit", "Write", "ToolSearch", "delegate_task"],
  );
});
