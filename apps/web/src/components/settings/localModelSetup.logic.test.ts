import { InferenceServerId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  knownServerModelIds,
  linkedModelSlug,
  localModelAgentChoices,
  planLocalModelSetup,
  repairCandidates,
} from "./localModelSetup.logic";

const pi = ProviderDriverKind.make("pi");
const codex = ProviderDriverKind.make("codex");
const rtx = InferenceServerId.make("rtx");

describe("localModelAgentChoices", () => {
  it("recommends an installed Pi or OpenCode, offers unchecked ones, and says why others cannot", () => {
    const choices = localModelAgentChoices(
      { apiProtocols: ["chat-completions"] },
      [
        { driver: pi, installed: true, enabled: true },
        { driver: codex, installed: true, enabled: true },
      ],
      "rtx",
    );
    expect(choices).toEqual([
      { driver: pi, label: "Pi", unchecked: false, experimental: false, recommended: true },
      {
        driver: ProviderDriverKind.make("opencode"),
        label: "OpenCode",
        unchecked: true,
        experimental: false,
        recommended: false,
      },
      {
        driver: codex,
        label: "Codex",
        unavailableReason: "The server did not confirm the OpenAI Responses API Codex needs.",
        unchecked: false,
        experimental: true,
        recommended: false,
      },
    ]);
  });

  it("prefers an unchecked Pi over an installed Codex, and reports a missing install", () => {
    const both = { apiProtocols: ["chat-completions", "responses"] } as const;
    const recommended = (providers: Parameters<typeof localModelAgentChoices>[1]) =>
      localModelAgentChoices(both, providers, "rtx").find((choice) => choice.recommended)?.label;
    expect(recommended([{ driver: codex, installed: true, enabled: true }])).toBe("Pi");
    expect(
      localModelAgentChoices(both, [{ driver: pi, installed: false, enabled: true }], "rtx")[0]
        ?.unavailableReason,
    ).toBe("Pi is not installed on rtx.");
    // A turned-off Pi has not been checked, so it is offered again rather than called missing.
    expect(recommended([{ driver: pi, installed: false, enabled: false }])).toBe("Pi");
    expect(
      recommended([
        { driver: pi, installed: false, enabled: true },
        { driver: ProviderDriverKind.make("opencode"), installed: false, enabled: true },
        { driver: codex, installed: true, enabled: true },
      ]),
    ).toBe("Codex");
  });
});

describe("planLocalModelSetup", () => {
  const moved = { baseUrl: "http://localhost:8030/v1" };

  it("adds a server and a linked agent, beside a stale server of the same name", () => {
    expect(
      planLocalModelSetup({
        settings: {
          inferenceServers: {
            [rtx]: { baseUrl: "http://localhost:8888/v1", apiKey: "", enabled: true },
          },
          providerInstances: {},
        },
        server: moved,
        driver: pi,
        agentLabel: "Pi",
        machineLabel: "rtx",
      }),
    ).toEqual({
      serverId: "rtx-8030",
      serverName: "rtx :8030",
      serverConfig: {
        displayName: "rtx :8030",
        baseUrl: "http://localhost:8030/v1",
        apiKey: "",
        enabled: true,
      },
      instanceId: "pi-rtx-8030",
      instanceMutation: {
        operation: "create",
        instanceId: "pi-rtx-8030",
        instance: {
          driver: pi,
          displayName: "Pi · rtx :8030",
          inferenceServerId: "rtx-8030",
          enabled: true,
        },
      },
    });
  });

  it("changes nothing when the server and its linked agent already exist", () => {
    const linkedPi = ProviderInstanceId.make("pi_rtx");
    const settings = {
      inferenceServers: {
        [rtx]: { baseUrl: "http://localhost:8030/v1", apiKey: "", enabled: true },
      },
      providerInstances: { [linkedPi]: { driver: pi, inferenceServerId: rtx } },
    };
    // The second also covers a retry whose search ran before the first attempt saved the server.
    for (const server of [{ ...moved, registeredServerId: rtx }, moved]) {
      const plan = planLocalModelSetup({
        settings,
        server,
        driver: pi,
        agentLabel: "Pi",
        machineLabel: "rtx",
      });
      expect(plan).toMatchObject({ serverId: rtx, serverConfig: null, instanceId: linkedPi });
      expect(plan?.instanceMutation).toBeNull();
    }
  });

  it("turns a registered server and its linked agent back on instead of adding new ones", () => {
    const linkedPi = ProviderInstanceId.make("pi_rtx");
    const plan = planLocalModelSetup({
      settings: {
        inferenceServers: {
          [rtx]: { baseUrl: "http://localhost:8030/v1", apiKey: "", enabled: false },
        },
        providerInstances: { [linkedPi]: { driver: pi, inferenceServerId: rtx, enabled: false } },
      },
      server: { ...moved, registeredServerId: rtx },
      driver: pi,
      agentLabel: "Pi",
      machineLabel: "rtx",
    });
    expect(plan?.serverConfig?.enabled).toBe(true);
    expect(plan?.instanceMutation).toEqual({
      operation: "upsert",
      instanceId: linkedPi,
      instance: { driver: pi, inferenceServerId: rtx, enabled: true },
    });
  });
});

describe("linkedModelSlug", () => {
  it("prefers the gateway's entry over the agent's own config for the same model", () => {
    expect(
      linkedModelSlug(
        [{ slug: "tensorfold/GLM-5.3-Flash" }, { slug: "t3-rtx/GLM-5.3-Flash" }],
        rtx,
        "GLM-5.3-Flash",
      ),
    ).toBe("t3-rtx/GLM-5.3-Flash");
    expect(linkedModelSlug([{ slug: "GLM-5.3-Flash" }], rtx, "GLM-5.3-Flash")).toBe(
      "GLM-5.3-Flash",
    );
    expect(linkedModelSlug([{ slug: "t3-rtx/GLM-5" }], rtx, "GLM-5.3-Flash")).toBeUndefined();
    expect(
      linkedModelSlug([{ slug: "t3-spark1/GLM-5.3-Flash" }], rtx, "GLM-5.3-Flash"),
    ).toBeUndefined();
  });
});

describe("repairCandidates", () => {
  it("offers other servers on the host, the one serving a known model first", () => {
    const spark1 = InferenceServerId.make("spark1");
    const known = knownServerModelIds(
      rtx,
      [],
      [{ model: "t3-rtx/GLM-5.3-Flash" }, { model: "gpt-6-luna" }, null],
    );
    expect([...known]).toEqual(["GLM-5.3-Flash"]);
    const found = [
      { baseUrl: "http://localhost:8888/v1", status: "ready", models: [], registeredServerId: rtx },
      { baseUrl: "http://localhost:39459/v1", status: "ready", models: [{ id: "DeepSeek" }] },
      { baseUrl: "http://localhost:8030/v1", status: "ready", models: [{ id: "GLM-5.3-Flash" }] },
      { baseUrl: "http://localhost:11434/v1", status: "needs-key", models: [] },
      {
        baseUrl: "http://localhost:9000/v1",
        status: "ready",
        models: [{ id: "GLM-5.3-Flash" }],
        registeredServerId: spark1,
      },
    ] as const;
    expect(
      repairCandidates(found, rtx, "http://localhost:8888/v1/", known).map(
        ({ server, sameModel }) => [server.baseUrl, sameModel],
      ),
    ).toEqual([
      ["http://localhost:8030/v1", true],
      ["http://localhost:39459/v1", false],
      ["http://localhost:11434/v1", false],
    ]);
  });
});
