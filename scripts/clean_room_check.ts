// Clean-room guard: fails if any tracked file contains a banned string.
// The list lives in .banned-strings.local (gitignored, one string per line, # comments allowed)
// so the banned names themselves never enter the repo. A missing or empty list fails the check:
// the guard must never pass silently because it had nothing to compare against.
// Runs from .githooks/pre-push and in CI (CI skips with a notice when the list is absent there).

const listPath = new URL("../.banned-strings.local", import.meta.url);
let raw = "";
try {
  raw = Deno.readTextFileSync(listPath);
} catch {
  if (Deno.env.get("CI") === "true") {
    console.log("clean-room: no .banned-strings.local in CI (the list never leaves the developer machine); skipped");
    Deno.exit(0);
  }
  console.error("clean-room: .banned-strings.local is missing; refusing to continue");
  Deno.exit(1);
}
const banned = raw.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
if (banned.length === 0) {
  console.error("clean-room: .banned-strings.local has no entries; refusing to continue");
  Deno.exit(1);
}

const ls = new Deno.Command("git", { args: ["ls-files", "-z", "--cached", "--others", "--exclude-standard"] });
const files = new TextDecoder().decode((await ls.output()).stdout).split("\0").filter(Boolean);
const self = "scripts/clean_room_check.ts";
const hits: string[] = [];
for (const f of files) {
  if (f === self) continue;
  let text: string;
  try {
    const bytes = Deno.readFileSync(f);
    if (bytes.includes(0)) continue; // binary
    text = new TextDecoder().decode(bytes).toLowerCase();
  } catch {
    continue;
  }
  for (const b of banned) {
    // whole-word match so a banned word does not fire inside an unrelated longer word
    const re = new RegExp(`(^|[^a-z0-9])${b.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9])`);
    if (re.test(text)) hits.push(`${f}: contains a banned string (entry #${banned.indexOf(b) + 1})`);
  }
}
if (hits.length) {
  console.error("clean-room check FAILED:\n" + hits.join("\n"));
  Deno.exit(1);
}
console.log(`clean-room: ${files.length} files clean against ${banned.length} banned strings`);
