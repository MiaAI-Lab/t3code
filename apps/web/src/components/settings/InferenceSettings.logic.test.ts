import { InferenceServerId } from "@t3tools/contracts";
import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";

import {
  describeInferenceModelContext,
  EMPTY_INFERENCE_SERVER_DRAFT,
  inferenceServerFromDraft,
  inferenceServerIdFromName,
  normalizeInferenceServerBaseUrl,
  presentInferenceServers,
  resolveInferenceServerLink,
} from "./InferenceSettings.logic";

describe("normalizeInferenceServerBaseUrl", () => {
  it.each([
    ["http://localhost:11434", "http://localhost:11434/v1"],
    [" http://localhost:11434/ ", "http://localhost:11434/v1"],
    ["https://spark1:8888/v1/", "https://spark1:8888/v1"],
    ["http://10.0.0.2:8000/openai/v1", "http://10.0.0.2:8000/openai/v1"],
  ])("accepts %s", (raw, expected) => {
    expect(normalizeInferenceServerBaseUrl(raw)).toEqual(Result.succeed(expected));
  });

  it.each([
    ["", "Enter the server URL."],
    ["localhost:11434", "Use an http:// or https:// URL."],
    ["not a url", "Enter a full URL, such as http://localhost:11434/v1."],
    ["ftp://host/v1", "Use an http:// or https:// URL."],
    ["http://user:pass@host/v1", "Remove the credentials from the URL and put the key in API key."],
    ["http://host/v1?api_key=abc", "Remove the query string; put any key in API key."],
    ["http://host/v1?", "Remove the query string; put any key in API key."],
    ["http://host/v1#x", "Remove the #fragment from the URL."],
  ])("rejects %j", (raw, message) => {
    expect(normalizeInferenceServerBaseUrl(raw)).toEqual(Result.fail(message));
  });
});

describe("inferenceServerIdFromName", () => {
  it.each([
    ["RTX 5090", "rtx-5090"],
    ["  Spark #1 ", "spark-1"],
    ["4090 box", "server-4090-box"],
    ["!!!", null],
  ])("%j -> %j", (name, id) => {
    expect(inferenceServerIdFromName(name)).toBe(id);
  });
});

describe("inferenceServerFromDraft", () => {
  const draft = { ...EMPTY_INFERENCE_SERVER_DRAFT, baseUrl: "http://spark1:8888" };

  it("slugs the name, falls back to the host, and refuses an existing id on add", () => {
    expect(inferenceServerFromDraft({ ...draft, name: "RTX" }, new Set(), { mode: "add" })).toEqual(
      Result.succeed({
        id: "rtx",
        config: {
          displayName: "RTX",
          baseUrl: "http://spark1:8888/v1",
          apiKey: "",
          enabled: true,
        },
      }),
    );
    const byHost = inferenceServerFromDraft(draft, new Set(), { mode: "add" });
    expect(Result.isSuccess(byHost) && byHost.success.id).toBe("spark1");
    expect(inferenceServerFromDraft(draft, new Set(["spark1"]), { mode: "add" })).toEqual(
      Result.fail({ name: "A server with this name exists." }),
    );
  });

  it("keeps the id and enabled flag on edit and validates max concurrency", () => {
    const target = { mode: "edit", id: InferenceServerId.make("rtx"), enabled: false } as const;
    const edited = inferenceServerFromDraft(
      { ...draft, name: "Renamed", maxConcurrency: "4", apiKey: " key " },
      new Set(["rtx"]),
      target,
    );
    expect(edited).toEqual(
      Result.succeed({
        id: "rtx",
        config: {
          displayName: "Renamed",
          baseUrl: "http://spark1:8888/v1",
          apiKey: "key",
          enabled: false,
          maxConcurrency: 4,
        },
      }),
    );
    for (const maxConcurrency of ["0", "1.5", "two"]) {
      expect(inferenceServerFromDraft({ ...draft, maxConcurrency }, new Set(), target)).toEqual(
        Result.fail({ maxConcurrency: "Enter a whole number of 1 or more, or leave it empty." }),
      );
    }
  });
});

describe("describeInferenceModelContext", () => {
  it("shows the served window and the trained one only when it differs", () => {
    expect(describeInferenceModelContext({ id: "m", servedContextWindow: 131072 })).toBe(
      "131k context",
    );
    expect(
      describeInferenceModelContext({
        id: "m",
        servedContextWindow: 32768,
        trainedContextWindow: 1_048_576,
      }),
    ).toBe("33k context (trained 1M)");
    expect(describeInferenceModelContext({ id: "m", trainedContextWindow: 8192 })).toBe(
      "trained for 8k",
    );
    expect(describeInferenceModelContext({ id: "m" })).toBeNull();
  });
});

describe("resolveInferenceServerLink", () => {
  const servers = {
    [InferenceServerId.make("rtx")]: {
      displayName: "RTX",
      baseUrl: "http://localhost:8888/v1",
      apiKey: "",
      enabled: true,
    },
    [InferenceServerId.make("old")]: {
      baseUrl: "http://old/v1",
      apiKey: "",
      enabled: false,
    },
  };

  it("classifies the link", () => {
    expect(resolveInferenceServerLink(undefined, servers)).toEqual({ kind: "none" });
    expect(resolveInferenceServerLink("rtx", servers)).toEqual({ kind: "enabled", name: "RTX" });
    expect(resolveInferenceServerLink("old", servers)).toEqual({ kind: "disabled", name: "old" });
    expect(resolveInferenceServerLink("gone", servers)).toEqual({ kind: "missing", id: "gone" });
  });

  it("treats a removal the server has not confirmed as gone", () => {
    const removing = {
      ...servers,
      [InferenceServerId.make("old")]: null,
    } as unknown as typeof servers;
    expect(resolveInferenceServerLink("old", removing)).toEqual({ kind: "missing", id: "old" });
    expect(presentInferenceServers(removing).map(([id]) => id)).toEqual(["rtx"]);
  });
});
