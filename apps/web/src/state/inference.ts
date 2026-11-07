import { createInferenceAtoms } from "@t3tools/client-runtime/state/inference";
import { makeLocalUsageModelsAtom } from "@t3tools/client-runtime/state/provider-instance-display";

import { serverEnvironment } from "./server";

export const {
  threadInferenceWaitAtom,
  hasInferenceServersAtom,
  environmentsWithInferenceServersAtom,
  hasEnabledInferenceServerAtom,
  inferenceUsageAtom,
  threadInferenceRequestAtom,
  threadInferenceStopAtom,
} = createInferenceAtoms(serverEnvironment);

/** Local models and the ones priced by the user, across the environments (ids as a JSON array). */
export const localUsageModelsAtom = makeLocalUsageModelsAtom(serverEnvironment);
