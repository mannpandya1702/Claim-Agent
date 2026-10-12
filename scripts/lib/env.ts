// Loads .env (gitignored) into a plain object without touching Deno.env for unset keys.
// Every script reads configuration through here so a missing key fails loudly with its name.

export function loadEnv(path = new URL("../../.env", import.meta.url)): Record<string, string> {
  const out: Record<string, string> = {};
  let text = "";
  try {
    text = Deno.readTextFileSync(path);
  } catch {
    // no .env: fall back to the process environment only
  }
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  for (const [k, v] of Object.entries(Deno.env.toObject())) {
    if (v !== "") out[k] = v;
  }
  return out;
}

export function need(env: Record<string, string>, ...keys: string[]): string[] {
  const missing = keys.filter((k) => !env[k]);
  if (missing.length) {
    console.error(`missing configuration: ${missing.join(", ")} (set them in .env)`);
    Deno.exit(2);
  }
  return keys.map((k) => env[k]);
}
