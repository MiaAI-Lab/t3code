import { it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as InferenceGateway from "@t3tools/provider-core/server/inferenceGateway";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";

import {
  makeOpenCodeGatewaySource,
  OPENCODE_GATEWAY_TOKEN_ENV,
  openCodeGatewayStatusNote,
  withOpenCodeGateway,
} from "./gateway.ts";

const server: InferenceGateway.ManagedInferenceServer = {
  serverId: "rtx",
  displayName: "rtx",
  models: [
    {
      id: "GLM-5.3-Flash",
      contextWindow: 813056,
      maxOutputTokens: 32768,
      reasoningEfforts: ["high"],
    },
    { id: "tiny" },
  ],
};
const credential = { serverId: "rtx", baseUrl: "http://t3/inference/rtx/v1", token: "secret" };
const instanceId = ProviderInstanceId.make("opencode_local");

it("adds the managed provider to the user's config overlay without writing the token into it", () => {
  const environment = withOpenCodeGateway(
    {
      PATH: "/bin",
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        model: "local/glm",
        provider: { local: { npm: "@ai-sdk/openai-compatible" } },
      }),
    },
    { server, credential },
  );
  expect(environment[OPENCODE_GATEWAY_TOKEN_ENV]).toBe("secret");
  expect(environment.OPENCODE_CONFIG_CONTENT).not.toContain("secret");
  expect(JSON.parse(environment.OPENCODE_CONFIG_CONTENT!)).toEqual({
    model: "local/glm",
    provider: {
      local: { npm: "@ai-sdk/openai-compatible" },
      "t3-rtx": {
        npm: "@ai-sdk/openai-compatible",
        name: "rtx (T3)",
        options: {
          baseURL: "http://t3/inference/rtx/v1",
          apiKey: `{env:${OPENCODE_GATEWAY_TOKEN_ENV}}`,
        },
        models: {
          "GLM-5.3-Flash": {
            name: "GLM-5.3-Flash",
            reasoning: true,
            limit: { context: 813056, output: 32768 },
          },
          tiny: { name: "tiny" },
        },
      },
    },
  });

  const unparseable = { OPENCODE_CONFIG_CONTENT: "{ // jsonc" };
  expect(withOpenCodeGateway(unparseable, { server, credential })).toBe(unparseable);
});

const access = (resolution: InferenceGateway.ManagedServerResolution) =>
  InferenceGateway.InferenceGatewayAccess.of({
    resolve: () => Effect.succeed(resolution),
    managedServer: () => Effect.succeed(resolution.managed ? resolution.server : undefined),
    backgroundCredential: () => Effect.die("unused"),
    instanceCredential: (id, protocol) =>
      Effect.succeed(
        resolution.managed && protocol === "chat-completions"
          ? { server: resolution.server, credential: { ...credential, token: `held:${id}` } }
          : undefined,
      ),
  });

it.effect("an OpenCode process holds an instance credential; a thread process uses its own", () =>
  Effect.gen(function* () {
    const source = yield* makeOpenCodeGatewaySource(instanceId).pipe(
      Effect.provideService(
        InferenceGateway.InferenceGatewayAccess,
        access({ managed: true, server }),
      ),
    );
    const shared = yield* Effect.scoped(source.forProcess({}));
    expect(shared[OPENCODE_GATEWAY_TOKEN_ENV]).toBe(`held:${instanceId}`);

    const session = { inferenceGateway: credential } as Parameters<typeof source.forSession>[1];
    expect((yield* source.forSession({}, session))[OPENCODE_GATEWAY_TOKEN_ENV]).toBe("secret");
    const otherServer = {
      inferenceGateway: { ...credential, serverId: "spark1" },
    } as typeof session;
    expect(yield* source.forSession({}, otherServer)).toEqual({});

    const missing = yield* makeOpenCodeGatewaySource(instanceId).pipe(
      Effect.provideService(
        InferenceGateway.InferenceGatewayAccess,
        access({ managed: false, reason: "Inference server rtx does not serve it." }),
      ),
    );
    expect(yield* Effect.scoped(missing.forProcess({ A: "1" }))).toEqual({ A: "1" });
    expect(yield* missing.forSession({}, session)).toEqual({});
  }),
);

it("the status says what T3 manages, or why not", () => {
  expect(openCodeGatewayStatusNote(undefined, false)).toBeUndefined();
  expect(openCodeGatewayStatusNote({ managed: true, server }, false)).toBe(
    "T3 Code manages t3-rtx with 2 models.",
  );
  expect(openCodeGatewayStatusNote({ managed: false, reason: "No Chat API." }, false)).toBe(
    "No Chat API. OpenCode runs unmanaged.",
  );
  expect(openCodeGatewayStatusNote({ managed: true, server }, true)).toContain(
    "clear the server URL",
  );
});
