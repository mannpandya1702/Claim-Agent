import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import {
  Check,
  CircleCheck,
  CircleX,
  ClipboardCopy,
  ContactRound,
  Copy,
  Download,
  FileText,
  Fingerprint,
  Gauge,
  Hourglass,
  LifeBuoy,
  Mail,
  MessagesSquare,
  NotebookPen,
  Receipt,
  Send,
  Siren,
  Timer,
  Volume2,
  Wallet,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { AudioPlayer } from "@/components/calls/AudioPlayer";
import { CallerContactCard } from "@/components/calls/CallerContactCard";
import { CallerTypeBadge } from "@/components/calls/CallerTypeBadge";
import { ChannelLabel } from "@/components/calls/CallTable";
import { CostBreakdown, costParts } from "@/components/calls/CostBreakdown";
import { EmailList } from "@/components/calls/EmailList";
import { OutboxList } from "@/components/calls/OutboxList";
import { EscalationCard } from "@/components/calls/EscalationCard";
import { FlagExplain } from "@/components/calls/FlagExplain";
import { IdentityBadge, IdentityPath } from "@/components/calls/IdentityPath";
import { StaffNotes } from "@/components/calls/StaffNotes";
import { ToolTimeline } from "@/components/calls/ToolTimeline";
import { TranscriptView } from "@/components/calls/TranscriptView";
import { useNow } from "@/components/calls/hooks";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { KpiTile } from "@/components/KpiTile";
import { LiveDot } from "@/components/LiveDot";
import { OutcomeBadge } from "@/components/OutcomeBadge";
import { PageHeader } from "@/components/PageHeader";
import { SentimentBadge } from "@/components/SentimentBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import {
  callerLabel,
  DASH,
  formatDateTimeLong,
  formatDuration,
  formatLatency,
  formatMoney,
  formatPhone,
  formatTime,
  NA,
} from "@/lib/format";
import {
  fetchCall,
  fetchCallAttempts,
  fetchCallContact,
  fetchCallEmails,
  fetchCallEscalations,
  fetchCallOutbox,
  fetchCallSession,
  fetchTranscriptLines,
  qk,
} from "@/lib/queries";
import { IN_PROGRESS_REFETCH_MS, useRealtimeRows } from "@/lib/realtime";
import { fromLiveLines, fromStoredMessages, transcriptToText, type TranscriptItem } from "@/lib/transcript";
import type { CallInteraction } from "@/lib/types";
import { cn } from "@/lib/utils";

/*
 * One call, keyed by the VAPI call id (= call_key everywhere). While ended_at is null the page
 * is live: it renders transcript_lines plus attempts chips, subscribes per call_key, and polls
 * every 5 s as a backstop. When the end-of-call report lands (ended_at set) it switches to the
 * stored messages and the post-call fields (summary, sentiment, flags, latency, cost) fill in.
 */

export interface SuccessMeta {
  label: string;
  tone: "good" | "critical" | "neutral";
}

/** VAPI success evaluations arrive as "true"/"false", a score, or a rubric word. */
export function successMeta(value: string | null | undefined): SuccessMeta | null {
  const v = (value ?? "").trim();
  if (!v) return null;
  const lower = v.toLowerCase();
  if (["true", "pass", "passed", "success", "successful", "yes"].includes(lower)) return { label: "Pass", tone: "good" };
  if (["false", "fail", "failed", "failure", "unsuccessful", "no"].includes(lower)) return { label: "Fail", tone: "critical" };
  return { label: v.length > 24 ? `${v.slice(0, 24)}…` : v, tone: "neutral" };
}

function elapsedSince(iso: string | null | undefined, now: Date): number | null {
  const t = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(t) ? Math.max(0, Math.floor((now.getTime() - t) / 1000)) : null;
}

async function copyText(text: string, what: string): Promise<void> {
  try {
    if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
    await navigator.clipboard.writeText(text);
    toast.success(`${what} copied`);
  } catch {
    toast.error(`Could not copy the ${what.toLowerCase()}`, { description: "The browser blocked clipboard access." });
  }
}

function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function CallDetail() {
  const { id = "" } = useParams<{ id: string }>();

  const rowQ = useQuery({
    queryKey: qk.callRow(id),
    queryFn: () => fetchCall(id),
    enabled: id !== "",
    // null = no row yet (the call may have just started); poll until it appears and while live.
    refetchInterval: (q) => (q.state.data === null || (q.state.data && q.state.data.ended_at == null) ? IN_PROGRESS_REFETCH_MS : false),
  });
  const row = rowQ.data;
  const rowLoaded = row !== undefined;
  const live = rowLoaded && (row === null || row.ended_at == null);
  const poll = live ? IN_PROGRESS_REFETCH_MS : false;

  const storedItems = useMemo(() => fromStoredMessages(row?.messages), [row?.messages]);
  const needLines = live || (rowLoaded && storedItems.length === 0);

  const sessionQ = useQuery({ queryKey: qk.callSession(id), queryFn: () => fetchCallSession(id), enabled: id !== "", refetchInterval: poll });
  const attemptsQ = useQuery({ queryKey: qk.callAttempts(id), queryFn: () => fetchCallAttempts(id), enabled: id !== "", refetchInterval: poll });
  const linesQ = useQuery({
    queryKey: qk.callTranscript(id),
    queryFn: () => fetchTranscriptLines(id),
    enabled: id !== "" && needLines,
    refetchInterval: poll,
  });
  const escalationsQ = useQuery({ queryKey: qk.callEscalations(id), queryFn: () => fetchCallEscalations(id), enabled: id !== "", refetchInterval: poll });
  const emailsQ = useQuery({ queryKey: qk.callEmails(id), queryFn: () => fetchCallEmails(id), enabled: id !== "", refetchInterval: poll });
  // The outbox row is written by the end-of-call writer, so it arrives after hangup (Realtime).
  const outboxQ = useQuery({ queryKey: qk.callOutbox(id), queryFn: () => fetchCallOutbox(id), enabled: id !== "" });
  const contactQ = useQuery({ queryKey: qk.callContact(id), queryFn: () => fetchCallContact(id), enabled: id !== "", refetchInterval: poll });

  // Per-call subscriptions. The streaming tables only matter while the call is live.
  const on = id !== "";
  useRealtimeRows("call_interactions", `vapi_call_id=eq.${id}`, [qk.callRow(id)], { enabled: on });
  useRealtimeRows("transcript_lines", `call_key=eq.${id}`, [qk.callTranscript(id)], { enabled: on && rowLoaded && live });
  useRealtimeRows("attempts", `call_key=eq.${id}`, [qk.callAttempts(id)], { enabled: on && rowLoaded && live });
  useRealtimeRows("call_sessions", `call_key=eq.${id}`, [qk.callSession(id)], { enabled: on && rowLoaded && live });
  useRealtimeRows("escalations", `call_key=eq.${id}`, [qk.callEscalations(id)], { enabled: on });
  useRealtimeRows("emails", `call_key=eq.${id}`, [qk.callEmails(id)], { enabled: on });
  useRealtimeRows("outbox_events", `ref_id=eq.${id}`, [qk.callOutbox(id)], { enabled: on });
  useRealtimeRows("caller_contacts", `call_key=eq.${id}`, [qk.callContact(id)], { enabled: on });

  const attempts = useMemo(() => attemptsQ.data ?? [], [attemptsQ.data]);
  const liveItems = useMemo(() => fromLiveLines(linesQ.data ?? [], attempts), [linesQ.data, attempts]);
  const source: "live" | "stored" | "fallback" | "none" = live
    ? "live"
    : storedItems.length > 0
      ? "stored"
      : liveItems.length > 0
        ? "fallback"
        : "none";
  const items: readonly TranscriptItem[] = source === "stored" ? storedItems : source === "none" ? [] : liveItems;

  const now = useNow(1000, live);

  if (!id) {
    return (
      <EmptyState title="No call id in this link" description="Calls are linked as #/calls/<call id>." />
    );
  }

  if (rowQ.isError && !rowLoaded) {
    return (
      <>
        <PageHeader title="Call" back={{ to: "/calls", label: "All calls" }} />
        <div className="rounded-xl bg-card shadow-card">
          <ErrorState title="Could not load this call" error={rowQ.error} onRetry={() => void rowQ.refetch()} />
        </div>
      </>
    );
  }

  if (!rowLoaded) return <DetailSkeleton />;

  const session = sessionQ.data ?? null;
  const escalations = escalationsQ.data ?? [];
  const emails = emailsQ.data ?? [];
  // A query that failed or has not answered must never read as "nothing happened".
  const sessionView = view(sessionQ);
  const attemptsView = view(attemptsQ);
  const linesView = needLines ? view(linesQ) : "ready";
  // With no call row yet, wait for the other reads before deciding anything about this call.
  if (row === null && [sessionView, attemptsView, linesView].includes("loading")) return <DetailSkeleton />;
  const nothingYet =
    row === null &&
    sessionView === "ready" &&
    attemptsView === "ready" &&
    linesView === "ready" &&
    !session &&
    attempts.length === 0 &&
    (linesQ.data ?? []).length === 0;

  if (nothingYet) {
    return (
      <>
        <PageHeader title="Waiting for this call" back={{ to: "/calls", label: "All calls" }} description={<CallIdLine id={id} />} />
        <div className="rounded-xl bg-card shadow-card">
          <EmptyState
            icon={Hourglass}
            title="No data for this call yet"
            description="If the call just started, this page fills in within a few seconds of the greeting and keeps checking every 5 seconds. If it stays empty, the link may point to a call that does not exist."
            action={
              <Button asChild variant="outline" size="sm">
                <Link to="/calls">Back to calls</Link>
              </Button>
            }
          />
        </div>
      </>
    );
  }

  const call = row as CallInteraction | null;
  const title = call ? callerLabel(call.caller_name) : "Call in progress";
  const success = call ? successMeta(call.success_evaluation) : null;
  const startedAt = call?.started_at ?? call?.created_at ?? session?.created_at ?? null;
  const duration = live ? formatDuration(elapsedSince(startedAt, now)) : formatDuration(call?.duration_seconds);
  const lookups = attempts.filter((a) => a.tool_name === "lookup_customer" || a.tool_name === "verify_identity").length;
  const hasSplit = costParts(call?.cost_breakdown).some((p) => p.value !== null);
  const emailsView = view(emailsQ);
  const contact = contactQ.data ?? null;
  const contactView = view(contactQ);

  const exportRecord = () =>
    downloadJson(`call-${id}.json`, {
      exported_at: new Date().toISOString(),
      call,
      identity: session,
      contact,
      attempts,
      escalations,
      emails,
    });

  return (
    <>
      <PageHeader
        back={{ to: "/calls", label: "All calls" }}
        title={title}
        documentTitle={title}
        description={
          <div className="mt-1 space-y-2">
            <div className="flex flex-wrap items-center gap-1.5">
              {/* Decided at hangup (the live stub row is still "unknown"); absent before 0006_contacts.sql. */}
              {call && !live && call.caller_type !== undefined && <CallerTypeBadge type={call.caller_type} />}
              {sessionView === "loading" ? (
                <Skeleton className="h-6 w-24" />
              ) : sessionView === "error" ? null : (
                <IdentityBadge level={session?.level} />
              )}
              <OutcomeBadge outcome={call?.outcome} live={live} />
              {!live && <SentimentBadge sentiment={call?.sentiment} />}
              {success && <SuccessBadge meta={success} />}
              {call?.emergency && (
                <Badge variant="critical">
                  <Siren aria-hidden="true" />
                  Emergency
                </Badge>
              )}
            </div>
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-2">
              <ChannelLabel channel={call?.channel ?? session?.channel} />
              <span aria-hidden="true" className="text-ink-3">·</span>
              <span>{startedAt ? formatDateTimeLong(startedAt) : DASH}</span>
              {call?.assistant_name && (
                <>
                  <span aria-hidden="true" className="text-ink-3">·</span>
                  <span>{call.assistant_name}</span>
                </>
              )}
            </p>
          </div>
        }
        actions={
          <>
            <Button variant="outline" size="sm" disabled={items.length === 0} onClick={() => void copyText(transcriptToText(items), "Transcript")}>
              <ClipboardCopy aria-hidden="true" />
              Copy transcript
            </Button>
            <Button variant="outline" size="sm" onClick={exportRecord}>
              <Download aria-hidden="true" />
              Download JSON
            </Button>
          </>
        }
      />

      {live && (
        <div role="status" className="mb-4 flex items-start gap-3 rounded-lg border border-primary/40 bg-accent-wash px-4 py-3 text-sm">
          <LiveDot className="mt-1.5" />
          <p className="text-ink-1">
            <span className="font-semibold">This call is live.</span>{" "}
            <span className="text-ink-2">
              Transcript lines and tool results appear as they land. Summary, sentiment, flags and latency fill in after hangup.
            </span>
          </p>
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_23rem]">
        <div className="min-w-0 space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <KpiTile label="Duration" icon={Timer} value={duration} hint={live ? "Running" : call?.ended_at ? `Ended ${formatTime(call.ended_at)} ET` : undefined} />
            <KpiTile label="Cost" icon={Wallet} value={live ? DASH : formatMoney(call?.cost)} hint={live ? "After hangup" : hasSplit ? "Split below" : "No split reported"} />
            <KpiTile label="Avg turn latency" icon={Gauge} value={live ? DASH : formatLatency(call?.latency_avg_ms)} hint={live ? "After hangup" : "Mean across turns"} />
            <KpiTile
              label="Tool calls"
              icon={Wrench}
              loading={attemptsView === "loading"}
              value={attemptsView === "error" ? NA : String(attempts.length)}
              hint={attemptsView === "error" ? "Could not load" : `${lookups} identity ${lookups === 1 ? "check" : "checks"}`}
            />
          </div>

          {call && !live && (
            <Section title="AI summary" icon={FileText}>
              {call.summary ? (
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-1">{call.summary}</p>
              ) : (
                <p className="text-sm text-ink-2">
                  {call.analysis_status === "missing"
                    ? "VAPI returned no summary for this call, and the backfill found none."
                    : "The summary has not arrived yet. It is backfilled shortly after the call ends."}
                </p>
              )}
              <h3 className="mb-2 mt-4 text-xs font-semibold uppercase tracking-wide text-ink-3">Flags</h3>
              <FlagExplain flags={call.flags} />
            </Section>
          )}

          <Section title="Identity path" icon={Fingerprint}>
            {sessionView === "error" || attemptsView === "error" ? (
              <ErrorState
                compact
                title="Could not load the identity path"
                error={sessionQ.error ?? attemptsQ.error}
                onRetry={() => {
                  void sessionQ.refetch();
                  void attemptsQ.refetch();
                }}
              />
            ) : sessionView === "loading" || attemptsView === "loading" ? (
              <SectionSkeleton rows={2} />
            ) : (
              <IdentityPath session={session} attempts={attempts} />
            )}
          </Section>

          {call && !live && (
            <Section title="Recording" icon={Volume2}>
              <AudioPlayer key={id} callId={id} hasRecording={call.has_recording} />
            </Section>
          )}

          <Section
            title="Transcript"
            icon={MessagesSquare}
            action={
              source === "live" ? (
                <Badge variant="good">
                  <LiveDot />
                  Streaming
                </Badge>
              ) : source === "fallback" ? (
                <Badge variant="muted">Live lines</Badge>
              ) : null
            }
          >
            {source === "fallback" && (
              <p className="mb-2 text-xs text-ink-3">The stored transcript is missing, so these are the lines captured during the call.</p>
            )}
            {source !== "stored" && linesView === "error" ? (
              <ErrorState compact title="Could not load the transcript" error={linesQ.error} onRetry={() => void linesQ.refetch()} />
            ) : source !== "stored" && linesView === "loading" ? (
              <SectionSkeleton rows={3} />
            ) : (
              <TranscriptView
                items={items}
                live={source === "live"}
                empty={
                  <p className="py-6 text-center text-sm text-ink-2">
                    {live
                      ? "Waiting for the first words. Lines appear here as each turn is finalised."
                      : call?.analysis_status === "pending"
                        ? "The end-of-call report has not arrived yet."
                        : "No transcript was recorded for this call."}
                  </p>
                }
              />
            )}
          </Section>
        </div>

        <div className="min-w-0 space-y-4">
          <Section title="Caller contact" icon={ContactRound}>
            {contactView === "error" ? (
              <ErrorState compact title="Could not load the caller contact" error={contactQ.error} onRetry={() => void contactQ.refetch()} />
            ) : contactView === "loading" ? (
              <SectionSkeleton rows={2} />
            ) : contact ? (
              <CallerContactCard contact={contact} />
            ) : (
              <p className="text-sm text-ink-2">
                {live
                  ? "None yet. A new caller's name, email and callback number appear here as Ava takes them."
                  : "No contact details were taken on this call."}
              </p>
            )}
          </Section>

          <Section title="Escalations" icon={LifeBuoy} count={escalations.length}>
            {view(escalationsQ) === "error" ? (
              <ErrorState compact title="Could not load escalations" error={escalationsQ.error} onRetry={() => void escalationsQ.refetch()} />
            ) : view(escalationsQ) === "loading" ? (
              <SectionSkeleton rows={2} />
            ) : escalations.length === 0 ? (
              <p className="text-sm text-ink-2">{live ? "None yet. An escalation appears here the moment Ava queues one." : "No escalation for this call."}</p>
            ) : (
              <div className="space-y-3">
                {escalations.map((e) => (
                  <EscalationCard key={e.id} escalation={e} emails={emails} emailsState={emailsView === "ready" ? undefined : emailsView} />
                ))}
              </div>
            )}
          </Section>

          <Section title="Emails sent" icon={Mail} count={emails.length}>
            {emailsView === "error" ? (
              <ErrorState compact title="Could not load emails" error={emailsQ.error} onRetry={() => void emailsQ.refetch()} />
            ) : emailsView === "loading" ? (
              <SectionSkeleton rows={1} />
            ) : emails.length === 0 ? (
              <p className="text-sm text-ink-2">No emails for this call.</p>
            ) : (
              <EmailList emails={emails} />
            )}
          </Section>

          <Section title="Outbox events" icon={Send} count={outboxQ.data?.length ?? 0}>
            {view(outboxQ) === "error" ? (
              <ErrorState compact title="Could not load outbox events" error={outboxQ.error} onRetry={() => void outboxQ.refetch()} />
            ) : view(outboxQ) === "loading" ? (
              <SectionSkeleton rows={1} />
            ) : (outboxQ.data ?? []).length === 0 ? (
              <p className="text-sm text-ink-2">
                {live ? "Queued for the Airtable call log when the call ends." : "Nothing queued for this call."}
              </p>
            ) : (
              <OutboxList events={outboxQ.data ?? []} />
            )}
          </Section>

          <Section title="Tool timeline" icon={Wrench} count={attempts.length}>
            {attemptsView === "error" ? (
              <ErrorState compact title="Could not load tool calls" error={attemptsQ.error} onRetry={() => void attemptsQ.refetch()} />
            ) : attemptsView === "loading" ? (
              <SectionSkeleton rows={2} />
            ) : attempts.length === 0 ? (
              <p className="text-sm text-ink-2">{live ? "No tool calls yet." : "Ava made no tool calls on this call."}</p>
            ) : (
              <ToolTimeline attempts={attempts} startedAt={call?.started_at ?? null} />
            )}
          </Section>

          {call && !live && (
            <Section title="Cost" icon={Receipt}>
              <CostBreakdown cost={call.cost} breakdown={call.cost_breakdown} />
            </Section>
          )}

          <Section title="Call details" icon={FileText}>
            <CallFacts id={id} call={call} callerNumber={session?.caller_number ?? null} />
          </Section>

          {call && (
            <Section title="Staff notes" icon={NotebookPen}>
              {/* Keyed by call: the route reuses this page across ids, and a draft must never follow to another call. */}
              <StaffNotes key={id} callId={id} notes={call.staff_notes} />
            </Section>
          )}
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------------------------

type QueryView = "loading" | "error" | "ready";

/**
 * What a section may say about its query. Data already on screen wins over a failed refetch
 * (the page polls, so the next read usually recovers); without data, a failure is an error and
 * an unanswered read is loading, never an empty state.
 */
function view(q: Pick<UseQueryResult<unknown>, "data" | "isError" | "isPending">): QueryView {
  if (q.data !== undefined) return "ready";
  if (q.isError) return "error";
  return q.isPending ? "loading" : "ready";
}

function SectionSkeleton({ rows }: { rows: number }) {
  return (
    <div className="space-y-2" role="status" aria-live="polite">
      <span className="sr-only">Loading</span>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className={cn("h-5", i % 2 === 0 ? "w-3/4" : "w-1/2")} />
      ))}
    </div>
  );
}

function Section({
  title,
  icon: Icon,
  action,
  count,
  children,
  className,
}: {
  title: string;
  icon: LucideIcon;
  action?: ReactNode;
  count?: number;
  children: ReactNode;
  className?: string;
}) {
  const headingId = `section-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return (
    <section aria-labelledby={headingId} className={cn("rounded-xl bg-card shadow-card", className)}>
      <div className="flex min-h-12 items-center justify-between gap-2 px-4 pt-3.5 sm:px-5">
        <h2 id={headingId} className="flex items-center gap-2 text-sm font-semibold text-ink-1">
          <Icon className="size-4 text-ink-3" aria-hidden="true" />
          {title}
          {count !== undefined && count > 0 && (
            <span className="rounded-full bg-muted px-1.5 text-xs font-medium tabular text-ink-2">{count}</span>
          )}
        </h2>
        {action}
      </div>
      <div className="px-4 pb-4 pt-2 sm:px-5 sm:pb-5">{children}</div>
    </section>
  );
}

function SuccessBadge({ meta }: { meta: SuccessMeta }) {
  const variant = meta.tone === "good" ? "good" : meta.tone === "critical" ? "critical" : "muted";
  const Icon = meta.tone === "good" ? CircleCheck : meta.tone === "critical" ? CircleX : Check;
  return (
    <Badge variant={variant} title="VAPI success evaluation">
      <Icon aria-hidden="true" />
      Success: {meta.label}
    </Badge>
  );
}

function CallIdLine({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="inline-flex max-w-full items-center gap-1">
      <span className="truncate font-mono text-xs text-ink-2" title={id}>{id}</span>
      <Button
        variant="ghost"
        size="icon-sm"
        className="size-7"
        aria-label="Copy call id"
        onClick={() => {
          void copyText(id, "Call id").then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      </Button>
    </span>
  );
}

function CallFacts({ id, call, callerNumber }: { id: string; call: CallInteraction | null; callerNumber: string | null }) {
  const phone = call?.caller_phone ?? callerNumber;
  const facts: { label: string; value: ReactNode }[] = [
    { label: "Call id", value: <CallIdLine id={id} /> },
    { label: "Started", value: formatDateTimeLong(call?.started_at ?? call?.created_at) },
    { label: "Ended", value: call?.ended_at ? formatDateTimeLong(call.ended_at) : "In progress" },
    { label: "Caller number", value: <span className="tabular">{formatPhone(phone)}</span> },
    { label: "Ended reason", value: call?.ended_reason ? <span className="font-mono text-xs">{call.ended_reason}</span> : DASH },
    { label: "Assistant", value: call?.assistant_name ?? DASH },
    { label: "Analysis", value: call ? analysisLabel(call) : DASH },
  ];
  return (
    <dl className="divide-y text-sm">
      {facts.map((f) => (
        <div key={f.label} className="grid grid-cols-[7.5rem_minmax(0,1fr)] items-center gap-2 py-1.5 first:pt-0 last:pb-0">
          <dt className="text-xs text-ink-3">{f.label}</dt>
          <dd className="min-w-0 break-words text-ink-1">{f.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function analysisLabel(call: CallInteraction): string {
  const status = { pending: "Pending", ok: "From the report", backfilled: "Backfilled", missing: "Missing" }[call.analysis_status] ?? call.analysis_status;
  return call.sentiment_source ? `${status} (sentiment: ${call.sentiment_source.replace(/_/g, " ")})` : status;
}

function DetailSkeleton() {
  return (
    <div className="space-y-4" role="status" aria-live="polite">
      <span className="sr-only">Loading call</span>
      <Skeleton className="h-3 w-16" />
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-5 w-80 max-w-full" />
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_23rem]">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-24 rounded-xl" />
            ))}
          </div>
          <Skeleton className="h-32 rounded-xl" />
          <Skeleton className="h-96 rounded-xl" />
        </div>
        <div className="space-y-4">
          <Skeleton className="h-48 rounded-xl" />
          <Skeleton className="h-32 rounded-xl" />
        </div>
      </div>
    </div>
  );
}
