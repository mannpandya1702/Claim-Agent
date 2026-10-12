import { CircleCheck, Loader2, OctagonAlert } from "lucide-react";
import { useMediaQuery } from "@/components/calls/hooks";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DASH, formatDateTime, formatDateTimeLong } from "@/lib/format";
import type { JobRun } from "@/lib/types";
import { cn } from "@/lib/utils";
import { jobLabel, runDuration, runState, summariseResult, type RunState } from "./health";

interface JobRunsTableProps {
  runs: readonly JobRun[];
  now: Date;
  loading?: boolean;
  /** Refetch with rows on screen: hold the frame at reduced opacity instead of flashing. */
  fetching?: boolean;
}

function RunBadge({ state }: { state: RunState }) {
  if (state === "finished") {
    return (
      <Badge variant="good">
        <CircleCheck aria-hidden="true" />
        Finished
      </Badge>
    );
  }
  if (state === "running") {
    return (
      <Badge variant="muted">
        <Loader2 className="animate-spin" aria-hidden="true" />
        Running
      </Badge>
    );
  }
  return (
    <Badge variant="critical">
      <OctagonAlert aria-hidden="true" />
      Did not finish
    </Badge>
  );
}

function ResultCell({ result }: { result: unknown }) {
  const { parts, more } = summariseResult(result);
  if (parts.length === 0 && !more) return <span className="text-ink-3">{DASH}</span>;
  return (
    <div className="min-w-0 space-y-1">
      {parts.length > 0 && <p className="text-xs text-ink-2">{parts.join(" · ")}</p>}
      {more && (
        <details className="text-xs">
          <summary className="cursor-pointer rounded-sm text-link outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
            Full result
          </summary>
          <pre className="mt-1 max-h-48 max-w-[28rem] overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2 font-mono text-[11px] text-ink-2">
            {JSON.stringify(result, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}

/**
 * Recent job_runs, newest first. One row per (job, period): a re-fire in the same period is a
 * no-op, so the period key sits under the job name. Below 640px the table becomes a list.
 */
export function JobRunsTable({ runs, now, loading = false, fetching = false }: JobRunsTableProps) {
  const compact = useMediaQuery("(max-width: 639px)");
  if (compact) return <JobRunsList runs={runs} now={now} loading={loading} fetching={fetching} />;

  return (
    <div className={cn("transition-opacity", fetching && "opacity-60")} aria-busy={loading || fetching || undefined}>
      <Table>
        <TableCaption className="sr-only">Recent scheduled job runs, newest first. Times are Eastern.</TableCaption>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead scope="col" className="pl-4 sm:pl-5">Job and period</TableHead>
            <TableHead scope="col">Started</TableHead>
            <TableHead scope="col" className="text-right">Duration</TableHead>
            <TableHead scope="col">Status</TableHead>
            <TableHead scope="col" className="pr-4 sm:pr-5">Result</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading
            ? Array.from({ length: 5 }, (_, i) => (
                <TableRow key={i} className="hover:bg-transparent">
                  <TableCell className="pl-4 sm:pl-5"><Skeleton className="h-4 w-28" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-28" /></TableCell>
                  <TableCell><Skeleton className="ml-auto h-4 w-12" /></TableCell>
                  <TableCell><Skeleton className="h-5 w-20" /></TableCell>
                  <TableCell className="pr-4 sm:pr-5"><Skeleton className="h-4 w-40" /></TableCell>
                </TableRow>
              ))
            : runs.map((run) => {
                const state = runState(run, now);
                return (
                  <TableRow key={`${run.job}:${run.period_key}`} data-job={run.job} data-state={state}>
                    <TableCell className="pl-4 sm:pl-5">
                      <span className="block whitespace-nowrap font-medium text-ink-1">{jobLabel(run.job)}</span>
                      <span className="block whitespace-nowrap font-mono text-[11px] text-ink-3">{run.period_key}</span>
                    </TableCell>
                    <TableCell className="whitespace-nowrap tabular text-ink-2">
                      <time dateTime={run.started_at} title={formatDateTimeLong(run.started_at)}>
                        {formatDateTime(run.started_at)}
                      </time>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right tabular text-ink-2">{runDuration(run) ?? DASH}</TableCell>
                    <TableCell>
                      <RunBadge state={state} />
                    </TableCell>
                    <TableCell className="min-w-[10rem] pr-4 sm:pr-5">
                      <ResultCell result={run.result} />
                    </TableCell>
                  </TableRow>
                );
              })}
        </TableBody>
      </Table>
    </div>
  );
}

function JobRunsList({ runs, now, loading, fetching }: Required<JobRunsTableProps>) {
  if (loading) {
    return (
      <div className="space-y-3 p-4" aria-hidden="true">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    );
  }
  return (
    <ul aria-label="Recent scheduled job runs, newest first" className={cn("divide-y transition-opacity", fetching && "opacity-60")}>
      {runs.map((run) => {
        const state = runState(run, now);
        const duration = runDuration(run);
        return (
          <li key={`${run.job}:${run.period_key}`} className="space-y-1.5 px-4 py-3" data-job={run.job} data-state={state}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="font-medium text-ink-1">{jobLabel(run.job)}</p>
                <p className="truncate font-mono text-[11px] text-ink-3">{run.period_key}</p>
              </div>
              <RunBadge state={state} />
            </div>
            <p className="text-xs tabular text-ink-2">
              <time dateTime={run.started_at} title={formatDateTimeLong(run.started_at)}>
                {formatDateTime(run.started_at)}
              </time>
              {duration && <> · {duration}</>}
            </p>
            <ResultCell result={run.result} />
          </li>
        );
      })}
    </ul>
  );
}
