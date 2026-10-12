// Creates (or finds) the dashboard staff user and its row in the staff allowlist. Sign-ups are off
// in Supabase Auth, so this script with the service role is the only way an account comes to
// exist, and the staff row is what is_staff() checks on every dashboard read.
//
//   deno task staff                    STAFF_EMAIL / STAFF_PASSWORD from .env
//   deno task staff --reset-password   also set STAFF_PASSWORD on a user that already exists
//
// Idempotent: the user is looked up by email first (admin listUsers, paged), created confirmed
// only when absent, and the staff row is inserted with on conflict do nothing. The password is
// never printed.

import { createClient } from "@supabase/supabase-js";
import { maskEmail } from "../supabase/functions/vapi-webhook/email.ts";
import { loadEnv, need } from "./lib/env.ts";

export interface AuthUser {
  id: string;
  email?: string | null;
  email_confirmed_at?: string | null;
}

/** The few admin operations this script needs; supabase-js in main, a fake in the tests. */
export interface StaffAdmin {
  listUsers(page: number, perPage: number): Promise<AuthUser[]>;
  createUser(email: string, password: string): Promise<AuthUser>;
  updateUser(id: string, attrs: { password?: string; email_confirm?: boolean }): Promise<void>;
  /** insert into staff ... on conflict (user_id) do nothing; true when a row was inserted. */
  insertStaff(userId: string, email: string): Promise<boolean>;
}

export interface StaffResult {
  userId: string;
  user: "created" | "existing";
  staffRow: "inserted" | "present";
  confirmed: boolean; // an existing unconfirmed user was confirmed
  passwordReset: boolean;
}

export const PER_PAGE = 200;
const MAX_PAGES = 500;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ALREADY_REGISTERED_RE = /already (been )?registered|already exists|email_exists/i;

const sameEmail = (a: string | null | undefined, b: string) => (a ?? "").trim().toLowerCase() === b;

export async function findUserByEmail(admin: StaffAdmin, email: string): Promise<AuthUser | null> {
  const wanted = email.trim().toLowerCase();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const users = await admin.listUsers(page, PER_PAGE);
    const hit = users.find((u) => sameEmail(u.email, wanted));
    if (hit) return hit;
    if (users.length < PER_PAGE) return null;
  }
  throw new Error(`more than ${MAX_PAGES * PER_PAGE} auth users; refusing to page further`);
}

export async function ensureStaff(
  admin: StaffAdmin,
  email: string,
  password: string,
  opts: { resetPassword?: boolean } = {},
): Promise<StaffResult> {
  const address = email.trim().toLowerCase();
  if (!EMAIL_RE.test(address)) throw new Error("STAFF_EMAIL does not look like an email address");
  // Supabase Auth refuses shorter passwords; failing here gives the reason without a round trip.
  if (password.length < 8) throw new Error("STAFF_PASSWORD must be at least 8 characters");

  let user = await findUserByEmail(admin, address);
  let created = false;
  if (!user) {
    try {
      user = await admin.createUser(address, password);
      created = true;
    } catch (e) {
      // Another run created it between the lookup and the create: use that user.
      if (!ALREADY_REGISTERED_RE.test((e as Error).message)) throw e;
      user = await findUserByEmail(admin, address);
      if (!user) throw e;
    }
  }

  let confirmed = false;
  let passwordReset = false;
  if (!created) {
    const attrs: { password?: string; email_confirm?: boolean } = {};
    // An unconfirmed user cannot sign in with a password, so a staff account must be confirmed.
    if (!user.email_confirmed_at) attrs.email_confirm = true;
    if (opts.resetPassword) attrs.password = password;
    if (Object.keys(attrs).length > 0) {
      await admin.updateUser(user.id, attrs);
      confirmed = attrs.email_confirm === true;
      passwordReset = attrs.password !== undefined;
    }
  }

  const inserted = await admin.insertStaff(user.id, address);
  return {
    userId: user.id,
    user: created ? "created" : "existing",
    staffRow: inserted ? "inserted" : "present",
    confirmed,
    passwordReset,
  };
}

function supabaseAdmin(url: string, serviceRoleKey: string): StaffAdmin {
  const db = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return {
    async listUsers(page, perPage) {
      const { data, error } = await db.auth.admin.listUsers({ page, perPage });
      if (error) throw new Error(`listUsers: ${error.message}`);
      return data.users;
    },
    async createUser(email, password) {
      const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
      if (error) throw new Error(`createUser: ${error.message}`);
      if (!data.user) throw new Error("createUser returned no user");
      return data.user;
    },
    async updateUser(id, attrs) {
      const { error } = await db.auth.admin.updateUserById(id, attrs);
      if (error) throw new Error(`updateUser: ${error.message}`);
    },
    async insertStaff(userId, email) {
      const { data, error } = await db.from("staff")
        .upsert({ user_id: userId, email }, { onConflict: "user_id", ignoreDuplicates: true })
        .select("user_id");
      if (error) {
        if (error.code === "23505") {
          throw new Error("a staff row already holds this email for a different auth user; remove it first");
        }
        throw new Error(`staff insert: ${error.message}`);
      }
      return Array.isArray(data) && data.length > 0;
    },
  };
}

async function main(): Promise<number> {
  const args = Deno.args.filter((a) => a !== "--");
  const unknown = args.filter((a) => a !== "--reset-password");
  if (unknown.length) {
    console.error(`unknown argument ${unknown[0]}\nusage: deno task staff [--reset-password]`);
    return 2;
  }
  const env = loadEnv();
  const [url, key, email, password] = need(
    env,
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "STAFF_EMAIL",
    "STAFF_PASSWORD",
  );
  const result = await ensureStaff(supabaseAdmin(url, key), email, password, {
    resetPassword: args.includes("--reset-password"),
  });
  const notes = [
    result.confirmed ? "email confirmed" : "",
    result.passwordReset ? "password reset" : "",
  ].filter(Boolean);
  console.log(
    `staff user ${maskEmail(email)}: ${result.user} (id ${result.userId}), staff row ${result.staffRow}` +
      (notes.length ? `, ${notes.join(", ")}` : ""),
  );
  return 0;
}

if (import.meta.main) {
  try {
    Deno.exit(await main());
  } catch (e) {
    console.error(`create_staff failed: ${(e as Error).message}`);
    Deno.exit(1);
  }
}
