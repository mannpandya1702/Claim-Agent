import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { CALL_TABLES, countSql, NO_EMAIL_PHONE, PHONE_CLAIMS, resetSql, SEEDED_PHONES } from "./reset_demo.ts";

Deno.test("reset empties every per-call table, deletes only phone-filed claims and never customers", () => {
  const sql = resetSql("owner@example.com");
  for (const { table } of CALL_TABLES) {
    assertStringIncludes(sql, `delete from ${table} returning 1`);
    assertStringIncludes(sql, `::int as ${table}`);
  }
  assert(CALL_TABLES.some(({ table }) => table === "claim_intakes"), "claim intakes are per-call rows");
  assert(!/delete from customers\b/.test(sql));
  // the seeded claims have no reported_call_key; only a claim a call filed is deleted
  assertEquals(sql.match(/delete from claims\b[^)]*/g), [
    "delete from claims where reported_call_key is not null returning 1",
  ]);
  assertStringIncludes(sql, `::int as ${PHONE_CLAIMS.label}`);
  assertEquals(sql.match(/\bdelete from\b/g)?.length, CALL_TABLES.length + 1);
});

Deno.test("seeded customers get the OWNER_EMAIL address, Teague keeps none", () => {
  const sql = resetSql("owner@example.com");
  assertStringIncludes(sql, `when phone_e164 = '${NO_EMAIL_PHONE}' then null else 'owner@example.com' end`);
  for (const phone of SEEDED_PHONES) assertStringIncludes(sql, `'${phone}'`);
  assertEquals(SEEDED_PHONES.length, 5);
});

Deno.test("an address that is not an email, or could break the literal, is refused", () => {
  for (const bad of ["", "owner", "owner@example", "o'wner@example.com", "a b@example.com"]) {
    assertThrows(() => resetSql(bad), Error, "OWNER_EMAIL");
  }
});

Deno.test("the dry-run count reads the same tables the reset deletes", () => {
  const sql = countSql();
  for (const { table } of CALL_TABLES) assertStringIncludes(sql, `(select count(*) from ${table})::int as ${table}`);
  assertStringIncludes(sql, `(select count(*) from claims where reported_call_key is not null)::int as phone_claims`);
});
