import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { CircleCheck, FilterX, Inbox, UserCheck } from "lucide-react";
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useNow } from "@/components/calls/hooks";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { escalationKeys, fetchEscalationCounts, fetchEscalationEmails } from "@/components/escalations/data";
import { EscalationQueue, QUEUE_PAGE_SIZE } from "@/components/escalations/EscalationQueue";
import { callKeysOf, parseKind, parseTab, QUEUE_TABS, summariseOpen, visibleRows, type KindFilter, type QueueTab } from "@/components/escalations/queue";
import { QueueSummary } from "@/components/escalations/QueueSummary";
import { SegmentedControl, type SegmentOption } from "@/components/ops/SegmentedControl";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { fetchEscalations, qk } from "@/lib/queries";
import { useRealtimeRows } from "@/lib/realtime";

/*
 * The escalation queue. Rows change only through claim_escalation / close_escalation (from
 * here, the call page, or n8n's approval step with the service role), and every change arrives
 * as a Realtime signal that re-reads the lists; the cards re-check status client-side, so a row
 * that was just claimed leaves the Open tab without waiting for the refetch.
 */

const KIND_OPTIONS: SegmentOption<KindFilter>[] = [
  { value: "all", label: "All kinds" },
  { value: "representative", label: "Representative" },
  { value: "emergency", label: "Emergency" },
];

const TAB_COPY: Record<QueueTab, { description: string; listLabel: string; emptyTitle: string; emptyText: string }> = {
  open: {
    description: "Oldest first. Claim one before calling back so nobody else dials the same caller.",
    listLabel: "Open escalations, oldest first",
    emptyTitle: "No open escalations",
    emptyText: "Callback requests and emergencies land here the moment Tessa writes them.",
  },
  claimed: {
    description: "Being called back. Mark one done once the caller has been reached.",
    listLabel: "Claimed escalations, newest first",
    emptyTitle: "Nothing claimed right now",
    emptyText: "Claimed escalations wait here until someone marks them done.",
  },
  done: {
    description: "Closed escalations, newest first, with who closed them and their note.",
    listLabel: "Closed escalations, newest first",
    emptyTitle: "No closed escalations yet",
    emptyText: "Escalations appear here once they are marked done.",
  },
};

const TAB_ICONS = { open: Inbox, claimed: UserCheck, done: CircleCheck } as const;

/** fetchEscalations caps each list at this many rows. */
const LIST_CAP = 200;

export default function Escalations({ now: fixedNow }: { now?: Date } = {}) {
  const [params, setParams] = useSearchParams();
  const tab = parseTab(params.get("tab"));
  const kind = parseKind(params.get("kind"));
  const [limits, setLimits] = useState<Record<string, number>>({});
  const limitKey = `${tab}:${kind}`;
  const limit = limits[limitKey] ?? QUEUE_PAGE_SIZE;

  // The open list always loads: it feeds the summary tiles whichever tab is showing.
  const openQ = useQuery({ queryKey: qk.escalationList("open"), queryFn: () => fetchEscalations("open") });
  const listQ = useQuery({ queryKey: qk.escalationList(tab), queryFn: () => fetchEscalations(tab) });
  const countsQ = useQuery({ queryKey: escalationKeys.counts(), queryFn: fetchEscalationCounts });

  useRealtimeRows("escalations", null, [qk.escalations()]);
  useRealtimeRows("emails", null, [escalationKeys.emailsAll()]);

  // One clock for the summary and every card's age and SLA badge.
  const ticking = useNow(30_000, !fixedNow);
  const now = fixedNow ?? ticking;

  const rows = useMemo(() => visibleRows(listQ.data ?? [], tab, kind), [listQ.data, tab, kind]);
  const shownKeys = useMemo(() => callKeysOf(rows.slice(0, limit)), [rows, limit]);
  const emailsQ = useQuery({
    queryKey: escalationKeys.emails(shownKeys),
    queryFn: () => fetchEscalationEmails(shownKeys),
    enabled: shownKeys.length > 0,
    placeholderData: keepPreviousData,
  });

  const summary = useMemo(() => {
    if (!openQ.data) return null;
    const s = summariseOpen(openQ.data, now);
    // Only a capped list undercounts; below the cap the list is as fresh as the count, or fresher.
    return countsQ.data && openQ.data.length >= LIST_CAP ? { ...s, open: countsQ.data.open } : s;
  }, [openQ.data, countsQ.data, now]);

  const counts = countsQ.data;
  const allInTab = (listQ.data ?? []).filter((r) => r.status === tab);
  const copy = TAB_COPY[tab];

  const setTab = (value: string) => {
    const next = new URLSearchParams(params);
    if (value === "open") next.delete("tab");
    else next.set("tab", value);
    setParams(next);
  };
  const setKind = (value: KindFilter) => {
    const next = new URLSearchParams(params);
    if (value === "all") next.delete("kind");
    else next.set("kind", value);
    setParams(next, { replace: true });
  };

  return (
    <>
      <PageHeader title="Escalations" description="Callback requests and emergencies from every channel, with alert delivery for each." />

      <div className="space-y-6">
        <QueueSummary summary={summary} claimed={counts?.claimed ?? null} loading={openQ.isPending} />

        <Tabs value={tab} onValueChange={setTab}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <TabsList aria-label="Escalation status" className="w-full sm:w-auto">
              {QUEUE_TABS.map((t) => {
                const Icon = TAB_ICONS[t.value];
                const n = counts?.[t.value];
                return (
                  <TabsTrigger key={t.value} value={t.value} className="flex-1 px-2 sm:flex-none sm:px-3">
                    <Icon className="hidden min-[400px]:block" aria-hidden="true" />
                    {t.label}
                    {n !== undefined && (
                      <span className="rounded-full bg-[color-mix(in_oklab,var(--ink-1)_8%,transparent)] px-1.5 text-xs tabular text-ink-2">
                        {n}
                      </span>
                    )}
                  </TabsTrigger>
                );
              })}
            </TabsList>
            <SegmentedControl label="Filter by kind" options={KIND_OPTIONS} value={kind} onChange={setKind} />
          </div>

          {QUEUE_TABS.map((t) => (
            <TabsContent key={t.value} value={t.value} className="mt-4 space-y-3">
              {t.value === tab && (
                <>
                  <h2 className="sr-only">{`${t.label} escalations`}</h2>
                  <p className="text-sm text-ink-2">{copy.description}</p>
                  {listQ.isError && !listQ.data ? (
                    <Card>
                      <ErrorState title="Could not load escalations" error={listQ.error} onRetry={() => void listQ.refetch()} />
                    </Card>
                  ) : !listQ.isPending && rows.length === 0 ? (
                    <Card>
                      {allInTab.length > 0 ? (
                        <EmptyState
                          icon={FilterX}
                          title={`No ${kind} escalations here`}
                          description={`${allInTab.length} ${allInTab.length === 1 ? "escalation is" : "escalations are"} hidden by the kind filter.`}
                          action={
                            <Button variant="outline" size="sm" onClick={() => setKind("all")}>
                              Show all kinds
                            </Button>
                          }
                        />
                      ) : (
                        <EmptyState icon={TAB_ICONS[tab]} title={copy.emptyTitle} description={copy.emptyText} />
                      )}
                    </Card>
                  ) : (
                    <>
                      <EscalationQueue
                        rows={rows}
                        emails={emailsQ.data ?? []}
                        now={now}
                        limit={limit}
                        onShowMore={() => setLimits((m) => ({ ...m, [limitKey]: limit + QUEUE_PAGE_SIZE }))}
                        loading={listQ.isPending}
                        label={copy.listLabel}
                      />
                      {counts && (listQ.data?.length ?? 0) >= LIST_CAP && counts[tab] > LIST_CAP && (
                        <p className="text-center text-xs text-ink-3">
                          Showing the {LIST_CAP} {tab === "open" ? "oldest" : "most recent"} of {counts[tab]}.
                        </p>
                      )}
                    </>
                  )}
                </>
              )}
            </TabsContent>
          ))}
        </Tabs>
      </div>
    </>
  );
}
