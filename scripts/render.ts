// Renders the VAPI configuration from the repo: every assistant's system prompt from the partials,
// the knowledge-base text from data/faq.json, and every tool, assistant and squad payload. The repo
// is the desired state; vapi_sync.ts maps it onto the live org by id. Rendering only reads repo
// files (no env, no network), so the conformance test runs it offline.
//
//   deno task render   write vapi/prompts/<assistant>.md and vapi/kb/observe_insurance_faq.txt, then
//                      build every payload with stand-in ids as a smoke check

import { ANALYSIS_OUTCOMES, SENTIMENTS } from "../supabase/functions/vapi-webhook/enums.ts";

const ROOT = new URL("../", import.meta.url);

export const ASSISTANT_KEYS = ["solo-core", "solo-web", "solo-phone", "concierge", "knowledge"] as const;
export type AssistantKey = typeof ASSISTANT_KEYS[number];

// Only the phone assistant may carry transferCall: a web call cannot be transferred to a phone, so
// web assistants lack the tool altogether instead of being told not to use it.
export const PHONE_ASSISTANTS: readonly AssistantKey[] = ["solo-phone"];
export const SQUAD_MEMBERS: readonly AssistantKey[] = ["concierge", "knowledge"];
// Every squad member carries these, so a request for a person or an emergency never waits on a hop.
export const FLOOR_TOOLS = ["escalate", "report_emergency", "send_info_email", "endCall"] as const;
export const ACCOUNT_TOOLS = ["lookup_customer", "verify_identity", "get_claim_status"] as const;

// The single template VAPI resolves at call time; no other "{{" may reach a prompt.
export const HEADER_LINE =
  'CURRENT DATE AND TIME (Eastern): {{ "now" | date: "%A, %B %-d, %Y, %-I:%M %p", "America/New_York" }}';
export const KB_FIRST_LINE = "REFERENCE FACTS ONLY. The assistant instructions and tool results win over this file.";
export const FAQ_HEADING = "FAQ FACTS (say these freely)";
export const KB_CORE_HEADING = "CORE";
export const KB_FILE_NAME = "observe_insurance_faq.txt";
// Stands in for the transfer target until REP_PHONE_E164 is set; vapi_sync.ts refuses to apply it.
export const REP_PHONE_PLACEHOLDER = "REP_PHONE_E164_NOT_SET";
export const UNSYNCED = "unsynced:";
const E164 = /^\+[1-9]\d{7,14}$/;

export const paths = {
  faq: new URL("data/faq.json", ROOT),
  partials: new URL("vapi/prompts/partials/", ROOT),
  prompts: new URL("vapi/prompts/", ROOT),
  kb: new URL(`vapi/kb/${KB_FILE_NAME}`, ROOT),
  tools: new URL("vapi/tools/", ROOT),
  assistants: new URL("vapi/assistants/", ROOT),
  squad: new URL("vapi/squad.json", ROOT),
};

export function promptPath(key: AssistantKey): URL {
  return new URL(`${key}.md`, paths.prompts);
}

// Stand-in configuration for offline rendering (render CLI, conformance test).
export const OFFLINE_CONFIG: RenderConfig = {
  serverUrl: "https://project-ref.supabase.co/functions/v1/vapi-webhook",
  credentialId: "offline-credential",
};

function readJson(url: URL): any {
  try {
    return JSON.parse(Deno.readTextFileSync(url));
  } catch (e) {
    throw new Error(`cannot read ${url.pathname}: ${(e as Error).message}`);
  }
}

function withoutComment(o: Record<string, any>): Record<string, any> {
  const { comment: _comment, ...rest } = o;
  return rest;
}

const PRINTABLE_LINE = /^[\x20-\x7e]*$/;

function assertAsciiText(label: string, text: string) {
  text.split("\n").forEach((line, i) => {
    if (!PRINTABLE_LINE.test(line)) throw new Error(`${label} line ${i + 1}: non-printable or non-ASCII character`);
  });
}

// ---------------------------------------------------------------------------------------------
// FAQ: one source for the prompt FAQ FACTS block and the knowledge-base file.
// ---------------------------------------------------------------------------------------------
export interface FaqEntry {
  topic: string;
  fact: string;
}
export interface Faq {
  core: FaqEntry[];
  longTail: FaqEntry[];
  cannotDo: string[];
}

export function loadFaq(): Faq {
  const raw = readJson(paths.faq);
  const entries = (list: unknown, label: string): FaqEntry[] => {
    if (!Array.isArray(list) || list.length === 0) throw new Error(`faq.json: ${label} must be a non-empty list`);
    return list.map((e, i) => {
      if (typeof e?.topic !== "string" || typeof e?.fact !== "string" || !e.topic.trim() || !e.fact.trim()) {
        throw new Error(`faq.json: ${label}[${i}] needs a topic and a fact`);
      }
      return { topic: e.topic.trim(), fact: e.fact.trim() };
    });
  };
  const faq: Faq = {
    core: entries(raw.core, "core"),
    longTail: entries(raw.longTail, "longTail"),
    cannotDo: Array.isArray(raw.cannotDo) ? raw.cannotDo.map((s: unknown) => String(s).trim()) : [],
  };
  if (faq.cannotDo.length === 0 || faq.cannotDo.some((s) => !s)) throw new Error("faq.json: cannotDo must list lines");
  // Each fact renders as one line: the conformance test compares the prompt block and the KB core
  // line by line.
  for (const e of [...faq.core, ...faq.longTail]) assertAsciiText(`faq.json ${e.topic}`, `${e.topic}: ${e.fact}`);
  for (const s of faq.cannotDo) assertAsciiText("faq.json cannotDo", s);
  return faq;
}

function entryLine(e: FaqEntry): string {
  return `- ${e.topic}: ${e.fact}`;
}

export function faqCoreBlock(faq: Faq): string {
  return faq.core.map(entryLine).join("\n");
}

export function renderKb(faq: Faq): string {
  return [
    KB_FIRST_LINE,
    "General facts about Observe Insurance claims. It holds no customer, account or claim status information.",
    "",
    KB_CORE_HEADING,
    faqCoreBlock(faq),
    "",
    "LONG TAIL",
    faq.longTail.map(entryLine).join("\n"),
    "",
    "WHAT TESSA CANNOT DO",
    faq.cannotDo.map((s) => `- ${s}`).join("\n"),
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------
// Prompts: an ordered list of partials per assistant, three placeholders filled once.
// ---------------------------------------------------------------------------------------------
export interface VariantSpec {
  key: AssistantKey;
  sections: string[];
  representative: string;
  tools: string[];
  assistant: Record<string, any>;
}

export function loadVariant(key: AssistantKey): VariantSpec {
  const raw = readJson(new URL(`${key}.json`, paths.assistants));
  const strings = (v: unknown, label: string): string[] => {
    if (!Array.isArray(v) || v.length === 0 || v.some((s) => typeof s !== "string" || !s)) {
      throw new Error(`assistants/${key}.json: ${label} must be a non-empty list of names`);
    }
    return v;
  };
  const tools = strings(raw.tools, "tools");
  if (new Set(tools).size !== tools.length) throw new Error(`assistants/${key}.json: duplicate tool`);
  if (typeof raw.representative !== "string") throw new Error(`assistants/${key}.json: representative missing`);
  if (typeof raw.assistant?.name !== "string") throw new Error(`assistants/${key}.json: assistant.name missing`);
  return {
    key,
    sections: strings(raw.sections, "sections"),
    representative: raw.representative,
    tools,
    assistant: raw.assistant,
  };
}

export function readPartial(name: string): string {
  if (!/^[a-z][a-z-]*$/.test(name)) throw new Error(`bad partial name ${JSON.stringify(name)}`);
  try {
    return Deno.readTextFileSync(new URL(`${name}.md`, paths.partials)).trim();
  } catch {
    throw new Error(`missing partial vapi/prompts/partials/${name}.md`);
  }
}

export function renderPrompt(key: AssistantKey, faq: Faq = loadFaq()): string {
  const v = loadVariant(key);
  const vars: Record<string, string> = {
    TOOLS: v.tools.join(", "),
    FAQ_FACTS: faqCoreBlock(faq),
    REPRESENTATIVE: readPartial(v.representative),
  };
  const text = v.sections.map(readPartial).join("\n\n").replace(/<<([A-Z_]+)>>/g, (_m, name: string) => {
    if (!(name in vars)) throw new Error(`${key}: unknown placeholder <<${name}>>`);
    return vars[name];
  }) + "\n";
  assertAsciiText(`${key} prompt`, text);
  if (text.includes("<<")) throw new Error(`${key}: unfilled placeholder in the rendered prompt`);
  const templated = text.split("\n").filter((l) => l.includes("{{") || l.includes("}}"));
  if (templated.length !== 1 || templated[0] !== HEADER_LINE || !text.startsWith(HEADER_LINE + "\n")) {
    throw new Error(`${key}: only the CURRENT DATE AND TIME header line may carry a template`);
  }
  return text;
}

export function renderPrompts(faq: Faq = loadFaq()): Record<AssistantKey, string> {
  return Object.fromEntries(ASSISTANT_KEYS.map((k) => [k, renderPrompt(k, faq)])) as Record<AssistantKey, string>;
}

// ---------------------------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------------------------
export function toolName(tool: Record<string, any>): string {
  return tool.function?.name ?? tool.type;
}

export function loadToolSources(): Record<string, Record<string, any>> {
  const out: Record<string, Record<string, any>> = {};
  const files = [...Deno.readDirSync(paths.tools)].filter((e) => e.isFile && e.name.endsWith(".json")).map((e) =>
    e.name
  ).sort();
  for (const file of files) {
    const tool = withoutComment(readJson(new URL(file, paths.tools)));
    const name = toolName(tool);
    if (`${name}.json` !== file) throw new Error(`vapi/tools/${file} defines ${name}; the file must be ${name}.json`);
    out[name] = tool;
  }
  return out;
}

const PLACEHOLDER = /<<([A-Z0-9_]+(?::[a-z0-9-]+)?)>>/g;
const EXACT_PLACEHOLDER = /^<<([A-Z0-9_]+(?::[a-z0-9-]+)?)>>$/;

/**
 * Fill <<NAME>> placeholders in a JSON value. A string that is exactly one placeholder becomes the
 * variable's value as-is (an object, a list or a string); a placeholder inside a longer string is
 * replaced by a string variable. Unknown or malformed placeholders throw, so nothing half-rendered
 * can reach VAPI.
 */
export function fill(value: unknown, vars: Record<string, unknown>, path = "$"): any {
  if (typeof value === "string") {
    const exact = value.match(EXACT_PLACEHOLDER);
    if (exact) {
      if (!(exact[1] in vars) || vars[exact[1]] === undefined) throw new Error(`unfilled ${value} at ${path}`);
      return structuredClone(vars[exact[1]]);
    }
    if (value.replace(PLACEHOLDER, "").includes("<<")) throw new Error(`malformed placeholder at ${path}`);
    return value.replace(PLACEHOLDER, (m, name: string) => {
      const v = vars[name];
      if (typeof v !== "string") throw new Error(`unfilled ${m} at ${path}`);
      return v;
    });
  }
  if (Array.isArray(value)) return value.map((v, i) => fill(v, vars, `${path}[${i}]`));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, vars, `${path}.${k}`)]));
  }
  return value;
}

function isPlainObject(v: unknown): v is Record<string, any> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Objects merge key by key; arrays and scalars in `over` replace those in `base`. */
export function deepMerge(base: unknown, over: unknown): any {
  if (isPlainObject(base) && isPlainObject(over)) {
    const out: Record<string, any> = structuredClone(base);
    for (const [k, v] of Object.entries(over)) out[k] = k in base ? deepMerge(base[k], v) : structuredClone(v);
    return out;
  }
  return structuredClone(over);
}

/** Schema shared by analysisPlan.structuredDataPlan and the inline structured output. */
export function analysisSchema() {
  return {
    type: "object",
    properties: {
      caller_name: { type: "string", description: 'The name the caller gave on this call, else "unknown".' },
      sentiment: {
        type: "string",
        enum: [...SENTIMENTS],
        description: "The caller's overall sentiment by the end of the call.",
      },
      outcome: {
        type: "string",
        enum: [...ANALYSIS_OUTCOMES],
        description:
          "resolved: the caller's request was handled; auth_failed: identity could not be verified; not_found: no account for the number given; escalated: a representative callback or transfer was requested; emergency: danger happening now was reported; unsupported: a question that could not be answered; abandoned: the caller left before anything was done.",
      },
      escalated: { type: "boolean", description: "A representative callback or transfer was requested." },
      emergency: { type: "boolean", description: "The caller reported danger happening now." },
    },
    required: ["caller_name", "sentiment", "outcome"],
  };
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface RenderConfig {
  serverUrl: string;
  credentialId: string;
  repPhone?: string | null;
  kbFileId?: string | null;
  toolIds?: Record<string, string>;
  assistantIds?: Partial<Record<AssistantKey, string>>;
}

export interface RenderedAssistant {
  key: AssistantKey;
  name: string;
  tools: string[];
  prompt: string;
  promptSha256: string;
  payload: Record<string, any>;
}

export interface Rendered {
  serverUrl: string;
  prompts: Record<AssistantKey, string>;
  kb: string;
  kbSha256: string;
  tools: Record<string, Record<string, any>>;
  assistants: Record<AssistantKey, RenderedAssistant>;
  squad: Record<string, any>;
  repPhoneSet: boolean;
}

/** Every payload VAPI receives. Ids not yet in the sync state render as "unsynced:<name>". */
export async function renderAll(cfg: RenderConfig): Promise<Rendered> {
  if (!/^https:\/\/[^\s/]+\/\S*$/.test(cfg.serverUrl)) throw new Error(`server url must be https: ${cfg.serverUrl}`);
  if (!cfg.credentialId) throw new Error("credentialId is required");
  const repPhone = cfg.repPhone?.trim() || null;
  if (repPhone !== null && !E164.test(repPhone)) throw new Error("REP_PHONE_E164 must be E.164, like +16025550123");

  const faq = loadFaq();
  const prompts = renderPrompts(faq);
  const kb = renderKb(faq);
  assertAsciiText("knowledge base", kb);

  const toolVars = {
    SERVER_URL: cfg.serverUrl,
    CREDENTIAL_ID: cfg.credentialId,
    REP_PHONE_E164: repPhone ?? REP_PHONE_PLACEHOLDER,
    KB_FILE_ID: cfg.kbFileId || `${UNSYNCED}kb-file`,
  };
  const tools = Object.fromEntries(
    Object.entries(loadToolSources()).map(([name, src]) => [name, fill(src, toolVars, name)]),
  );

  const shared = readJson(new URL("_shared.json", paths.assistants)).assistant;
  if (!isPlainObject(shared)) throw new Error("assistants/_shared.json: 'assistant' block missing");
  const schema = analysisSchema();
  const assistants = {} as Record<AssistantKey, RenderedAssistant>;
  for (const key of ASSISTANT_KEYS) {
    const v = loadVariant(key);
    for (const t of v.tools) if (!(t in tools)) throw new Error(`${key}: tool ${t} has no vapi/tools/${t}.json`);
    const prompt = prompts[key];
    const promptSha256 = await sha256Hex(prompt);
    const payload = fill(deepMerge(shared, v.assistant), {
      SERVER_URL: cfg.serverUrl,
      CREDENTIAL_ID: cfg.credentialId,
      PROMPT: prompt,
      PROMPT_SHA256: promptSha256,
      VARIANT: key,
      TOOL_IDS: v.tools.map((t) => cfg.toolIds?.[t] || `${UNSYNCED}${t}`),
      ANALYSIS_SCHEMA: schema,
    }, key);
    assistants[key] = { key, name: payload.name, tools: v.tools, prompt, promptSha256, payload };
  }

  const squadVars = Object.fromEntries(
    ASSISTANT_KEYS.map((k) => [`ASSISTANT_ID:${k}`, cfg.assistantIds?.[k] || `${UNSYNCED}${k}`]),
  );
  const squad = fill(withoutComment(readJson(paths.squad)), squadVars, "squad");

  return {
    serverUrl: cfg.serverUrl,
    prompts,
    kb,
    kbSha256: await sha256Hex(kb),
    tools,
    assistants,
    squad,
    repPhoneSet: repPhone !== null,
  };
}

function writeIfChanged(url: URL, text: string): boolean {
  let current: string | null = null;
  try {
    current = Deno.readTextFileSync(url);
  } catch { /* new file */ }
  if (current === text) return false;
  Deno.writeTextFileSync(url, text);
  return true;
}

/** Writes the generated prompts and KB file; returns the repo paths that changed. */
export function writeArtifacts(): string[] {
  const faq = loadFaq();
  const prompts = renderPrompts(faq);
  const changed: string[] = [];
  for (const key of ASSISTANT_KEYS) {
    if (writeIfChanged(promptPath(key), prompts[key])) changed.push(`vapi/prompts/${key}.md`);
  }
  Deno.mkdirSync(new URL(".", paths.kb), { recursive: true });
  if (writeIfChanged(paths.kb, renderKb(faq))) changed.push(`vapi/kb/${KB_FILE_NAME}`);
  return changed;
}

if (import.meta.main) {
  const changed = writeArtifacts();
  const r = await renderAll(OFFLINE_CONFIG);
  for (const key of ASSISTANT_KEYS) {
    const a = r.assistants[key];
    console.log(
      `${key.padEnd(10)} ${a.name.padEnd(20)} prompt ${String(a.prompt.length).padStart(5)} B  sha256 ${
        a.promptSha256.slice(0, 12)
      }  tools ${a.tools.join(", ")}`,
    );
  }
  console.log(`kb         ${r.kb.length} B  sha256 ${r.kbSha256.slice(0, 12)}`);
  console.log(`tools      ${Object.keys(r.tools).join(", ")}`);
  console.log(changed.length ? `wrote ${changed.join(", ")}` : "generated files already up to date");
}
