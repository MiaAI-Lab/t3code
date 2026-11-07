import type { EnvironmentId, InferenceUsageWindow, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";

import { sameThreadInferenceWait, threadInferenceWait } from "./inferenceActivity.ts";
import { type AtomCommandResult, runAtomCommand } from "./runtime.ts";
import type { createServerEnvironmentAtoms } from "./server.ts";

type ServerEnvironmentAtoms<R, E> = Pick<
  ReturnType<typeof createServerEnvironmentAtoms<R, E>>,
  "inferenceServersValueAtom" | "getInferenceUsage" | "getThreadInferenceRequest"
>;

interface ThreadKey {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

function settled<A, E>(result: AtomCommandResult<A, E>): Effect.Effect<A, E> {
  return result._tag === "Success" ? Effect.succeed(result.value) : Effect.failCause(result.cause);
}

/** Inference reads each client binds to its own server environment atoms. */
export function createInferenceAtoms<R, E>(server: ServerEnvironmentAtoms<R, E>) {
  /** Only this thread's place in a gateway queue, so queue pushes for other threads render nothing. */
  const threadInferenceWaitAtom = Atom.family(({ environmentId, threadId }: ThreadKey) =>
    Atom.make((get) =>
      threadInferenceWait(get(server.inferenceServersValueAtom(environmentId)), threadId),
    ).pipe(
      Atom.withEquality(sameThreadInferenceWait),
      Atom.withLabel(`inference-thread-wait:${environmentId}:${threadId}`),
    ),
  );

  /** Whether the environment has registered any inference server, which gateway reads depend on. */
  const hasInferenceServersAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(
      (get) => (get(server.inferenceServersValueAtom(environmentId))?.length ?? 0) > 0,
    ).pipe(Atom.withLabel(`inference-has-servers:${environmentId}`)),
  );

  /** Of the environments (ids as a JSON array), those with an inference server, in order. */
  const environmentsWithInferenceServersAtom = Atom.family((idsJson: string) =>
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
  const hasEnabledInferenceServerAtom = Atom.family((idsJson: string) =>
    Atom.make((get) =>
      (JSON.parse(idsJson) as EnvironmentId[]).some((id) =>
        get(server.inferenceServersValueAtom(id))?.some((snapshot) => snapshot.enabled),
      ),
    ).pipe(Atom.withLabel(`inference-has-enabled-server:${idsJson}`)),
  );

  /** Gateway usage for one window, read while mounted; switching windows keeps the other briefly. */
  const inferenceUsageAtom = Atom.family(
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
            server.getInferenceUsage,
            { environmentId, input: { window } },
            { reportFailure: false },
          ),
        ).pipe(Effect.flatMap(settled)),
      ).pipe(Atom.setIdleTTL(60_000), Atom.withLabel(`inference-usage:${environmentId}:${window}`)),
  );

  /** The thread's latest gateway request, read each time thread details open. */
  const threadInferenceRequestAtom = Atom.family(({ environmentId, threadId }: ThreadKey) =>
    Atom.make((get) =>
      Effect.promise(() =>
        runAtomCommand(
          get.registry,
          server.getThreadInferenceRequest,
          { environmentId, input: { threadId } },
          { reportFailure: false },
        ),
      ).pipe(Effect.flatMap(settled)),
    ).pipe(Atom.withLabel(`inference-thread-request:${environmentId}:${threadId}`)),
  );

  return {
    threadInferenceWaitAtom,
    hasInferenceServersAtom,
    environmentsWithInferenceServersAtom,
    hasEnabledInferenceServerAtom,
    inferenceUsageAtom,
    threadInferenceRequestAtom,
  };
}
