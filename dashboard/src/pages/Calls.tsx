import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ArrowRight, ChevronLeft, ChevronRight, Loader2, Mic, PhoneCall, SearchX } from "lucide-react";
import { useCallback, useEffect, useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { callHref, CallTable } from "@/components/calls/CallTable";
import {
  DEFAULT_FILTERS,
  hasActiveFilters,
  PAGE_SIZE,
  pageWindow,
  parseFilters,
  rangeBounds,
  rangeLabel,
  serializeFilters,
  toSearchParams,
  type CallFilters,
} from "@/components/calls/callFilters";
import { Filters } from "@/components/calls/Filters";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { formatCount } from "@/lib/format";
import { qk, searchCalls } from "@/lib/queries";
import { useRealtimeRows } from "@/lib/realtime";
import { useEasternToday } from "@/lib/useEasternToday";

/**
 * Every call, newest first. Filters and search live in the URL, the list comes from the
 * search_calls RPC (server pagination with a total count; transcript and messages are never
 * selected for the list), and Realtime on call_interactions re-reads the page when a call
 * starts, updates or ends.
 */
export default function Calls() {
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => parseFilters(params), [params]);
  // Bounds are computed once per range choice so the query key stays stable between renders,
  // and again when the Eastern day changes, the same moment the Overview tiles roll over.
  const today = useEasternToday();
  const bounds = useMemo(
    () => rangeBounds(filters.range, new Date(), filters.custom),
    // `today` is a dependency on purpose: a preset's edges move at Eastern midnight.
    [filters.range, filters.custom?.from, filters.custom?.to, today],
  );
  const search = useMemo(() => toSearchParams(filters, bounds), [filters, bounds]);

  const update = useCallback(
    (patch: Partial<CallFilters>) => {
      // Any filter change starts again at the first page; paging passes its own page.
      const next: CallFilters = { ...filters, ...patch, page: patch.page ?? 0 };
      setParams(serializeFilters(next), { replace: true });
    },
    [filters, setParams],
  );
  const reset = useCallback(() => setParams(serializeFilters(DEFAULT_FILTERS), { replace: true }), [setParams]);

  const query = useQuery({
    queryKey: qk.callList(search),
    queryFn: () => searchCalls(search),
    placeholderData: keepPreviousData,
  });
  useRealtimeRows("call_interactions", null, [qk.calls()]);

  const rows = query.data?.rows ?? [];
  const total = query.data?.total ?? null;
  const settled = query.data !== undefined && !query.isPlaceholderData;

  // An out-of-range page comes back empty with no total; go back to the first page.
  useEffect(() => {
    if (settled && filters.page > 0 && rows.length === 0) update({ page: 0 });
  }, [settled, filters.page, rows.length, update]);

  const exact = filters.q && rows.find((r) => r.vapi_call_id === filters.q);
  const rangeText = rangeLabel(filters);
  const win = pageWindow(filters.page, rows.length, total);
  const pages = total ? Math.max(1, Math.ceil(total / PAGE_SIZE)) : 1;
  const isEmpty = settled && rows.length === 0 && filters.page === 0;

  return (
    <>
      <PageHeader
        title="Calls"
        description="Every call Tessa handled, newest first. Search covers redacted transcripts, summaries, caller names and call ids."
      />

      <Filters value={filters} onChange={update} onReset={reset} />

      {exact && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-primary/40 bg-accent-wash px-4 py-2.5 text-sm">
          <span className="text-ink-1">This search matches a call id exactly.</span>
          <Button asChild size="sm">
            <Link to={callHref(exact.vapi_call_id)}>
              Open call
              <ArrowRight aria-hidden="true" />
            </Link>
          </Button>
        </div>
      )}

      <Card className="mt-4 overflow-hidden">
        <div className="flex min-h-11 flex-wrap items-center justify-between gap-2 border-b px-4 py-2 sm:px-5">
          <p className="text-sm text-ink-2" aria-live="polite">
            {query.isLoading ? (
              "Loading calls"
            ) : query.isError ? (
              "Calls could not be loaded"
            ) : (
              <>
                <span className="font-medium tabular text-ink-1">{formatCount(total ?? 0)}</span> {total === 1 ? "call" : "calls"}
                {filters.q && (
                  <>
                    {" "}
                    matching <span className="font-medium text-ink-1">&ldquo;{filters.q}&rdquo;</span>
                  </>
                )}
                <span className="text-ink-3"> · {rangeText}</span>
              </>
            )}
          </p>
          {query.isFetching && !query.isLoading && (
            <span className="inline-flex items-center gap-1.5 text-xs text-ink-3">
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              Updating
            </span>
          )}
        </div>

        {query.isError && !query.data ? (
          <ErrorState title="Could not load calls" error={query.error} onRetry={() => void query.refetch()} />
        ) : isEmpty ? (
          <EmptyState
            icon={filters.q ? SearchX : PhoneCall}
            title={filters.q ? `No calls match “${filters.q}”` : hasActiveFilters(filters) ? "No calls match these filters" : "No calls in this range"}
            description={
              filters.q
                ? "Search matches words in redacted transcripts and summaries, part of a caller name, or the start of a call id. Try All time or fewer filters."
                : "Start a web call from Talk to Tessa and it appears here within seconds."
            }
            action={
              <div className="flex flex-wrap justify-center gap-2">
                {hasActiveFilters(filters) && (
                  <Button variant="outline" size="sm" onClick={reset}>
                    Clear filters
                  </Button>
                )}
                {filters.range !== "all" && (
                  <Button variant="outline" size="sm" onClick={() => update({ range: "all", custom: null })}>
                    Show all time
                  </Button>
                )}
                {!filters.q && (
                  <Button asChild size="sm">
                    <Link to="/call">
                      <Mic aria-hidden="true" />
                      Talk to Tessa
                    </Link>
                  </Button>
                )}
              </div>
            }
          />
        ) : (
          <CallTable rows={rows} loading={query.isLoading} fetching={query.isPlaceholderData} />
        )}

        {/* Kept mounted while the next page loads (placeholder rows on screen): unmounting the
            pager would drop the focus of the button that was just pressed. */}
        {query.data !== undefined && rows.length > 0 && (
          <nav aria-label="Pagination" className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-2.5 sm:px-5">
            <p className="text-xs tabular text-ink-3">
              Showing {formatCount(win.first)}–{formatCount(win.last)} of {formatCount(win.total)}
            </p>
            <div className="flex items-center gap-2">
              <span className="hidden text-xs tabular text-ink-3 sm:inline">
                Page {filters.page + 1} of {pages}
              </span>
              <Button
                variant="outline"
                size="sm"
                // Disabled only at the ends: disabling while fetching would drop keyboard focus
                // to the page on every press. A press during the fetch just moves one more page.
                onClick={() => update({ page: filters.page - 1 })}
                disabled={filters.page === 0}
                aria-label="Previous page"
              >
                <ChevronLeft aria-hidden="true" />
                <span className="hidden min-[420px]:inline">Previous</span>
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => update({ page: filters.page + 1 })}
                disabled={filters.page + 1 >= pages}
                aria-label="Next page"
              >
                <span className="hidden min-[420px]:inline">Next</span>
                <ChevronRight aria-hidden="true" />
              </Button>
            </div>
          </nav>
        )}
      </Card>
    </>
  );
}
