import { assert, describe, it } from "@effect/vitest";

import {
  LEAN_MCP_TOOL_NAMES,
  isMcpToolInProfile,
  mcpToolListJsonBytes,
  toolsForMcpProfile,
} from "./mcpToolProfile.ts";

const tool = (name: string) => ({
  name,
  description: `${name} description`,
  inputSchema: { type: "object", properties: { id: { type: "string" } } },
});

const advertised = [
  "orchestrator_capabilities",
  "delegate_task",
  "task_status",
  "task_cancel",
  "request_secret",
  "t3_thread_launch",
  "t3_thread_read",
  "t3_thread_send",
  "t3_project_update",
  "t3_worktree_status",
  "device_list",
  "device_open",
  "preview_open",
  "t3_preview_list",
  "html_preview",
  "html_render",
  "link_pull_request",
  "watch_pull_request",
  "t3_workflow_stop",
  "t3_attachment_prepare_upload",
].map(tool);

describe("MCP tool profiles", () => {
  it("full advertises every tool", () => {
    assert.deepStrictEqual(toolsForMcpProfile(advertised, "full"), advertised);
  });

  it("lean keeps orchestration, thread, project, worktree and secret tools", () => {
    const names = toolsForMcpProfile(advertised, "lean").map(({ name }) => name);
    assert.deepStrictEqual(names, [
      "orchestrator_capabilities",
      "delegate_task",
      "task_status",
      "task_cancel",
      "request_secret",
      "t3_thread_launch",
      "t3_thread_read",
      "t3_thread_send",
      "t3_project_update",
      "t3_worktree_status",
    ]);
  });

  it("lean leaves out device, preview, HTML, pull request and Claude-only tools", () => {
    for (const name of [
      "device_list",
      "device_open",
      "preview_open",
      "t3_preview_list",
      "html_preview",
      "html_render",
      "link_pull_request",
      "watch_pull_request",
      "t3_workflow_stop",
      "t3_background_wait",
      "t3_attachment_prepare_upload",
    ]) {
      assert.isFalse(isMcpToolInProfile(name, "lean"), name);
      assert.isTrue(isMcpToolInProfile(name, "full"), name);
    }
  });

  it("a tool added later stays out of lean until it is listed", () => {
    assert.isFalse(isMcpToolInProfile("t3_future_tool", "lean"));
    assert.isTrue(isMcpToolInProfile("t3_future_tool", "full"));
  });

  it("lists each lean tool once", () => {
    assert.strictEqual(new Set(LEAN_MCP_TOOL_NAMES).size, LEAN_MCP_TOOL_NAMES.length);
  });

  it("measures the advertised name, description and input schema of the profile's tools", () => {
    const withMetadata = advertised.map((entry) => ({
      ...entry,
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true },
    }));
    const expected = (profile: "full" | "lean") =>
      new TextEncoder().encode(
        JSON.stringify(
          toolsForMcpProfile(advertised, profile).map(({ name, description, inputSchema }) => ({
            name,
            description,
            inputSchema,
          })),
        ),
      ).length;
    assert.strictEqual(mcpToolListJsonBytes(withMetadata, "full"), expected("full"));
    assert.strictEqual(mcpToolListJsonBytes(withMetadata, "lean"), expected("lean"));
    assert.isBelow(expected("lean"), expected("full"));
  });
});
