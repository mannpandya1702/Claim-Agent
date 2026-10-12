import { CircleCheck, CircleDashed, Mail, OctagonAlert, Send, Table2, TriangleAlert, type LucideIcon } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCount } from "@/lib/format";
import { cn } from "@/lib/utils";
import { CHANNEL_FIX, type ChannelHealth, type ChannelTone } from "./health";

/*
 * Delivery meter per channel. Delivered takes the accent (series 1) and failed takes the
 * critical status color: green beside red collapses under deuteranopia (validator: CVD dE 4.1),
 * blue beside red clears it in both modes (23.8 light, 25.7 dark). What is still in flight is a
 * lighter step of the accent, the meter's own track. Every count is also printed in the legend,
 * so the bar never carries a value alone.
 */

const DELIVERED = "var(--series-1)";
const FAILED = "var(--status-critical)";
const PENDING = "color-mix(in oklab, var(--series-1) 30%, var(--card))";
const EMPTY = "var(--muted)";

const CHANNEL_ICONS: Record<string, LucideIcon> = { telegram: Send, email: Mail, airtable: Table2 };

const TONE_STYLE: Record<ChannelTone, { icon: LucideIcon; ink: string }> = {
  good: { icon: CircleCheck, ink: "text-good-ink" },
  warning: { icon: TriangleAlert, ink: "text-warning-ink" },
  critical: { icon: OctagonAlert, ink: "text-critical-ink" },
  idle: { icon: CircleDashed, ink: "text-ink-2" },
};

// A single failure among hundreds must still be visible, so a non-zero segment never drops
// below this share of the track.
const MIN_SHARE = 3;

function shares(c: ChannelHealth): { delivered: number; failed: number; pending: number } {
  if (c.owed === 0) return { delivered: 0, failed: 0, pending: 0 };
  const raw = { delivered: c.delivered, failed: c.failed, pending: c.pending };
  const pct = (n: number) => (n === 0 ? 0 : Math.max(MIN_SHARE, (n / c.owed) * 100));
  const out = { delivered: pct(raw.delivered), failed: pct(raw.failed), pending: pct(raw.pending) };
  const total = out.delivered + out.failed + out.pending;
  // Re-normalise after the floor so the three always fill the track exactly.
  return { delivered: (out.delivered / total) * 100, failed: (out.failed / total) * 100, pending: (out.pending / total) * 100 };
}

export function DeliveryMeter({ channel }: { channel: ChannelHealth }) {
  const s = shares(channel);
  const label =
    channel.owed === 0
      ? `${channel.label}: nothing to deliver in the last 24 hours`
      : `${channel.label}: ${channel.delivered} delivered, ${channel.failed} failed, ${channel.pending} pending, of ${channel.owed}`;
  const segments = [
    { key: "delivered", share: s.delivered, color: DELIVERED, title: `Delivered: ${channel.delivered}` },
    { key: "failed", share: s.failed, color: FAILED, title: `Failed: ${channel.failed}` },
    { key: "pending", share: s.pending, color: PENDING, title: `Pending: ${channel.pending}` },
  ].filter((seg) => seg.share > 0);

  return (
    <div role="img" aria-label={label} className="flex h-2.5 w-full gap-[2px] overflow-hidden rounded-full" data-testid={`meter-${channel.channel}`}>
      {segments.length === 0 ? (
        <span className="viz-mark h-full w-full" style={{ backgroundColor: EMPTY }} />
      ) : (
        segments.map((seg) => (
          <span
            key={seg.key}
            title={seg.title}
            className="viz-mark h-full transition-[width] duration-300"
            style={{ width: `${seg.share}%`, backgroundColor: seg.color }}
            data-segment={seg.key}
          />
        ))
      )}
    </div>
  );
}

function LegendItem({ color, label, value }: { color: string; label: string; value: number }) {
  return (
    <li className="flex items-center gap-1.5">
      <span aria-hidden="true" className="viz-mark size-2.5 shrink-0 rounded-[3px]" style={{ backgroundColor: color }} />
      <span className="text-ink-2">{label}</span>
      <span className="font-medium tabular text-ink-1">{formatCount(value)}</span>
    </li>
  );
}

export function ChannelRow({ channel }: { channel: ChannelHealth }) {
  const Icon = CHANNEL_ICONS[channel.channel] ?? Send;
  const tone = TONE_STYLE[channel.tone];
  return (
    <section aria-labelledby={`channel-${channel.channel}`} className="space-y-2.5" data-channel={channel.channel} data-tone={channel.tone}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 id={`channel-${channel.channel}`} className="flex items-center gap-2 text-sm font-semibold text-ink-1">
          <Icon className="size-4 text-ink-3" aria-hidden="true" />
          {channel.label}
        </h3>
        <p className="text-sm text-ink-2">
          {channel.owed === 0 ? (
            channel.channel === "airtable" ? "Nothing queued" : "No alerts owed"
          ) : (
            <>
              <span className="font-semibold tabular text-ink-1">{formatCount(channel.delivered)}</span> of{" "}
              <span className="tabular">{formatCount(channel.owed)}</span> delivered
            </>
          )}
        </p>
      </div>
      <DeliveryMeter channel={channel} />
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 text-xs">
        <ul className="flex flex-wrap gap-x-4 gap-y-1" aria-label={`${channel.label} counts`}>
          <LegendItem color={DELIVERED} label="Delivered" value={channel.delivered} />
          <LegendItem color={FAILED} label="Failed" value={channel.failed} />
          <LegendItem color={PENDING} label="Pending" value={channel.pending} />
        </ul>
        <p className={cn("flex items-center gap-1 font-medium", tone.ink)}>
          <tone.icon className="size-3.5 shrink-0" aria-hidden="true" />
          {channel.status}
        </p>
      </div>
    </section>
  );
}

export function DeliveryGapSkeleton() {
  return (
    <div className="space-y-6" aria-hidden="true">
      {[0, 1].map((i) => (
        <div key={i} className="space-y-2.5">
          <div className="flex justify-between">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-28" />
          </div>
          <Skeleton className="h-2.5 w-full rounded-full" />
          <Skeleton className="h-3 w-56" />
        </div>
      ))}
    </div>
  );
}

/** Red banner for a channel that owed alerts in the window and delivered none of them. */
export function ChannelDownBanner({ channels }: { channels: readonly ChannelHealth[] }) {
  const down = channels.filter((c) => c.dead);
  if (down.length === 0) return null;
  return (
    <div
      role="alert"
      className="mb-5 flex items-start gap-3 rounded-xl border border-l-[3px] border-l-critical bg-[color-mix(in_oklab,var(--status-critical)_8%,var(--card))] px-4 py-3"
    >
      <OctagonAlert className="mt-0.5 size-5 shrink-0 text-critical-ink" aria-hidden="true" />
      <div className="space-y-1 text-sm">
        {down.map((c) => (
          <p key={c.channel} className="text-ink-1">
            <span className="font-semibold text-critical-ink">{c.label} is down.</span> It delivered none of{" "}
            {c.owed === 1 ? "the 1 message" : `the ${c.owed} messages`} owed in the last 24 hours ({c.failed} failed). {CHANNEL_FIX[c.channel]}
          </p>
        ))}
      </div>
    </div>
  );
}
