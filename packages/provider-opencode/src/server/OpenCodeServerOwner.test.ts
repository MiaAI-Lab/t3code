import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vite-plus/test";

import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";
import * as OpenCodeServerOwner from "./OpenCodeServerOwner.ts";

const unusedRuntimeMethod = () =>
  Effect.fail(
    new OpenCodeRuntime.OpenCodeRuntimeError({
      operation: "unused",
      detail: "unused test method",
    }),
  );

const makeRuntime = Effect.gen(function* () {
  const starts = yield* Ref.make(0);
  const closes = yield* Ref.make(0);
  const failNextStart = yield* Ref.make(false);
  const started = yield* Deferred.make<void>();
  const closed = yield* Deferred.make<void>();
  const environments = yield* Ref.make<ReadonlyArray<NodeJS.ProcessEnv | undefined>>([]);
  const runtime: OpenCodeRuntime.OpenCodeRuntime["Service"] = {
    startOpenCodeServerProcess: (input) =>
      Effect.gen(function* () {
        yield* Ref.update(environments, (seen) => [...seen, input.environment]);
        if (yield* Ref.getAndSet(failNextStart, false)) {
          return yield* new OpenCodeRuntime.OpenCodeRuntimeError({
            operation: "startOpenCodeServerProcess",
            detail: "start failed",
          });
        }
        const index = yield* Ref.updateAndGet(starts, (count) => count + 1);
        yield* Deferred.succeed(started, undefined).pipe(Effect.ignore);
        yield* Effect.addFinalizer(() =>
          Ref.update(closes, (count) => count + 1).pipe(
            Effect.andThen(Deferred.succeed(closed, undefined)),
            Effect.ignore,
          ),
        );
        return {
          url: `http://127.0.0.1:${index}`,
          version: "1.14.19",
          isRunning: Effect.succeed(true),
          exitCode: Effect.never,
        };
      }),
    connectToOpenCodeServer: unusedRuntimeMethod,
    runOpenCodeCommand: unusedRuntimeMethod,
    createOpenCodeSdkClient: () => ({}) as never,
    loadOpenCodeInventory: unusedRuntimeMethod,
    loadOpenCodeSkills: unusedRuntimeMethod,
  };
  return { runtime, starts, closes, failNextStart, started, closed, environments };
});

it.effect("shares concurrent borrowers and closes after the idle TTL", () =>
  Effect.gen(function* () {
    const testRuntime = yield* makeRuntime;
    const release = yield* Deferred.make<void>();
    const held = yield* Ref.make(0);
    yield* Effect.scoped(
      Effect.gen(function* () {
        const owner = yield* OpenCodeServerOwner.make({
          binaryPath: "opencode",
          directory: "/project",
          environment: { BASE: "1" },
          // Stands in for a gateway credential: held exactly as long as the process.
          prepareEnvironment: (environment) =>
            Effect.acquireRelease(
              Ref.updateAndGet(held, (count) => count + 1),
              () => Ref.update(held, (count) => count - 1),
            ).pipe(Effect.map((token) => ({ ...environment, TOKEN: String(token) }))),
        });
        const useServer = owner.withServer((server) =>
          Deferred.await(release).pipe(Effect.as(server.url)),
        );
        const fibers = yield* Effect.all([useServer, useServer], {
          concurrency: "unbounded",
        }).pipe(Effect.forkChild);
        yield* Deferred.await(testRuntime.started);
        expect(yield* Ref.get(testRuntime.starts)).toBe(1);
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(fibers)).toEqual(["http://127.0.0.1:1", "http://127.0.0.1:1"]);
        expect(yield* Ref.get(testRuntime.environments)).toEqual([{ BASE: "1", TOKEN: "1" }]);
        expect(yield* Ref.get(held)).toBe(1);
        yield* TestClock.adjust(Duration.seconds(31));
        yield* Deferred.await(testRuntime.closed);
        expect(yield* Ref.get(testRuntime.closes)).toBe(1);
      }),
    ).pipe(Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, testRuntime.runtime));
    expect(yield* Ref.get(held)).toBe(0);
  }).pipe(Effect.provide(TestClock.layer())),
);

// A linked inference server can become ready, or change, after the shared process started.
it.effect("replaces an idle process whose environment key changed, but not a borrowed one", () =>
  Effect.gen(function* () {
    const testRuntime = yield* makeRuntime;
    const key = yield* Ref.make("unmanaged");
    yield* Effect.scoped(
      Effect.gen(function* () {
        const owner = yield* OpenCodeServerOwner.make({
          binaryPath: "opencode",
          directory: "/project",
          environmentKey: Ref.get(key),
        });
        const url = owner.withServer((server) => Effect.succeed(server.url));
        expect(yield* url).toBe("http://127.0.0.1:1");
        expect(yield* url).toBe("http://127.0.0.1:1");
        yield* Ref.set(key, "managed:rtx");
        const borrowed = yield* owner.withServer((server) =>
          Effect.gen(function* () {
            expect(server.url).toBe("http://127.0.0.1:2");
            yield* Ref.set(key, "managed:spark1");
            return yield* url;
          }),
        );
        expect(borrowed).toBe("http://127.0.0.1:2");
        expect(yield* url).toBe("http://127.0.0.1:3");
      }),
    ).pipe(Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, testRuntime.runtime));
    expect(yield* Ref.get(testRuntime.starts)).toBe(3);
    expect(yield* Ref.get(testRuntime.closes)).toBe(3);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("retries a failed start and closes on owner scope shutdown", () =>
  Effect.gen(function* () {
    const testRuntime = yield* makeRuntime;
    yield* Ref.set(testRuntime.failNextStart, true);
    yield* Effect.scoped(
      Effect.gen(function* () {
        const owner = yield* OpenCodeServerOwner.make({
          binaryPath: "opencode",
          directory: "/project",
        });
        expect(
          (yield* Effect.exit(owner.withServer((server) => Effect.succeed(server.url))))._tag,
        ).toBe("Failure");
        expect(yield* owner.withServer((server) => Effect.succeed(server.url))).toBe(
          "http://127.0.0.1:1",
        );
      }),
    ).pipe(Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, testRuntime.runtime));
    expect(yield* Ref.get(testRuntime.starts)).toBe(1);
    expect(yield* Ref.get(testRuntime.closes)).toBe(1);
  }),
);

it.effect("replaces a dead cached process before its exit watcher runs", () =>
  Effect.gen(function* () {
    const starts = yield* Ref.make(0);
    const closes = yield* Ref.make(0);
    const processRunning: Array<Ref.Ref<boolean>> = [];
    const runtime: OpenCodeRuntime.OpenCodeRuntime["Service"] = {
      startOpenCodeServerProcess: () =>
        Effect.gen(function* () {
          const index = yield* Ref.updateAndGet(starts, (count) => count + 1);
          const isRunning = yield* Ref.make(true);
          processRunning.push(isRunning);
          yield* Effect.addFinalizer(() => Ref.update(closes, (count) => count + 1));
          return {
            url: `http://127.0.0.1:${index}`,
            version: "1.14.19",
            isRunning: Ref.get(isRunning),
            exitCode: Effect.never,
          };
        }),
      connectToOpenCodeServer: unusedRuntimeMethod,
      runOpenCodeCommand: unusedRuntimeMethod,
      createOpenCodeSdkClient: () => ({}) as never,
      loadOpenCodeInventory: unusedRuntimeMethod,
      loadOpenCodeSkills: unusedRuntimeMethod,
    };

    yield* Effect.scoped(
      Effect.gen(function* () {
        const owner = yield* OpenCodeServerOwner.make({
          binaryPath: "opencode",
          directory: "/project",
        });
        expect(yield* owner.withServer((server) => Effect.succeed(server.url))).toBe(
          "http://127.0.0.1:1",
        );
        yield* Ref.set(processRunning[0]!, false);

        expect(yield* owner.withServer((server) => Effect.succeed(server.url))).toBe(
          "http://127.0.0.1:2",
        );
        expect(yield* Ref.get(starts)).toBe(2);
        expect(yield* Ref.get(closes)).toBe(1);
      }),
    ).pipe(Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, runtime));
  }),
);

it.effect("cleans up an interrupted startup and allows a retry", () =>
  Effect.gen(function* () {
    const starts = yield* Ref.make(0);
    const firstStartEntered = yield* Deferred.make<void>();
    const firstStartClosed = yield* Deferred.make<void>();
    const runtime: OpenCodeRuntime.OpenCodeRuntime["Service"] = {
      startOpenCodeServerProcess: () =>
        Effect.gen(function* () {
          const index = yield* Ref.updateAndGet(starts, (count) => count + 1);
          yield* Effect.addFinalizer(() =>
            index === 1
              ? Deferred.succeed(firstStartClosed, undefined).pipe(Effect.ignore)
              : Effect.void,
          );
          if (index === 1) {
            yield* Deferred.succeed(firstStartEntered, undefined);
            return yield* Effect.never;
          }
          return {
            url: `http://127.0.0.1:${index}`,
            version: "1.14.19",
            isRunning: Effect.succeed(true),
            exitCode: Effect.never,
          };
        }),
      connectToOpenCodeServer: unusedRuntimeMethod,
      runOpenCodeCommand: unusedRuntimeMethod,
      createOpenCodeSdkClient: () => ({}) as never,
      loadOpenCodeInventory: unusedRuntimeMethod,
      loadOpenCodeSkills: unusedRuntimeMethod,
    };

    yield* Effect.scoped(
      Effect.gen(function* () {
        const owner = yield* OpenCodeServerOwner.make({
          binaryPath: "opencode",
          directory: "/project",
        });
        const firstBorrower = yield* owner
          .withServer((server) => Effect.succeed(server.url))
          .pipe(Effect.forkChild);
        yield* Deferred.await(firstStartEntered);
        yield* Fiber.interrupt(firstBorrower);
        yield* Deferred.await(firstStartClosed);
        expect(yield* owner.withServer((server) => Effect.succeed(server.url))).toBe(
          "http://127.0.0.1:2",
        );
      }),
    ).pipe(Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, runtime));
  }),
);
