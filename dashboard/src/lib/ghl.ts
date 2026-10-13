import type { OutboxEvent } from "./types";

/*
 * The call page's "Open in GoHighLevel" link. The GoHighLevel outbox delivery (0008_ghl.sql)
 * stores the contact it created or matched as the row's external_id; a skipped delivery (no
 * trusted phone number to match on) is delivered with none, so it gets no link. Both ids go
 * into a URL path, so anything that is not a plain id gives no link rather than a strange one.
 */

const GHL_APP = "https://app.gohighlevel.com";
const PLAIN_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function ghlContactUrl(
  events: readonly Pick<OutboxEvent, "destination" | "delivered_at" | "external_id">[],
  locationId: string | null | undefined,
): string | null {
  if (!locationId || !PLAIN_ID.test(locationId)) return null;
  const row = events.find((e) => e.destination === "ghl" && !!e.delivered_at && !!e.external_id && PLAIN_ID.test(e.external_id));
  if (!row) return null;
  return `${GHL_APP}/v2/location/${locationId}/contacts/detail/${row.external_id}`;
}
