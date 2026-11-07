import type { InferenceModelImageSupport } from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { ServerConfig } from "../config.ts";

const MAX_REMEMBERED = 500;

const Verdict = Schema.Struct({ supported: Schema.Boolean, checkedAt: Schema.String });
type Verdict = typeof Verdict.Type;
const decodeFile = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Verdict)),
);

/** What T3's image checks found, by server address and model, kept across restarts. */
export class InferenceImageVerdicts extends Context.Service<
  InferenceImageVerdicts,
  {
    /** Verdicts for the models at `address`; clients show their age and offer to check again. */
    readonly forAddress: (
      address: string,
    ) => Effect.Effect<(model: string) => InferenceModelImageSupport | undefined>;
    readonly record: (address: string, model: string, supported: boolean) => Effect.Effect<void>;
  }
>()("t3/inference/InferenceImageVerdicts") {}

const keyOf = (address: string, model: string) => JSON.stringify([address, model]);

const makeWith = Effect.fn("InferenceImageVerdicts.make")(function* (
  initial: ReadonlyMap<string, Verdict>,
  persist: (all: ReadonlyMap<string, Verdict>) => Effect.Effect<void>,
) {
  const verdicts = yield* Ref.make(initial);
  // Updates and their writes go one at a time, so an older write never lands last.
  const writes = yield* Semaphore.make(1);
  return InferenceImageVerdicts.of({
    forAddress: Effect.fn("InferenceImageVerdicts.forAddress")(function* (address) {
      const all = yield* Ref.get(verdicts);
      return (model) => {
        const verdict = all.get(keyOf(address, model));
        return verdict === undefined
          ? undefined
          : { supported: verdict.supported, source: "checked", checkedAt: verdict.checkedAt };
      };
    }),
    record: Effect.fn("InferenceImageVerdicts.record")(
      function* (address, model, supported) {
        const checkedAt = DateTime.formatIso(yield* DateTime.now);
        const key = keyOf(address, model);
        const next = yield* Ref.updateAndGet(verdicts, (all) => {
          const updated = new Map(all);
          updated.delete(key);
          updated.set(key, { supported, checkedAt });
          while (updated.size > MAX_REMEMBERED) updated.delete(updated.keys().next().value!);
          return updated;
        });
        yield* persist(next);
      },
      (effect) => writes.withPermits(1)(effect),
    ),
  });
});

export const layer = Layer.effect(
  InferenceImageVerdicts,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const services =
      yield* Effect.context<Effect.Services<ReturnType<typeof writeFileStringAtomically>>>();
    const filePath = path.join(config.providerStatusCacheDir, "inference-image-checks.json");
    const stored = yield* fs.readFileString(filePath).pipe(Effect.option);
    const initial = stored._tag === "Some" ? decodeFile(stored.value) : { _tag: "None" as const };
    return yield* makeWith(
      new Map(initial._tag === "Some" ? Object.entries(initial.value) : []),
      (all) =>
        writeFileStringAtomically({
          filePath,
          contents: `${JSON.stringify(Object.fromEntries(all))}\n`,
        }).pipe(
          Effect.provide(services),
          // A lost write only means the model is checked again after a restart.
          Effect.ignore({ log: true }),
        ),
    );
  }),
);

/** Keeps verdicts in memory only, for tests. */
export const layerMemory = Layer.effect(
  InferenceImageVerdicts,
  makeWith(new Map(), () => Effect.void),
);
