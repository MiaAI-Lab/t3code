import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, InferenceUsageRow, InferenceUsageWindow } from "@t3tools/contracts";
import { formatCount, formatTokens } from "@t3tools/shared/usageFormat";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { useState } from "react";

import {
  MISSING_MEASUREMENT,
  cachedPromptShare,
  formatCachedShare,
  formatMeasuredSeconds,
  formatTokensPerSecond,
} from "../../lib/inferenceMetrics";
import { cn } from "../../lib/utils";
import { environmentsWithInferenceServersAtom, inferenceUsageAtom } from "../../state/inference";
import { serverEnvironment } from "../../state/server";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  INFERENCE_PURPOSE_LABELS,
  LOCAL_COMPUTE_WINDOW_LABELS,
  groupLocalCompute,
  type LocalComputeTotals,
} from "./UsageLocalCompute.logic";

const WINDOWS: ReadonlyArray<InferenceUsageWindow> = ["24h", "7d"];
const COLUMN_COUNT = 7;

/** Requests T3's gateway sent to this user's own inference servers. */
export function UsageLocalCompute({
  environments,
  initialWindow,
}: {
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }>;
  readonly initialWindow: InferenceUsageWindow;
}) {
  const [window, setWindow] = useState(initialWindow);
  const withServers = useAtomValue(
    environmentsWithInferenceServersAtom(
      JSON.stringify(environments.map((environment) => environment.environmentId)),
    ),
  );
  if (withServers.length === 0) return null;
  const shown = environments.filter((environment) =>
    withServers.includes(environment.environmentId),
  );
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium text-foreground">Local compute</h2>
        <ToggleGroup
          aria-label="Local compute period"
          variant="segmented"
          value={[window]}
          onValueChange={(next) => {
            const value = next[0];
            if (value === "24h" || value === "7d") setWindow(value);
          }}
        >
          {WINDOWS.map((option) => (
            <Toggle key={option} value={option}>
              {option}
            </Toggle>
          ))}
        </ToggleGroup>
      </div>
      {shown.map((environment) => (
        <EnvironmentLocalCompute
          key={environment.environmentId}
          environmentId={environment.environmentId}
          label={shown.length > 1 ? environment.label : null}
          window={window}
        />
      ))}
      <p className="text-xs text-muted-foreground">
        Measured by T3&apos;s gateway; tools calling your server directly are not counted.
      </p>
    </section>
  );
}

function EnvironmentLocalCompute({
  environmentId,
  label,
  window,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string | null;
  readonly window: InferenceUsageWindow;
}) {
  const canRead = useAtomValue(serverEnvironment.getInferenceUsage.permissionAtom(environmentId));
  return (
    <div className="flex flex-col gap-1">
      {label ? <h3 className="text-xs font-medium text-muted-foreground">{label}</h3> : null}
      {canRead ? (
        <LocalComputeTable environmentId={environmentId} window={window} />
      ) : (
        <p className="py-4 text-sm text-muted-foreground">
          This connection cannot read local compute usage.
        </p>
      )}
    </div>
  );
}

function LocalComputeTable({
  environmentId,
  window,
}: {
  readonly environmentId: EnvironmentId;
  readonly window: InferenceUsageWindow;
}) {
  const result = useAtomValue(inferenceUsageAtom({ environmentId, window }));
  const servers = useAtomValue(serverEnvironment.inferenceServersValueAtom(environmentId));
  const summary = AsyncResult.getOrElse(result, () => null);
  const groups = summary === null ? [] : groupLocalCompute(summary.rows, servers);
  const message =
    summary !== null
      ? groups.length === 0
        ? `No requests through T3 in the last ${LOCAL_COMPUTE_WINDOW_LABELS[window]}.`
        : null
      : result._tag === "Failure"
        ? "This environment could not report local compute usage."
        : "Loading…";
  return (
    <div
      className="overflow-x-auto outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      role="region"
      aria-label="Local compute by server and model"
      aria-busy={result.waiting}
      tabIndex={0}
    >
      <table className="w-full text-sm whitespace-nowrap">
        <thead>
          <tr className="border-b border-border text-right text-xs text-muted-foreground">
            <th className="py-2 pl-2 text-left font-normal">Server · model</th>
            <th className="py-2 pl-4 font-normal">Requests (failed)</th>
            <th className="py-2 pl-4 font-normal">Prompt (cached)</th>
            <th className="py-2 pl-4 font-normal">Output</th>
            <th className="py-2 pl-4 font-normal">TTFT p50 / p95</th>
            <th className="py-2 pl-4 font-normal">Decode p50</th>
            <th className="py-2 pr-2 pl-4 font-normal">Queue wait p50 / p95</th>
          </tr>
        </thead>
        <tbody>
          {message !== null ? (
            <tr>
              <td colSpan={COLUMN_COUNT} className="py-6 text-center text-muted-foreground">
                {message}
              </td>
            </tr>
          ) : (
            groups.map((group) => (
              <LocalComputeGroupRows
                key={group.key}
                name={`${group.serverName} · ${group.model}`}
                totals={group.totals}
                rows={group.rows}
              />
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function LocalComputeGroupRows({
  name,
  totals,
  rows,
}: {
  readonly name: string;
  readonly totals: LocalComputeTotals;
  readonly rows: ReadonlyArray<InferenceUsageRow>;
}) {
  const single = rows.length === 1 ? rows[0]! : null;
  return (
    <>
      <tr className="border-b border-border/50 text-right text-muted-foreground tabular-nums">
        <td className="py-2 pl-2 text-left text-foreground">
          {name}
          {single ? (
            <span className="ms-2 text-xs text-muted-foreground">
              {INFERENCE_PURPOSE_LABELS[single.purpose]}
            </span>
          ) : null}
        </td>
        <CountCells totals={totals} />
        {single ? (
          <MeasuredCells row={single} />
        ) : (
          <td colSpan={3} className="py-2 pr-2 pl-4 text-xs">
            By purpose below
          </td>
        )}
      </tr>
      {single
        ? null
        : rows.map((row) => (
            <tr
              key={row.purpose}
              className="border-b border-border/50 text-right text-muted-foreground tabular-nums"
            >
              <td className="py-1.5 pl-6 text-left text-xs">
                {INFERENCE_PURPOSE_LABELS[row.purpose]}
              </td>
              <CountCells totals={row} />
              <MeasuredCells row={row} />
            </tr>
          ))}
    </>
  );
}

function CountCells({ totals }: { readonly totals: LocalComputeTotals }) {
  const cached = formatCachedShare(
    cachedPromptShare(totals.promptTokens, totals.cachedPromptTokens),
  );
  return (
    <>
      <td className="py-2 pl-4">
        {formatCount(totals.requests)}
        <span className={cn("ms-1 text-xs", totals.failed > 0 && "text-warning-foreground")}>
          ({formatCount(totals.failed)})
        </span>
      </td>
      <td className="py-2 pl-4">
        {formatTokens(totals.promptTokens)}
        <span className="ms-1 text-xs">({cached})</span>
      </td>
      <td className="py-2 pl-4">{formatTokens(totals.completionTokens)}</td>
    </>
  );
}

function MeasuredCells({ row }: { readonly row: InferenceUsageRow }) {
  return (
    <>
      <DistributionCell
        n={row.ttftMs.n}
        value={`${formatMeasuredSeconds(row.ttftMs.p50)} / ${formatMeasuredSeconds(row.ttftMs.p95)}`}
      />
      <DistributionCell
        n={row.decodeTokensPerSecond.n}
        value={formatTokensPerSecond(row.decodeTokensPerSecond.p50)}
      />
      <DistributionCell
        n={row.queueWaitMs.n}
        value={`${formatMeasuredSeconds(row.queueWaitMs.p50)} / ${formatMeasuredSeconds(row.queueWaitMs.p95)}`}
        last
      />
    </>
  );
}

function DistributionCell({
  value,
  n,
  last = false,
}: {
  readonly value: string;
  readonly n: number;
  readonly last?: boolean;
}) {
  return (
    <td className={cn("py-2 pl-4", last && "pr-2")}>
      {n === 0 ? MISSING_MEASUREMENT : value}
      <span className="ms-1 text-xs text-muted-foreground/70">n={formatCount(n)}</span>
    </td>
  );
}
