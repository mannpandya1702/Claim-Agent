import { describe, expect, it } from "vitest";
import { ghlContactUrl } from "./ghl";

const delivered = { destination: "ghl", delivered_at: "2026-10-12T15:05:00Z", external_id: "pXq7Contact01" };

describe("ghlContactUrl", () => {
  it("links the contact a delivered GoHighLevel row recorded, in the configured location", () => {
    expect(ghlContactUrl([delivered], "Loc123abc")).toBe(
      "https://app.gohighlevel.com/v2/location/Loc123abc/contacts/detail/pXq7Contact01",
    );
  });

  it("ignores the Airtable row's record id", () => {
    const airtable = { destination: "airtable", delivered_at: "2026-10-12T15:03:00Z", external_id: "recAAA" };
    expect(ghlContactUrl([airtable], "Loc123abc")).toBeNull();
    expect(ghlContactUrl([airtable, delivered], "Loc123abc")).toContain("/contacts/detail/pXq7Contact01");
  });

  it("gives no link before delivery, for a skipped delivery, or without a location", () => {
    expect(ghlContactUrl([{ ...delivered, delivered_at: null }], "Loc123abc")).toBeNull();
    expect(ghlContactUrl([{ ...delivered, external_id: null }], "Loc123abc")).toBeNull();
    expect(ghlContactUrl([delivered], null)).toBeNull();
    expect(ghlContactUrl([delivered], "")).toBeNull();
    expect(ghlContactUrl([], "Loc123abc")).toBeNull();
  });

  it("never builds a URL from something that is not a plain id", () => {
    expect(ghlContactUrl([{ ...delivered, external_id: "../../settings" }], "Loc123abc")).toBeNull();
    expect(ghlContactUrl([{ ...delivered, external_id: "a b" }], "Loc123abc")).toBeNull();
    expect(ghlContactUrl([delivered], "loc/../x")).toBeNull();
    expect(ghlContactUrl([delivered], "javascript:alert(1)")).toBeNull();
  });
});
