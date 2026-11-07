import type { EnvironmentId, InferenceStopReason, ThreadId } from "@t3tools/contracts";
import type { ThreadRunSummary } from "@t3tools/client-runtime/state/models";
import { useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { Atom } from "effect/reactivity";
import { OctagonPauseIcon } from "lucide-react";

import { threadInferenceStopAtom } from "../../state/inference";
import { Button } from "../ui/button";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

const NO_STOP = Atom.make(AsyncResult.initial<{ readonly stop: null }>());

const TITLES: Record<InferenceStopReason, string> = {
  loop: "Stopped a looping reply",
  "reasoning-limit": "Stopped a reply that only reasoned",
  idle: "Stopped a reply that went silent",
};

const WHY: Record<InferenceStopReason, string> = {
  loop: "kept repeating the same text",
  "reasoning-limit": "reasoned at length without answering",
  idle: "stopped sending anything",
};

// A run that is still going may yet recover; the notice waits for it to end.
const SETTLED_RUN: ReadonlySet<ThreadRunSummary["status"]> = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
]);

/** After T3's gateway stopped a runaway reply in the thread's latest run: why, and what next. */
export function useInferenceStopBannerItem(
  environmentId: EnvironmentId,
  threadId: ThreadId | undefined,
  latestRun: ThreadRunSummary | null | undefined,
  onContinue: () => void,
  onChooseModel: () => void,
): ComposerBannerStackItem | null {
  const runKey = latestRun ? `${latestRun.runId}:${latestRun.status}` : "none";
  const result = useAtomValue(
    threadId === undefined || latestRun == null
      ? NO_STOP
      : threadInferenceStopAtom({ environmentId, threadId, runKey }),
  );
  const stop = AsyncResult.getOrElse(result, () => null)?.stop ?? null;
  if (
    stop === null ||
    latestRun == null ||
    latestRun.startedAt === null ||
    !SETTLED_RUN.has(latestRun.status) ||
    Date.parse(stop.at) < Date.parse(latestRun.startedAt)
  ) {
    return null;
  }
  return {
    id: `inference-stop:${latestRun.runId}`,
    group: "attention",
    variant: "warning",
    icon: <OctagonPauseIcon />,
    title: TITLES[stop.reason],
    description: `${stop.model} on ${stop.serverId} ${WHY[stop.reason]}, so T3 Code stopped it and freed the server.`,
    actions: (
      <>
        <Button size="xs" variant="ghost" onClick={onContinue}>
          Continue
        </Button>
        <Button size="xs" variant="ghost" onClick={onChooseModel}>
          Choose model
        </Button>
      </>
    ),
  };
}
