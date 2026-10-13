import { beforeEach, describe, expect, it, vi } from "vitest";

type Result = { data: unknown; error: { code?: string; message: string } | null };

/** One recorded read: the table, the selected columns and the eq filter, answered from `answers`. */
interface Read {
  table: string;
  columns: string;
  eq: [string, unknown];
}

const reads: Read[] = [];
let answers: Result[] = [];
const rpcCalls: [string, unknown][] = [];

vi.mock("@/lib/supabase", () => ({
  supabaseConfigured: true,
  supabase: {
    rpc: async (fn: string, args: unknown) => {
      rpcCalls.push([fn, args]);
      return answers.shift() ?? { data: null, error: null };
    },
    from: (table: string) => ({
      select: (columns: string) => ({
        eq: (column: string, value: unknown) => ({
          maybeSingle: async () => {
            reads.push({ table, columns, eq: [column, value] });
            return answers.shift() ?? { data: null, error: null };
          },
        }),
      }),
    }),
  },
}));

const {
  CALL_DETAIL_COLUMNS,
  CALLER_CONTACT_COLUMNS,
  CLAIM_INTAKE_COLUMNS,
  fetchCall,
  fetchCallContact,
  fetchCallIntake,
  fetchCallReasonCounts,
  qk,
} = await import("./queries");

beforeEach(() => {
  reads.length = 0;
  rpcCalls.length = 0;
  answers = [];
});

describe("fetchCall", () => {
  it("reads the caller type and the confirmed captured email with the detail row", async () => {
    answers = [{ data: { vapi_call_id: "c1", caller_type: "new", caller_email: "p@example.com" }, error: null }];
    const row = await fetchCall("c1");
    expect(row).toMatchObject({ caller_type: "new", caller_email: "p@example.com" });
    expect(reads).toHaveLength(1);
    expect(reads[0]!.table).toBe("call_interactions");
    expect(reads[0]!.columns.split(",")).toEqual(expect.arrayContaining(["caller_type", "caller_email", "caller_phone"]));
    expect(reads[0]!.columns).toBe(CALL_DETAIL_COLUMNS);
    expect(reads[0]!.eq).toEqual(["vapi_call_id", "c1"]);
  });

  it("falls back to the older columns while 0006_contacts.sql is not applied yet", async () => {
    answers = [
      { data: null, error: { code: "42703", message: "column call_interactions.caller_type does not exist" } },
      { data: { vapi_call_id: "c1", caller_name: "Tobias Halvorsen" }, error: null },
    ];
    const row = await fetchCall("c1");
    expect(row).toMatchObject({ caller_name: "Tobias Halvorsen" });
    expect(row?.caller_type).toBeUndefined();
    expect(reads).toHaveLength(2);
    expect(reads[1]!.columns.split(",")).not.toContain("caller_type");
    expect(reads[1]!.columns.split(",")).not.toContain("caller_email");
    expect(reads[1]!.columns.split(",")).toContain("staff_notes");
  });

  it("reads the call reason, its source and the claim number the call filed", async () => {
    answers = [{ data: { vapi_call_id: "c1", call_reason: "file_claim", call_reason_source: "server", claim_number: "CLM-104472" }, error: null }];
    const row = await fetchCall("c1");
    expect(row).toMatchObject({ call_reason: "file_claim", call_reason_source: "server", claim_number: "CLM-104472" });
    expect(reads[0]!.columns.split(",")).toEqual(expect.arrayContaining(["call_reason", "call_reason_source", "claim_number", "caller_type"]));
  });

  it("falls back to the 0006 columns while 0007_fnol_reasons.sql is not applied yet, keeping the caller type", async () => {
    answers = [
      { data: null, error: { code: "42703", message: "column call_interactions.call_reason does not exist" } },
      { data: { vapi_call_id: "c1", caller_type: "existing" }, error: null },
    ];
    const row = await fetchCall("c1");
    expect(row).toMatchObject({ caller_type: "existing" });
    expect(row?.call_reason).toBeUndefined();
    expect(reads).toHaveLength(2);
    const second = reads[1]!.columns.split(",");
    expect(second).toContain("caller_type");
    expect(second).not.toContain("call_reason");
    expect(second).not.toContain("claim_number");
  });

  it("steps back one migration at a time when both are missing", async () => {
    answers = [
      { data: null, error: { code: "42703", message: "column call_interactions.claim_number does not exist" } },
      { data: null, error: { code: "42703", message: "column call_interactions.caller_email does not exist" } },
      { data: { vapi_call_id: "c1" }, error: null },
    ];
    expect(await fetchCall("c1")).toMatchObject({ vapi_call_id: "c1" });
    expect(reads).toHaveLength(3);
    expect(reads[2]!.columns.split(",")).not.toContain("caller_type");
  });

  it("does not hide any other error behind the fallback", async () => {
    answers = [{ data: null, error: { code: "42501", message: "permission denied for table call_interactions" } }];
    await expect(fetchCall("c1")).rejects.toThrow("permission denied");
    expect(reads).toHaveLength(1);
  });
});

describe("fetchCallContact", () => {
  it("reads the call's caller_contacts row by call key, without the customer id", async () => {
    answers = [{ data: { call_key: "c1", kind: "new_customer", first_name: "Priya" }, error: null }];
    const row = await fetchCallContact("c1");
    expect(row).toMatchObject({ kind: "new_customer", first_name: "Priya" });
    expect(reads[0]).toEqual({ table: "caller_contacts", columns: CALLER_CONTACT_COLUMNS, eq: ["call_key", "c1"] });
    expect(CALLER_CONTACT_COLUMNS.split(",")).not.toContain("customer_id");
  });

  it("returns null when no contact was taken and throws on a read error", async () => {
    answers = [{ data: null, error: null }];
    expect(await fetchCallContact("c1")).toBeNull();
    answers = [{ data: null, error: { message: "relation caller_contacts does not exist" } }];
    await expect(fetchCallContact("c1")).rejects.toThrow("caller_contacts");
  });

  it("keys the contact under the call, so invalidating the call refreshes it", () => {
    expect(qk.callContact("c1").slice(0, 2)).toEqual(qk.call("c1"));
  });
});

describe("fetchCallIntake", () => {
  it("reads the call's claim_intakes row by call key, without the customer or claim ids", async () => {
    answers = [{ data: { call_key: "c1", kind: "claim", claim_number: "CLM-104472", confirmed: true }, error: null }];
    expect(await fetchCallIntake("c1")).toMatchObject({ kind: "claim", claim_number: "CLM-104472" });
    expect(reads[0]).toEqual({ table: "claim_intakes", columns: CLAIM_INTAKE_COLUMNS, eq: ["call_key", "c1"] });
    expect(CLAIM_INTAKE_COLUMNS.split(",")).not.toContain("customer_id");
    expect(CLAIM_INTAKE_COLUMNS.split(",")).not.toContain("claim_id");
    expect(CLAIM_INTAKE_COLUMNS.split(",")).toEqual(
      expect.arrayContaining(["claim_type", "loss_date", "summary", "description", "claim_number", "confirmed"]),
    );
  });

  it("returns null when no loss was reported and throws on a read error", async () => {
    answers = [{ data: null, error: null }];
    expect(await fetchCallIntake("c1")).toBeNull();
    answers = [{ data: null, error: { message: "permission denied for table claim_intakes" } }];
    await expect(fetchCallIntake("c1")).rejects.toThrow("claim_intakes");
  });

  it("keys the intake under the call, so invalidating the call refreshes it", () => {
    expect(qk.callIntake("c1").slice(0, 2)).toEqual(qk.call("c1"));
  });
});

describe("fetchCallReasonCounts", () => {
  it("asks call_reason_counts for the range and coerces bigint counts", async () => {
    answers = [{ data: [{ call_reason: "claim_status", calls: "12" }, { call_reason: "file_claim", calls: 3 }], error: null }];
    const range = { from: "2026-10-06T04:00:00.000Z", to: "2026-10-13T04:00:00.000Z" };
    expect(await fetchCallReasonCounts(range)).toEqual([
      { call_reason: "claim_status", calls: 12 },
      { call_reason: "file_claim", calls: 3 },
    ]);
    expect(rpcCalls).toEqual([["call_reason_counts", { p_from: range.from, p_to: range.to }]]);
  });

  it("throws on an RPC error", async () => {
    answers = [{ data: null, error: { message: "function call_reason_counts does not exist" } }];
    await expect(fetchCallReasonCounts({ from: "a", to: "b" })).rejects.toThrow("call_reason_counts");
  });
});
