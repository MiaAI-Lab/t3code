import type { EnvironmentId, InferenceUsageWindow, ThreadId } from "@t3tools/contracts";
import {
  sameThreadInferenceWait,
  threadInferenceWait,
} from "@t3tools/client-runtime/state/inference-activity";
import { makeLocalUsageModelsAtom } from "@t3tools/client-runtime/state/provider-instance-display";
import { type AtomCommandResult, runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";

import { serverEnvironment } from "./server";

interface ThreadKey {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

/** Only this thread's place in a gateway queue, so queue pushes for other threads render nothing. */
export const threadInferenceWaitAtom = Atom.family(({ environmentId, threadId }: ThreadKey) =>
  Atom.make((get) =>
    threadInferenceWait(get(serverEnvironment.inferenceServersValueAtom(environmentId)), threadId),
  ).pipe(
    Atom.withEquality(sameThreadInferenceWait),
    Atom.withLabel(`inference-thread-wait:${environmentId}:${threadId}`),
  ),
);

/** Whether the environment has registered any inference server, which gateway reads depend on. */
export const hasInferenceServersAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get) => (get(serverEnvironment.inferenceServersValueAtom(environmentId))?.length ?? 0) > 0,
  ).pipe(Atom.withLabel(`inference-has-servers:${environmentId}`)),
);

/** Of the environments (ids as a JSON array), those with an inference server, in order. */
export const environmentsWithInferenceServersAtom = Atom.family((idsJson: string) =>
  Atom.make((get) =>
    (JSON.parse(idsJson) as EnvironmentId[]).filter((id) => get(hasInferenceServersAtom(id))),
  ).pipe(
    Atom.withEquality(
      (a: EnvironmentId[], b: EnvironmentId[]) =>
        a.length === b.length && a.every((id, index) => id === b[index]),
    ),
    Atom.withLabel(`inference-environments:${idsJson}`),
  ),
);

/** Whether any of the environments (ids as a JSON array) has an enabled inference server. */
export const hasEnabledInferenceServerAtom = Atom.family((idsJson: string) =>
  Atom.make((get) =>
    (JSON.parse(idsJson) as EnvironmentId[]).some((id) =>
      get(serverEnvironment.inferenceServersValueAtom(id))?.some((server) => server.enabled),
    ),
  ).pipe(Atom.withLabel(`inference-has-enabled-server:${idsJson}`)),
);

/** Local models and the ones priced by the user, across the environments (ids as a JSON array). */
export const localUsageModelsAtom = makeLocalUsageModelsAtom(serverEnvironment);

function settled<A, E>(result: AtomCommandResult<A, E>): Effect.Effect<A, E> {
  return result._tag === "Success" ? Effect.succeed(result.value) : Effect.failCause(result.cause);
}

/** Gateway usage for one window, read while mounted; switching windows keeps the other briefly. */
export const inferenceUsageAtom = Atom.family(
  ({
    environmentId,
    window,
  }: {
    readonly environmentId: EnvironmentId;
    readonly window: InferenceUsageWindow;
  }) =>
    Atom.make((get) =>
      Effect.promise(() =>
        runAtomCommand(
          get.registry,
          serverEnvironment.getInferenceUsage,
          { environmentId, input: { window } },
          { reportFailure: false },
        ),
      ).pipe(Effect.flatMap(settled)),
    ).pipe(Atom.setIdleTTL(60_000), Atom.withLabel(`inference-usage:${environmentId}:${window}`)),
);

/** The thread's latest gateway request, read each time thread details open. */
export const threadInferenceRequestAtom = Atom.family(({ environmentId, threadId }: ThreadKey) =>
  Atom.make((get) =>
    Effect.promise(() =>
      runAtomCommand(
        get.registry,
        serverEnvironment.getThreadInferenceRequest,
        { environmentId, input: { threadId } },
        { reportFailure: false },
      ),
    ).pipe(Effect.flatMap(settled)),
  ).pipe(Atom.withLabel(`inference-thread-request:${environmentId}:${threadId}`)),
);
