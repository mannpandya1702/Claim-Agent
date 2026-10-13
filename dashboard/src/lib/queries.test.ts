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

vi.mock("@/lib/supabase", () => ({
  supabaseConfigured: true,
  supabase: {
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

const { CALL_DETAIL_COLUMNS, CALLER_CONTACT_COLUMNS, fetchCall, fetchCallContact, qk } = await import("./queries");

beforeEach(() => {
  reads.length = 0;
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
