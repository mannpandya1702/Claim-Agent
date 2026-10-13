import { describe, expect, it } from "vitest";
import {
  airtableChannel,
  channelHealth,
  countHealth,
  deliveryChannels,
  ghlChannel,
  hasGhl,
  JOB_SPECS,
  jobHealth,
  normaliseHealth,
  runDuration,
  runState,
  summariseResult,
} from "./health";
import type { OpsHealth } from "@/lib/types";

const NOW = new Date("2026-10-12T15:00:00Z");
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();
const spec = (job: string) => JOB_SPECS.find((s) => s.job === job)!;

describe("jobHealth", () => {
  it("rates the 10-minute sla job: on schedule, late, stopped", () => {
    expect(jobHealth(ago(9), spec("sla"), NOW)).toEqual({ tone: "good", label: "On schedule" });
    expect(jobHealth(ago(25), spec("sla"), NOW).tone).toBe("good");
    expect(jobHealth(ago(26), spec("sla"), NOW)).toEqual({ tone: "warning", label: "Running late" });
    expect(jobHealth(ago(61), spec("sla"), NOW)).toEqual({ tone: "critical", label: "Stopped: overdue" });
  });

  it("gives the hourly reaper and the daily digest their own windows", () => {
    expect(jobHealth(ago(70), spec("reaper"), NOW).tone).toBe("good");
    expect(jobHealth(ago(120), spec("reaper"), NOW).tone).toBe("warning");
    expect(jobHealth(ago(200), spec("reaper"), NOW).tone).toBe("critical");
    expect(jobHealth(ago(25 * 60), spec("digest"), NOW).tone).toBe("good");
    expect(jobHealth(ago(30 * 60), spec("digest"), NOW).tone).toBe("warning");
    expect(jobHealth(ago(51 * 60), spec("digest"), NOW).tone).toBe("critical");
  });

  it("treats a job that never ran as a warning, not an outage", () => {
    expect(jobHealth(null, spec("sla"), NOW)).toEqual({ tone: "warning", label: "No run recorded" });
    expect(jobHealth("not a date", spec("digest"), NOW).label).toBe("No run recorded");
  });
});

describe("countHealth", () => {
  it("is good at zero and takes the given tone above it", () => {
    expect(countHealth(0, "critical", "Bad")).toEqual({ tone: "good", label: "None" });
    expect(countHealth(null, "critical", "Bad", "Clear")).toEqual({ tone: "good", label: "Clear" });
    expect(countHealth(2, "serious", "Stuck")).toEqual({ tone: "serious", label: "Stuck" });
  });
});

describe("normaliseHealth", () => {
  it("turns bigint strings into numbers and leaves timestamps alone", () => {
    const raw = {
      last_sla_run: ago(5),
      last_digest_run: null,
      last_reaper_run: ago(30),
      open_escalations: "3",
      sla_breaches: "1",
      alerts_failed_24h: 0,
      emails_failed_24h: "2",
      emails_sent_24h: "11",
      stuck_calls: null,
      analysis_missing_24h: "0",
    } as unknown as OpsHealth;
    const h = normaliseHealth(raw);
    expect(h.open_escalations).toBe(3);
    expect(h.emails_failed_24h).toBe(2);
    expect(h.stuck_calls).toBe(0);
    expect(h.last_digest_run).toBeNull();
  });
});

describe("channelHealth", () => {
  it("separates delivered, failed and still pending", () => {
    const c = channelHealth({ channel: "telegram", owed: 10, delivered: 7, failed: 1 });
    expect(c).toMatchObject({ label: "Telegram", pending: 2, tone: "critical", status: "1 failed", dead: false });
  });

  it("calls a channel down when it owed messages, delivered none and something failed", () => {
    const c = channelHealth({ channel: "email", owed: 3, delivered: 0, failed: 3 });
    expect(c).toMatchObject({ dead: true, tone: "critical", status: "Channel down: nothing delivered" });
  });

  it("does not call a channel down while its only messages are still in flight", () => {
    expect(channelHealth({ channel: "telegram", owed: 1, delivered: 0, failed: 0 })).toMatchObject({
      dead: false,
      tone: "warning",
      pending: 1,
    });
  });

  it("reads all-delivered as good and nothing-owed as idle", () => {
    expect(channelHealth({ channel: "email", owed: 4, delivered: 4, failed: 0 })).toMatchObject({ tone: "good", status: "All delivered" });
    expect(channelHealth({ channel: "email", owed: 0, delivered: 0, failed: 0 })).toMatchObject({ tone: "idle", dead: false });
  });

  it("always returns both channels in a fixed order", () => {
    const rows = deliveryChannels([{ channel: "email", owed: 2, delivered: 2, failed: 0 }]);
    expect(rows.map((r) => r.channel)).toEqual(["telegram", "email"]);
    expect(rows[0]).toMatchObject({ owed: 0, tone: "idle" });
  });

  it("accepts counts that arrive as strings", () => {
    const c = channelHealth({ channel: "telegram", owed: "5", delivered: "5", failed: "0" } as never);
    expect(c).toMatchObject({ owed: 5, delivered: 5, tone: "good" });
  });
});

describe("job runs", () => {
  it("knows finished, running and runs that never finished", () => {
    expect(runState({ started_at: ago(1), finished_at: ago(0.5) }, NOW)).toBe("finished");
    expect(runState({ started_at: ago(2), finished_at: null }, NOW)).toBe("running");
    expect(runState({ started_at: ago(20), finished_at: null }, NOW)).toBe("unfinished");
  });

  it("formats run duration and hides it for unfinished runs", () => {
    expect(runDuration({ started_at: "2026-10-12T15:00:00.000Z", finished_at: "2026-10-12T15:00:00.420Z" })).toBe("420 ms");
    expect(runDuration({ started_at: "2026-10-12T15:00:00Z", finished_at: "2026-10-12T15:00:04.2Z" })).toBe("4.2 s");
    expect(runDuration({ started_at: "2026-10-12T15:00:00Z", finished_at: "2026-10-12T15:03:10Z" })).toBe("3 min");
    expect(runDuration({ started_at: "2026-10-12T15:00:00Z", finished_at: null })).toBeNull();
  });

  it("summarises the first scalar fields of a result and flags the rest", () => {
    expect(summariseResult({ realerted: 2, skipped_rows: 0 })).toEqual({ parts: ["realerted 2", "skipped rows 0"], more: false });
    expect(summariseResult({ a: 1, b: 2, c: 3, d: 4, e: 5 })).toEqual({ parts: ["a 1", "b 2", "c 3", "d 4"], more: true });
    expect(summariseResult({ counts: { resolved: 3 }, sent: true })).toEqual({ parts: ["sent true"], more: true });
    expect(summariseResult({ ids: ["x", "y"] })).toEqual({ parts: ["ids 2 items"], more: false });
    expect(summariseResult(null)).toEqual({ parts: [], more: false });
  });
});

describe("the Airtable call log channel", () => {
  const base: OpsHealth = {
    last_sla_run: null,
    last_digest_run: null,
    last_reaper_run: null,
    open_escalations: 0,
    sla_breaches: 0,
    alerts_failed_24h: 0,
    emails_failed_24h: 0,
    emails_sent_24h: 0,
    stuck_calls: 0,
    analysis_missing_24h: 0,
  };

  it("is absent until the outbox columns exist", () => {
    expect(airtableChannel(base)).toBeNull();
    expect(deliveryChannels([], base).map((c) => c.channel)).toEqual(["telegram", "email"]);
    expect(normaliseHealth(base)).not.toHaveProperty("outbox_pending");
  });

  it("counts delivered (24 h), queued and given-up rows, and is down when nothing arrives", () => {
    const h = normaliseHealth({ ...base, outbox_pending: "0", outbox_dead: "3", outbox_delivered_24h: "0" } as unknown as OpsHealth);
    const c = airtableChannel(h)!;
    expect(c).toMatchObject({ channel: "airtable", label: "Airtable call log", owed: 3, delivered: 0, failed: 3, dead: true });
    expect(deliveryChannels([], h).map((x) => x.channel)).toEqual(["telegram", "email", "airtable"]);
    expect(airtableChannel({ ...base, outbox_pending: 2, outbox_dead: 0, outbox_delivered_24h: 5 })).toMatchObject({
      tone: "warning",
      status: "2 not delivered yet",
    });
  });

  it("adds GoHighLevel after Airtable once ops_health carries its counts (0008_ghl.sql)", () => {
    expect(ghlChannel(base)).toBeNull();
    expect(hasGhl(base)).toBe(false);
    expect(normaliseHealth(base)).not.toHaveProperty("ghl_pending");

    const h = normaliseHealth({
      ...base,
      outbox_pending: 0,
      outbox_dead: 0,
      outbox_delivered_24h: 4,
      ghl_pending: "2",
      ghl_dead: "1",
      ghl_delivered_24h: "3",
    } as unknown as OpsHealth);
    expect(hasGhl(h)).toBe(true);
    expect(h.ghl_pending).toBe(2);
    expect(ghlChannel(h)).toMatchObject({ channel: "ghl", label: "GoHighLevel CRM", owed: 6, delivered: 3, failed: 1, pending: 2, tone: "critical" });
    expect(deliveryChannels([], h).map((x) => x.channel)).toEqual(["telegram", "email", "airtable", "ghl"]);
    // a GoHighLevel outage never reads as Airtable's
    expect(deliveryChannels([], h).find((x) => x.channel === "airtable")).toMatchObject({ tone: "good", status: "All delivered" });
  });

  it("rates the every-minute outbox job on its own window", () => {
    expect(jobHealth(ago(3), spec("outbox"), NOW).tone).toBe("good");
    expect(jobHealth(ago(10), spec("outbox"), NOW).tone).toBe("warning");
    expect(jobHealth(ago(30), spec("outbox"), NOW).tone).toBe("critical");
  });
});
