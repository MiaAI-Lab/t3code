import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import type { ManagedInferenceServer } from "@t3tools/provider-core/server/inferenceGateway";
import type {
  InferenceGatewayCredential,
  McpProviderSessionConfig,
} from "@t3tools/provider-core/server/mcpSession";
import {
  PI_T3_GATEWAY_EXTENSION_FILENAME,
  PI_T3_GATEWAY_EXTENSION_SOURCE,
  T3_GATEWAY_MODELS_ENV,
  T3_GATEWAY_PROVIDER_ENV,
  T3_GATEWAY_TOKEN_ENV,
  T3_GATEWAY_URL_ENV,
} from "./gatewayExtensionSource.ts";
import type { McpToolProfile } from "@t3tools/provider-core/server/mcpToolProfile";
import {
  PI_T3_MCP_EXTENSION_FILENAME,
  PI_T3_MCP_EXTENSION_SOURCE,
  T3_MCP_BEARER_ENV,
  T3_MCP_URL_ENV,
  T3_PI_RUNTIME_MODE_ENV,
  T3_PI_MCP_EXTENSION_PATH_ENV,
  T3_PI_TOOL_PROFILE_ENV,
} from "./mcpExtensionSource.ts";
import type { PiSettings } from "../settings.ts";

const RESERVED_PI_LAUNCH_ARGUMENTS = new Set([
  "--continue",
  "-c",
  "--export",
  "--fork",
  "--help",
  "-h",
  "--list-models",
  "--mode",
  "--no-session",
  "--print",
  "-p",
  "--resume",
  "-r",
  "--session",
  "--session-id",
  "--version",
  "-v",
]);

export const PI_ARGUMENTS_WITH_VALUES = new Set([
  "--api-key",
  "--append-system-prompt",
  "--exclude-tools",
  "-xt",
  "--extension",
  "-e",
  "--model",
  "--models",
  "--name",
  "-n",
  "--prompt-template",
  "--provider",
  "--session-dir",
  "--skill",
  "--system-prompt",
  "--theme",
  "--thinking",
  "--tools",
  "-t",
  "--tui-mode",
  "--use-theme",
]);

const PI_ARGUMENTS_WITHOUT_VALUES = new Set([
  "--approve",
  "-a",
  "--no-approve",
  "-na",
  "--no-builtin-tools",
  "-nbt",
  "--no-context-files",
  "-nc",
  "--no-extensions",
  "-ne",
  "--no-prompt-templates",
  "-np",
  "--no-skills",
  "-ns",
  "--no-themes",
  "--no-tools",
  "-nt",
  "--offline",
  "--verbose",
]);

export type PiLaunchArgsResolution =
  | { readonly ok: true; readonly args: ReadonlyArray<string> }
  | { readonly ok: false; readonly message: string };

function reservedPiArgument(arg: string): string | undefined {
  for (const reserved of RESERVED_PI_LAUNCH_ARGUMENTS) {
    if (arg === reserved || (reserved.startsWith("--") && arg.startsWith(`${reserved}=`))) {
      return reserved;
    }
  }
  return undefined;
}

function normalizePiBuiltInEqualsArguments(args: ReadonlyArray<string>): ReadonlyArray<string> {
  return args.flatMap((arg) => {
    const equalsIndex = arg.indexOf("=");
    if (equalsIndex <= 0) return [arg];
    const option = arg.slice(0, equalsIndex);
    return PI_ARGUMENTS_WITH_VALUES.has(option) ? [option, arg.slice(equalsIndex + 1)] : [arg];
  });
}

export function resolvePiLaunchArgs(launchArgs: string): PiLaunchArgsResolution {
  // Pi treats equals-form tokens as extension flags; split only known built-ins.
  const args = normalizePiBuiltInEqualsArguments(tokenizeCliArgs(launchArgs));
  let hasProvider = false;
  let hasModel = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    const reserved = reservedPiArgument(arg);
    if (reserved !== undefined) {
      return {
        ok: false,
        message: `Pi launch argument '${reserved}' is controlled by T3 Code and cannot be overridden.`,
      };
    }
    if (arg === "--") {
      return {
        ok: false,
        message: "Pi launch arguments cannot include positional prompts.",
      };
    }
    if (PI_ARGUMENTS_WITH_VALUES.has(arg)) {
      const value = args[index + 1];
      if (value === undefined) {
        return { ok: false, message: `Pi launch argument '${arg}' requires a value.` };
      }
      if (arg === "--provider") hasProvider = true;
      if (arg === "--model") hasModel = true;
      index += 1;
      continue;
    }
    if (PI_ARGUMENTS_WITHOUT_VALUES.has(arg) || (arg.startsWith("--") && arg.includes("="))) {
      continue;
    }
    if (arg.startsWith("--")) {
      // Arbitrary extension flags may consume one following non-flag token.
      if (
        args[index + 1] !== undefined &&
        !args[index + 1]!.startsWith("-") &&
        !args[index + 1]!.startsWith("@")
      ) {
        index += 1;
      }
      continue;
    }
    if (arg.startsWith("-")) {
      return { ok: false, message: `Pi launch argument '${arg}' is not supported by T3 Code.` };
    }
    return {
      ok: false,
      message: `Pi launch arguments cannot include positional prompt '${arg}'.`,
    };
  }
  if (hasProvider && !hasModel) {
    return { ok: false, message: "Pi launch argument '--provider' requires '--model'." };
  }
  return { ok: true, args };
}

function bearerTokenFromAuthorizationHeader(header: string): string {
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : header;
}

function normalizedPiPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "");
}

function hasExplicitExtension(args: ReadonlyArray<string>, extensionPath: string): boolean {
  const wanted = normalizedPiPath(extensionPath);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg !== "--extension" && arg !== "-e") continue;
    const configured = args[index + 1];
    if (configured !== undefined && normalizedPiPath(configured) === wanted) return true;
    index += 1;
  }
  return false;
}

function withoutExplicitExtensions(args: ReadonlyArray<string>): ReadonlyArray<string> {
  const filtered: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg === "--extension" || arg === "-e") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--extension=") || arg.startsWith("-e=")) continue;
    filtered.push(arg);
  }
  return filtered;
}

function withoutToolSelectionArgs(args: ReadonlyArray<string>): ReadonlyArray<string> {
  const filtered: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg === "--tools" || arg === "-t" || arg === "--exclude-tools" || arg === "-xt") {
      index += 1;
      continue;
    }
    if (
      arg === "--no-tools" ||
      arg === "-nt" ||
      arg === "--no-builtin-tools" ||
      arg === "-nbt" ||
      arg.startsWith("--tools=") ||
      arg.startsWith("-t=") ||
      arg.startsWith("--exclude-tools=") ||
      arg.startsWith("-xt=")
    ) {
      continue;
    }
    filtered.push(arg);
  }
  return filtered;
}

function piT3McpExtensionDestPath(cacheDir: string): string {
  return `${cacheDir.replace(/\\/g, "/")}/${PI_T3_MCP_EXTENSION_FILENAME}`;
}

const materializeSource = Effect.fnUntraced(function* (dest: string, source: string) {
  const fs = yield* FileSystem.FileSystem;
  const existing = yield* fs.readFileString(dest).pipe(Effect.orElseSucceed(() => ""));
  if (existing !== source) {
    yield* fs.writeFileString(dest, source);
  }
  return dest;
});

export const materializePiT3McpExtension = Effect.fn("materializePiT3McpExtension")(function* (
  cacheDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(cacheDir, { recursive: true });
  return yield* materializeSource(piT3McpExtensionDestPath(cacheDir), PI_T3_MCP_EXTENSION_SOURCE);
});

/** For discovery and text generation, which run without T3's full extension. */
export const materializePiT3GatewayExtension = Effect.fn("materializePiT3GatewayExtension")(
  function* (cacheDir: string) {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(cacheDir, { recursive: true });
    return yield* materializeSource(
      `${cacheDir.replace(/\\/g, "/")}/${PI_T3_GATEWAY_EXTENSION_FILENAME}`,
      PI_T3_GATEWAY_EXTENSION_SOURCE,
    );
  },
);

export interface PiGatewayLaunch {
  readonly server: ManagedInferenceServer;
  readonly credential: InferenceGatewayCredential;
}

const piGatewayProviderName = (serverId: string) => `t3-${serverId}`;

const PI_THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
// Pi's documented defaults for a model that does not say.
const PI_DEFAULT_CONTEXT_WINDOW = 128_000;
const PI_DEFAULT_MAX_TOKENS = 16_384;

/** Pi model configs for registerProvider; a level the server does not advertise is unsupported. */
function piGatewayModels(server: ManagedInferenceServer) {
  return server.models.map((model) => {
    const efforts = new Set(model.reasoningEfforts ?? []);
    return {
      id: model.id,
      name: `${model.id} (${server.displayName})`,
      reasoning: efforts.size > 0,
      ...(efforts.size === 0
        ? {}
        : {
            thinkingLevelMap: Object.fromEntries(
              PI_THINKING_LEVELS.map((level) => [level, efforts.has(level) ? level : null]),
            ),
          }),
      input: model.images === false ? ["text"] : ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: model.contextWindow ?? PI_DEFAULT_CONTEXT_WINDOW,
      maxTokens: Math.min(
        model.maxOutputTokens ?? PI_DEFAULT_MAX_TOKENS,
        model.contextWindow ?? Number.POSITIVE_INFINITY,
      ),
    };
  });
}

/** An explicit profile wins; "auto" follows the instance's link to an enabled inference server. */
export function resolvePiToolProfile(
  setting: PiSettings["toolProfile"],
  linkedToInferenceServer: boolean,
): McpToolProfile {
  if (setting !== "auto") return setting;
  // GLM-5.3-Flash passed as many mcp-tool-use cases with lean as with full (evals/mcp-tool-use).
  return linkedToInferenceServer ? "lean" : "full";
}

export function buildPiRpcLaunch(input: {
  readonly launchArgs: ReadonlyArray<string>;
  readonly environment: NodeJS.ProcessEnv;
  readonly mcpSession: McpProviderSessionConfig | undefined;
  readonly extensionPath: string | undefined;
  readonly sessionPath?: string | undefined;
  readonly ephemeral?: boolean;
  // T3 stops these processes as soon as they answer. They run --offline because Pi's startup
  // catalog refresh renews expired OAuth tokens, and a stop mid-request loses the rotated one.
  readonly shortLived?: boolean;
  readonly disableExtensions?: boolean;
  readonly disableTools?: boolean;
  /** A managed inference server: registered in Pi as `t3-<serverId>` through T3's gateway. */
  readonly gateway?: PiGatewayLaunch | undefined;
  /** Loaded alone, even under --no-extensions, when T3's full extension is not. */
  readonly gatewayExtensionPath?: string | undefined;
  readonly runtimeMode?: "approval-required" | "auto-accept-edits" | "auto" | "full-access";
  readonly toolProfile?: McpToolProfile;
}): {
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
} {
  const hasT3Extension = input.disableExtensions !== true && input.extensionPath !== undefined;
  const hasT3Mcp = hasT3Extension && input.mcpSession !== undefined;
  const extensionSafeArgs =
    input.disableExtensions === true
      ? withoutExplicitExtensions(input.launchArgs)
      : input.launchArgs;
  const launchArgs =
    input.disableTools === true ? withoutToolSelectionArgs(extensionSafeArgs) : extensionSafeArgs;
  const args = [
    "--mode",
    "rpc",
    ...(input.ephemeral === true
      ? ["--no-session"]
      : input.sessionPath !== undefined
        ? ["--session", input.sessionPath]
        : []),
    ...launchArgs,
    ...(input.shortLived === true && !launchArgs.includes("--offline") ? ["--offline"] : []),
    // Restrictions must follow launch args so user flags cannot re-enable unattended tools/extensions.
    ...(input.disableExtensions === true ? ["--no-extensions"] : []),
    ...(input.disableTools === true ? ["--no-tools"] : []),
  ];
  if (
    hasT3Extension &&
    input.extensionPath !== undefined &&
    !hasExplicitExtension(args, input.extensionPath)
  ) {
    args.push("--extension", input.extensionPath);
  }
  const gatewayCarrier = hasT3Extension
    ? "full"
    : input.gateway !== undefined && input.gatewayExtensionPath !== undefined
      ? "gateway-only"
      : undefined;
  if (gatewayCarrier === "gateway-only" && input.gatewayExtensionPath !== undefined) {
    args.push("--extension", input.gatewayExtensionPath);
  }
  const environment = { ...input.environment };
  // MCP credentials belong to this T3 session; discard inherited server/parent credentials.
  for (const name of [
    T3_GATEWAY_URL_ENV,
    T3_GATEWAY_TOKEN_ENV,
    T3_GATEWAY_PROVIDER_ENV,
    T3_GATEWAY_MODELS_ENV,
  ]) {
    delete environment[name];
  }
  delete environment[T3_MCP_URL_ENV];
  delete environment[T3_MCP_BEARER_ENV];
  delete environment[T3_PI_MCP_EXTENSION_PATH_ENV];
  delete environment[T3_PI_TOOL_PROFILE_ENV];

  return {
    args,
    env: {
      ...environment,
      ...(hasT3Extension && input.extensionPath !== undefined
        ? { [T3_PI_MCP_EXTENSION_PATH_ENV]: input.extensionPath }
        : {}),
      ...(hasT3Extension && input.runtimeMode !== undefined
        ? {
            [T3_PI_RUNTIME_MODE_ENV]:
              input.runtimeMode === "auto" ? "approval-required" : input.runtimeMode,
          }
        : {}),
      ...(hasT3Mcp && input.toolProfile !== undefined
        ? { [T3_PI_TOOL_PROFILE_ENV]: input.toolProfile }
        : {}),
      ...(hasT3Mcp && input.mcpSession !== undefined
        ? {
            [T3_MCP_URL_ENV]: input.mcpSession.endpoint,
            [T3_MCP_BEARER_ENV]: bearerTokenFromAuthorizationHeader(
              input.mcpSession.authorizationHeader,
            ),
          }
        : {}),
      ...(gatewayCarrier !== undefined && input.gateway !== undefined
        ? {
            [T3_GATEWAY_URL_ENV]: input.gateway.credential.baseUrl,
            [T3_GATEWAY_TOKEN_ENV]: input.gateway.credential.token,
            [T3_GATEWAY_PROVIDER_ENV]: piGatewayProviderName(input.gateway.server.serverId),
            [T3_GATEWAY_MODELS_ENV]: JSON.stringify(piGatewayModels(input.gateway.server)),
          }
        : {}),
    },
  };
}
