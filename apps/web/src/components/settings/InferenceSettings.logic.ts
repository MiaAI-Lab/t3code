import {
  InferenceServerId,
  type InferenceServerConfig,
  type SecretReference,
} from "@t3tools/contracts";
import {
  presentInferenceServers,
  type InferenceServers,
} from "@t3tools/client-runtime/state/inference-presentation";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

const decodeInferenceServerId = Schema.decodeOption(InferenceServerId);

/**
 * An OpenAI-compatible root the server can probe. A bare host gets `/v1`, the root every supported
 * engine serves. Credentials and query strings are refused: they would be stored and shown in plain
 * text, while the API key field is kept as a secret.
 */
export function normalizeInferenceServerBaseUrl(raw: string): Result.Result<string, string> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return Result.fail("Enter the server URL.");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return Result.fail("Enter a full URL, such as http://localhost:11434/v1.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return Result.fail("Use an http:// or https:// URL.");
  }
  if (url.username !== "" || url.password !== "") {
    return Result.fail("Remove the credentials from the URL and put the key in API key.");
  }
  if (url.search !== "" || trimmed.includes("?")) {
    return Result.fail("Remove the query string; put any key in API key.");
  }
  if (url.hash !== "" || trimmed.includes("#")) {
    return Result.fail("Remove the #fragment from the URL.");
  }
  const path = url.pathname.replace(/\/+$/, "");
  return Result.succeed(`${url.origin}${path === "" ? "/v1" : path}`);
}

/** Stable and readable in settings.json, so re-adding a server under the same name keeps its links. */
export function inferenceServerIdFromName(name: string): InferenceServerId | null {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug === "") return null;
  const id = (/^[a-z]/.test(slug) ? slug : `server-${slug}`).slice(0, 64).replace(/-+$/, "");
  return Option.getOrNull(decodeInferenceServerId(id));
}

export interface InferenceServerDraft {
  readonly name: string;
  readonly baseUrl: string;
  readonly apiKey: string | SecretReference;
  readonly maxConcurrency: string;
  /** Another registered server's id, or "" for none. */
  readonly fallbackServerId: string;
}

export const EMPTY_INFERENCE_SERVER_DRAFT: InferenceServerDraft = {
  name: "",
  baseUrl: "",
  apiKey: "",
  maxConcurrency: "",
  fallbackServerId: "",
};

export function draftFromInferenceServer(config: InferenceServerConfig): InferenceServerDraft {
  return {
    name: config.displayName ?? "",
    baseUrl: config.baseUrl,
    // A saved key arrives redacted; sending it back unchanged keeps it.
    apiKey: config.apiKey,
    maxConcurrency: config.maxConcurrency === undefined ? "" : String(config.maxConcurrency),
    fallbackServerId: config.fallbackServerId ?? "",
  };
}

export type InferenceServerTarget =
  | { readonly mode: "add" }
  | { readonly mode: "edit"; readonly id: InferenceServerId; readonly enabled: boolean };

export type InferenceServerDraftIssues = {
  readonly [Field in keyof InferenceServerDraft]?: string;
};

/** The settings entry a draft adds or replaces, or every field that blocks it, one message each. */
export function inferenceServerFromDraft(
  draft: InferenceServerDraft,
  existingIds: ReadonlySet<string>,
  target: InferenceServerTarget,
): Result.Result<
  { readonly id: InferenceServerId; readonly config: InferenceServerConfig },
  InferenceServerDraftIssues
> {
  const issues: { -readonly [Field in keyof InferenceServerDraft]?: string } = {};
  const baseUrl = normalizeInferenceServerBaseUrl(draft.baseUrl);
  if (Result.isFailure(baseUrl)) issues.baseUrl = baseUrl.failure;

  const name = draft.name.trim();
  let id: InferenceServerId | null = null;
  if (target.mode === "edit") {
    id = target.id;
  } else {
    let host = "";
    if (Result.isSuccess(baseUrl)) host = new URL(baseUrl.success).hostname;
    id = inferenceServerIdFromName(name || host);
    if (id === null && name !== "") issues.name = "The name needs at least one letter or digit.";
    else if (id !== null && existingIds.has(id)) issues.name = "A server with this name exists.";
  }

  const concurrencyText = draft.maxConcurrency.trim();
  const maxConcurrency = concurrencyText === "" ? undefined : Number(concurrencyText);
  if (maxConcurrency !== undefined && (!Number.isInteger(maxConcurrency) || maxConcurrency < 1)) {
    issues.maxConcurrency = "Enter a whole number of 1 or more, or leave it empty.";
  }

  const fallbackServerId =
    draft.fallbackServerId === "" ? undefined : (draft.fallbackServerId as InferenceServerId);
  if (
    fallbackServerId !== undefined &&
    (fallbackServerId === id || !existingIds.has(fallbackServerId))
  ) {
    issues.fallbackServerId = "Choose another registered server, or none.";
  }

  const apiKey = typeof draft.apiKey === "string" ? draft.apiKey.trim() : draft.apiKey;
  if (id === null || Result.isFailure(baseUrl) || Object.keys(issues).length > 0) {
    return Result.fail(issues);
  }
  return Result.succeed({
    id,
    config: {
      ...(name === "" ? {} : { displayName: name }),
      baseUrl: baseUrl.success,
      apiKey,
      enabled: target.mode === "edit" ? target.enabled : true,
      ...(maxConcurrency === undefined ? {} : { maxConcurrency }),
      ...(fallbackServerId === undefined ? {} : { fallbackServerId }),
    },
  });
}

/** Removes a server and, in the same patch, clears it as the fallback of the others. */
export function inferenceServerRemovalPatch(
  servers: InferenceServers | undefined,
  id: InferenceServerId,
): Record<InferenceServerId, InferenceServerConfig | null> {
  const patch: Record<InferenceServerId, InferenceServerConfig | null> = { [id]: null };
  for (const [otherId, config] of presentInferenceServers(servers)) {
    if (otherId === id || config.fallbackServerId !== id) continue;
    const { fallbackServerId: _removed, ...rest } = config;
    patch[otherId] = rest;
  }
  return patch;
}
