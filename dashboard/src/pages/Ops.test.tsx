import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ROUTER_FUTURE } from "@/lib/router";
import type { DeliveryGapRow, JobRun, OpsHealth } from "@/lib/types";

const m = vi.hoisted(() => ({
  fetchOpsHealth: vi.fn(),
  fetchDeliveryGap: vi.fn(),
  fetchJobRuns: vi.fn(),
}));

vi.mock("@/lib/supabase", () => ({ supabase: {}, supabaseConfigured: true }));
vi.mock("@/lib/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/queries")>()),
  fetchOpsHealth: () => m.fetchOpsHealth(),
  fetchDeliveryGap: (h: number) => m.fetchDeliveryGap(h),
  fetchJobRuns: (n: number) => m.fetchJobRuns(n),
}));
vi.mock("@/lib/realtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/realtime")>()),
  useRealtimeRows: vi.fn(() => ({ status: "SUBSCRIBED", isLive: true })),
}));

const { default: Ops } = await import("./Ops");

const NOW = new Date("2026-10-12T15:00:00Z");
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();

const HEALTH: OpsHealth = {
  last_sla_run: ago(6),
  last_digest_run: ago(3 * 60),
  last_reaper_run: ago(4 * 60),
  open_escalations: 2,
  sla_breaches: 1,
  alerts_failed_24h: 0,
  emails_failed_24h: 0,
  emails_sent_24h: 11,
  stuck_calls: 0,
  analysis_missing_24h: 0,
};

const GAP: DeliveryGapRow[] = [
  { channel: "telegram", owed: 4, delivered: 3, failed: 1 },
  { channel: "email", owed: 6, delivered: 6, failed: 0 },
];

const RUNS: JobRun[] = [
  { job: "sla", period_key: "2026-10-12T14:50", started_at: ago(6), finished_at: ago(5.9), result: { realerted: 1, skipped: 0 } },
  { job: "reaper", period_key: "2026-10-12T11", started_at: ago(4 * 60), finished_at: null, result: null },
  { job: "digest", period_key: "2026-10-12", started_at: ago(3 * 60), finished_at: ago(179), result: { sent: true, counts: { resolved: 3 } } },
];

function renderOps() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter future={ROUTER_FUTURE} initialEntries={["/ops"]}>
        <Ops now={NOW} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function tile(label: string) {
  const dt = screen.getByText(label, { selector: "dt" });
  return {
    value: dt.nextElementSibling?.textContent ?? "",
    tone: dt.closest("[data-tone]")?.getAttribute("data-tone") ?? null,
    el: dt.closest("[data-tone]") as HTMLElement | null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.fetchOpsHealth.mockResolvedValue(HEALTH);
  m.fetchDeliveryGap.mockResolvedValue(GAP);
  m.fetchJobRuns.mockResolvedValue(RUNS);
});

describe("Ops", () => {
  it("rates each job by its last run against its own schedule", async () => {
    renderOps();
    await waitFor(() => expect(tile("SLA re-alert").value).toBe("6 minutes ago"));
    expect(tile("SLA re-alert").tone).toBe("good");
    expect(within(tile("SLA re-alert").el!).getByText("On schedule")).toBeInTheDocument();
    // Hourly reaper last ran 4 hours ago: stopped. Daily digest 3 hours ago: fine.
    expect(tile("Reaper").tone).toBe("critical");
    expect(within(tile("Reaper").el!).getByText("Stopped: overdue")).toBeInTheDocument();
    expect(tile("Daily digest").tone).toBe("good");
  });

  it("shows queue and failure counts with words, linking to the queues", async () => {
    renderOps();
    await waitFor(() => expect(tile("Open escalations").value).toBe("2"));
    expect(tile("Open escalations").tone).toBe("warning");
    expect(tile("SLA breaches").tone).toBe("critical");
    expect(tile("SLA breaches").el).toHaveAttribute("href", "/escalations");
    expect(tile("Stuck calls").el).toHaveAttribute("href", "/live");
    expect(tile("Emails failed").tone).toBe("good");
    expect(screen.getByText("11 sent in the last 24 hours")).toBeInTheDocument();
  });

  it("asks escalation_delivery_gap for 24 hours and prints every count beside the meter", async () => {
    renderOps();
    const telegram = await screen.findByRole("region", { name: "Telegram" });
    expect(m.fetchDeliveryGap).toHaveBeenCalledWith(24);
    expect(within(telegram).getByRole("img")).toHaveAccessibleName("Telegram: 3 delivered, 1 failed, 0 pending, of 4");
    expect(within(telegram).getByText("1 failed")).toBeInTheDocument();
    const email = screen.getByRole("region", { name: "Email" });
    expect(within(email).getByText("All delivered")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("raises a red banner when a channel delivered nothing it owed", async () => {
    m.fetchDeliveryGap.mockResolvedValue([
      { channel: "telegram", owed: 3, delivered: 0, failed: 3 },
      { channel: "email", owed: 0, delivered: 0, failed: 0 },
    ]);
    renderOps();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Telegram is down.");
    expect(alert).toHaveTextContent("Check the bot token and chat id.");
    expect(within(screen.getByRole("region", { name: "Email" })).getByText("Nothing to deliver")).toBeInTheDocument();
  });

  it("lists recent job runs with status and result, filterable by job", async () => {
    renderOps();
    const table = await screen.findByRole("table");
    await waitFor(() => expect(within(table).getAllByRole("row")).toHaveLength(4));
    expect(within(table).getByText("realerted 1 · skipped 0")).toBeInTheDocument();
    expect(within(table).getByText("Did not finish")).toBeInTheDocument();
    expect(within(table).getByText("Full result")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /^Reaper/ }));
    expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(2);
  });

  it("explains an empty job history", async () => {
    m.fetchJobRuns.mockResolvedValue([]);
    m.fetchOpsHealth.mockResolvedValue({ ...HEALTH, last_sla_run: null, last_digest_run: null, last_reaper_run: null });
    renderOps();
    expect(await screen.findByText("No job runs yet")).toBeInTheDocument();
    await waitFor(() => expect(tile("SLA re-alert").value).toBe("Never"));
    expect(tile("SLA re-alert").tone).toBe("warning");
  });
});
