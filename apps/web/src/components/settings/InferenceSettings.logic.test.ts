import { InferenceServerId } from "@t3tools/contracts";
import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_INFERENCE_SERVER_DRAFT,
  inferenceServerFromDraft,
  inferenceServerIdFromName,
  inferenceServerOffers,
  inferenceServerOriginHost,
  inferenceServerRemovalPatch,
  normalizeInferenceServerBaseUrl,
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

  it("keeps a fallback only when it names another registered server", () => {
    const target = { mode: "edit", id: InferenceServerId.make("rtx"), enabled: true } as const;
    const withFallback = inferenceServerFromDraft(
      { ...draft, fallbackServerId: "spark1" },
      new Set(["rtx", "spark1"]),
      target,
    );
    expect(Result.isSuccess(withFallback) && withFallback.success.config.fallbackServerId).toBe(
      "spark1",
    );
    for (const fallbackServerId of ["rtx", "gone"]) {
      expect(
        inferenceServerFromDraft({ ...draft, fallbackServerId }, new Set(["rtx"]), target),
      ).toEqual(Result.fail({ fallbackServerId: "Choose another registered server, or none." }));
    }
  });
});

describe("inferenceServerRemovalPatch", () => {
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

  it("removes a server and clears it as others' fallback in one patch", () => {
    const withFallbacks = {
      ...servers,
      [InferenceServerId.make("old")]: { ...servers.old, fallbackServerId: "rtx" },
      [InferenceServerId.make("spark1")]: {
        baseUrl: "http://spark1/v1",
        apiKey: "",
        enabled: true,
        fallbackServerId: "old",
      },
    } as unknown as typeof servers;
    expect(inferenceServerRemovalPatch(withFallbacks, InferenceServerId.make("rtx"))).toEqual({
      rtx: null,
      old: { baseUrl: "http://old/v1", apiKey: "", enabled: false },
    });
  });
});

describe("inferenceServerOffers", () => {
  const rtx = InferenceServerId.make("glm-rtx");
  const spark = InferenceServerId.make("spark1");
  const origin = {
    [rtx]: { baseUrl: "http://localhost:8888/v1", apiKey: "", enabled: true },
    [spark]: {
      displayName: "Spark",
      baseUrl: "http://spark1:8000/v1",
      apiKey: "•••",
      enabled: true,
    },
  };

  it("offers the origin's servers at the address another machine reaches", () => {
    expect(inferenceServerOffers({}, { servers: origin, host: "rtx" })).toEqual([
      { id: rtx, name: "glm-rtx", baseUrl: "http://rtx:8888/v1", needsKey: false },
      { id: spark, name: "Spark", baseUrl: "http://spark1:8000/v1", needsKey: true },
    ]);
  });

  it("skips servers this machine has by id or by address", () => {
    const current = {
      [InferenceServerId.make("other")]: {
        baseUrl: "http://rtx:8888/v1",
        apiKey: "",
        enabled: true,
      },
      [spark]: { baseUrl: "http://elsewhere/v1", apiKey: "", enabled: true },
    };
    expect(inferenceServerOffers(current, { servers: origin, host: "rtx" })).toEqual([]);
  });

  it("names the origin by its label, else by a LAN endpoint", () => {
    expect(inferenceServerOriginHost("rtx")).toBe("rtx");
    expect(
      inferenceServerOriginHost("Zurih's desktop", [
        { kind: "loopback", httpBaseUrl: "http://127.0.0.1:3773" },
        { kind: "lan", httpBaseUrl: "http://192.168.1.122:3773" },
      ]),
    ).toBe("192.168.1.122");
    expect(inferenceServerOriginHost("My PC")).toBeNull();
  });
});
