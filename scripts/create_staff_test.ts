import { assertEquals, assertRejects } from "@std/assert";
import { type AuthUser, ensureStaff, findUserByEmail, PER_PAGE, type StaffAdmin } from "./create_staff.ts";

const PASSWORD = "correct-horse-battery";

function fakeAdmin(users: AuthUser[] = [], opts: { raceOnCreate?: AuthUser } = {}) {
  const staff = new Map<string, string>();
  const calls: string[] = [];
  const admin: StaffAdmin = {
    listUsers(page, perPage) {
      calls.push(`list:${page}`);
      return Promise.resolve(users.slice((page - 1) * perPage, page * perPage));
    },
    createUser(email, password) {
      calls.push(`create:${email}:${password === PASSWORD}`);
      if (opts.raceOnCreate) {
        users.push(opts.raceOnCreate);
        return Promise.reject(new Error("createUser: A user with this email address has already been registered"));
      }
      const user = { id: `user-${users.length + 1}`, email, email_confirmed_at: "2026-10-12T00:00:00Z" };
      users.push(user);
      return Promise.resolve(user);
    },
    updateUser(id, attrs) {
      calls.push(`update:${id}:${Object.keys(attrs).sort().join(",")}`);
      return Promise.resolve();
    },
    insertStaff(userId, email) {
      calls.push(`staff:${userId}`);
      if (staff.has(userId)) return Promise.resolve(false);
      staff.set(userId, email);
      return Promise.resolve(true);
    },
  };
  return { admin, staff, calls, users };
}

const confirmed = (id: string, email: string): AuthUser => ({ id, email, email_confirmed_at: "2026-01-01T00:00:00Z" });

Deno.test("a missing user is created confirmed, then gets a staff row", async () => {
  const { admin, staff, calls } = fakeAdmin([confirmed("u-other", "someone@example.com")]);
  const r = await ensureStaff(admin, "Staff@Example.com ", PASSWORD);
  assertEquals(r.user, "created");
  assertEquals(r.staffRow, "inserted");
  assertEquals(staff.get(r.userId), "staff@example.com");
  assertEquals(calls.filter((c) => c.startsWith("create:")), ["create:staff@example.com:true"]);
});

Deno.test("a second run changes nothing: same user, staff row already present", async () => {
  const { admin, calls } = fakeAdmin();
  const first = await ensureStaff(admin, "staff@example.com", PASSWORD);
  const second = await ensureStaff(admin, "staff@example.com", PASSWORD);
  assertEquals(second, {
    userId: first.userId,
    user: "existing",
    staffRow: "present",
    confirmed: false,
    passwordReset: false,
  });
  assertEquals(calls.filter((c) => c.startsWith("create:")).length, 1);
  assertEquals(calls.filter((c) => c.startsWith("update:")).length, 0);
});

Deno.test("the lookup pages through listUsers until it finds the address or a short page", async () => {
  const many = Array.from({ length: PER_PAGE + 5 }, (_, i) => confirmed(`u${i}`, `user${i}@example.com`));
  const { admin, calls } = fakeAdmin(many);
  assertEquals((await findUserByEmail(admin, "USER203@example.com"))?.id, "u203");
  assertEquals(calls, ["list:1", "list:2"]);
  assertEquals(await findUserByEmail(admin, "nobody@example.com"), null);
});

Deno.test("an existing unconfirmed user is confirmed; the password changes only on request", async () => {
  const { admin, calls } = fakeAdmin([{ id: "u1", email: "staff@example.com", email_confirmed_at: null }]);
  const r = await ensureStaff(admin, "staff@example.com", PASSWORD);
  assertEquals([r.user, r.confirmed, r.passwordReset], ["existing", true, false]);
  assertEquals(calls.filter((c) => c.startsWith("update:")), ["update:u1:email_confirm"]);

  const again = fakeAdmin([confirmed("u2", "staff@example.com")]);
  const reset = await ensureStaff(again.admin, "staff@example.com", PASSWORD, { resetPassword: true });
  assertEquals([reset.confirmed, reset.passwordReset], [false, true]);
  assertEquals(again.calls.filter((c) => c.startsWith("update:")), ["update:u2:password"]);
});

Deno.test("a user created by a concurrent run between lookup and create is reused", async () => {
  const { admin, staff } = fakeAdmin([], { raceOnCreate: confirmed("u-race", "staff@example.com") });
  const r = await ensureStaff(admin, "staff@example.com", PASSWORD);
  assertEquals([r.userId, r.user, r.staffRow], ["u-race", "existing", "inserted"]);
  assertEquals(staff.has("u-race"), true);
});

Deno.test("bad configuration fails before any admin call", async () => {
  const { admin, calls } = fakeAdmin();
  await assertRejects(() => ensureStaff(admin, "not-an-email", PASSWORD), Error, "STAFF_EMAIL");
  await assertRejects(() => ensureStaff(admin, "staff@example.com", "short"), Error, "STAFF_PASSWORD");
  assertEquals(calls, []);
});
