/** Which of T3's MCP tools a session advertises. Tool text is the same in every profile. */
export const MCP_TOOL_PROFILES = ["full", "lean"] as const;
export type McpToolProfile = (typeof MCP_TOOL_PROFILES)[number];

/**
 * Tools a lean session advertises: orchestration, threads, projects, worktrees, secrets and
 * scheduling, which the always-on instructions name. Device, preview, HTML, pull request,
 * attachment, environment-preference, queue and Claude-only tools are left out, not deferred.
 * An allowlist, so a new tool stays out of lean until someone weighs its schema cost here.
 */
export const LEAN_MCP_TOOL_NAMES: ReadonlyArray<string> = [
  "orchestrator_capabilities",
  "delegate_task",
  "task_status",
  "task_cancel",
  "request_secret",
  "schedule_task",
  "list_scheduled_tasks",
  "delete_scheduled_task",
  "create_threads",
  "t3_thread_launch",
  "t3_thread_list",
  "t3_thread_read",
  "t3_thread_update",
  "t3_thread_send",
  "t3_thread_wait",
  "t3_thread_interrupt",
  "t3_thread_search",
  "t3_thread_configure",
  "t3_thread_organize",
  "t3_pending_request",
  "t3_environment_links",
  "t3_environment_link",
  "t3_environment_unlink",
  "t3_project_list",
  "t3_project_read",
  "t3_project_create",
  "t3_project_update",
  "t3_project_delete",
  "t3_project_clone",
  "t3_worktree_handoff",
  "t3_worktree_status",
  "t3_worktree_list",
];

const LEAN = new Set(LEAN_MCP_TOOL_NAMES);

export const isMcpToolInProfile = (name: string, profile: McpToolProfile) =>
  profile === "full" || LEAN.has(name);

export const toolsForMcpProfile = <T extends { readonly name: string }>(
  tools: ReadonlyArray<T>,
  profile: McpToolProfile,
) => tools.filter((tool) => isMcpToolInProfile(tool.name, profile));

/** UTF-8 bytes of the fields a model sees for a profile's tools; protocol metadata is excluded. */
export const mcpToolListJsonBytes = (
  tools: ReadonlyArray<{
    readonly name: string;
    readonly description?: string | undefined;
    readonly inputSchema?: unknown;
  }>,
  profile: McpToolProfile,
) =>
  new TextEncoder().encode(
    JSON.stringify(
      toolsForMcpProfile(tools, profile).map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      })),
    ),
  ).length;
