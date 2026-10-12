// deno task db <command>
//   push            apply supabase/migrations/*.sql not yet recorded, in filename order, each in one transaction
//   status          list applied and pending migrations
//   query "<sql>"   run ad-hoc SQL and print the rows as JSON
//   file <path>     run a .sql file
//
// Applied versions are recorded in supabase_migrations.schema_migrations (the same table the
// Supabase CLI uses), so `supabase migration list` agrees with this runner.

import { sqlClient, lit } from "./lib/sql.ts";

const sql = sqlClient();
const dir = new URL("../supabase/migrations/", import.meta.url);

async function ensureLedger() {
  await sql(`create schema if not exists supabase_migrations;
    create table if not exists supabase_migrations.schema_migrations (
      version text primary key, statements text[], name text);`);
}

function localMigrations(): { version: string; name: string; path: URL }[] {
  const files = [...Deno.readDirSync(dir)]
    .filter((e) => e.isFile && /^\d{4}_.+\.sql$/.test(e.name))
    .map((e) => e.name)
    .sort();
  return files.map((f) => ({ version: f.slice(0, 4), name: f.slice(5, -4), path: new URL(f, dir) }));
}

async function applied(): Promise<Set<string>> {
  const rows = await sql<{ version: string }>(`select version from supabase_migrations.schema_migrations`);
  return new Set(rows.map((r) => r.version));
}

const [cmd, arg] = Deno.args;
switch (cmd) {
  case "push": {
    await ensureLedger();
    const done = await applied();
    const all = localMigrations();
    const last = [...done].sort().at(-1) ?? "0000";
    for (const m of all) {
      if (done.has(m.version)) continue;
      if (m.version < last) {
        console.error(`refusing ${m.version}_${m.name}: numbered below the last applied (${last})`);
        Deno.exit(1);
      }
      const body = Deno.readTextFileSync(m.path);
      const t0 = performance.now();
      await sql(`begin;\n${body}\n;insert into supabase_migrations.schema_migrations(version, name, statements)
        values (${lit(m.version)}, ${lit(m.name)}, array[]::text[]);\ncommit;`);
      console.log(`applied ${m.version}_${m.name} (${Math.round(performance.now() - t0)} ms)`);
    }
    console.log("migrations up to date");
    break;
  }
  case "status": {
    await ensureLedger();
    const done = await applied();
    for (const m of localMigrations()) console.log(`${done.has(m.version) ? "applied" : "PENDING"}  ${m.version}_${m.name}`);
    break;
  }
  case "query":
    console.log(JSON.stringify(await sql(arg), null, 2));
    break;
  case "file":
    console.log(JSON.stringify(await sql(Deno.readTextFileSync(arg)), null, 2));
    break;
  default:
    console.error("usage: deno task db push|status|query <sql>|file <path>");
    Deno.exit(2);
}
