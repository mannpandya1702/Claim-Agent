// Syncs the rendered VAPI configuration onto the live org, and checks the live org for drift.
// The repo is the source of truth; .sync-state.json maps every rendered object onto its live id.
//
//   deno task sync:check   render, GET every live object, report leaf diffs and broken invariants
//                          (tool server.url, no transferCall on a web assistant, one floor tool set
//                          across the squad, every rendered prompt hash recorded); exit 1 on drift
//   deno task sync:apply   create or full-object PATCH the tools, upload the knowledge-base file,
//                          the query tool, the assistants (model.toolIds), the squad and the phone
//                          number binding; record ids; re-GET until the reads agree
//   deno run --allow-env --allow-net --allow-read scripts/vapi_sync.ts print <tool|assistant|squad|kb>
//
// VAPI PATCHes replace nested objects whole, so every PATCH carries the full object; GETs can
// briefly return the previous version, so apply re-reads until a full check passes.
// solo-phone and transferCall stay off the live org until REP_PHONE_E164 is set: a transfer to a
// placeholder number must never be callable.

import { loadEnv, need } from "./lib/env.ts";
import { vapiClient, VapiError } from "./lib/vapi.ts";
import { readState, type SyncState, writeState } from "./lib/state.ts";
import {
  ACCOUNT_TOOLS,
  ASSISTANT_KEYS,
  type AssistantKey,
  FLOOR_TOOLS,
  KB_FILE_NAME,
  PHONE_ASSISTANTS,
  renderAll,
  type RenderConfig,
  type Rendered,
  SQUAD_MEMBERS,
  toolName,
} from "./render.ts";

type Vapi = ReturnType<typeof vapiClient>;
type Env = Record<string, string>;

export function webhookUrl(supabaseUrl: string): string {
  return `${supabaseUrl.replace(/\/+$/, "")}/functions/v1/vapi-webhook`;
}

function isObject(v: unknown): v is Record<string, any> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function short(v: unknown): string {
  const s = JSON.stringify(v) ?? "undefined";
  return s.length > 90 ? `${s.slice(0, 87)}...` : s;
}

/**
 * Leaf differences between what we send and what VAPI stores. Only keys we send are compared:
 * VAPI adds ids, timestamps and defaults. An empty string we send and a key VAPI leaves out (or
 * nulls) mean the same thing.
 */
export function leafDiff(desired: unknown, live: unknown, path = ""): string[] {
  const at = path || "(root)";
  if (isObject(desired)) {
    if (!isObject(live)) return [`changed: ${at} expected an object, live ${short(live)}`];
    const out: string[] = [];
    for (const [k, want] of Object.entries(desired)) {
      const p = path ? `${path}.${k}` : k;
      const got = live[k];
      if (got === undefined || got === null) {
        if (want !== "" && want !== null) out.push(`missing: ${p}`);
        continue;
      }
      out.push(...leafDiff(want, got, p));
    }
    return out;
  }
  if (Array.isArray(desired)) {
    if (!Array.isArray(live)) return [`changed: ${at} expected an array, live ${short(live)}`];
    if (live.length !== desired.length) return [`changed: ${at} has ${live.length} items, expected ${desired.length}`];
    return desired.flatMap((v, i) => leafDiff(v, live[i], `${path}[${i}]`));
  }
  return desired === live ? [] : [`changed: ${at} ${short(desired)} -> live ${short(live)}`];
}

export interface LiveView {
  serverUrl: string;
  /** Live tools keyed by id. */
  tools: Record<string, any>;
  /** Live assistants keyed by assistant key. */
  assistants: Partial<Record<AssistantKey, any>>;
  squad: any | null;
  recordedHashes: Record<string, string>;
  renderedHashes: Partial<Record<AssistantKey, string>>;
}

/** Invariants over the live objects that a leaf diff alone would not state plainly. */
export function invariantProblems(v: LiveView): string[] {
  const problems: string[] = [];
  for (const t of Object.values(v.tools)) {
    if (t?.type === "function" && t.server?.url !== v.serverUrl) {
      problems.push(`tool ${toolName(t)}: server.url is ${t.server?.url ?? "unset"}, expected ${v.serverUrl}`);
    }
  }
  const toolsOf = (a: any): { names: string[]; types: string[] } => {
    const ids: string[] = Array.isArray(a?.model?.toolIds) ? a.model.toolIds : [];
    const inline: any[] = Array.isArray(a?.model?.tools) ? a.model.tools : [];
    return {
      names: [...ids.map((id) => (v.tools[id] ? toolName(v.tools[id]) : `unknown:${id}`)), ...inline.map(toolName)],
      types: [...ids.map((id) => v.tools[id]?.type ?? "unknown"), ...inline.map((t) => t?.type)],
    };
  };
  for (const key of ASSISTANT_KEYS) {
    const a = v.assistants[key];
    if (!a) continue;
    const { names, types } = toolsOf(a);
    for (const n of names.filter((n) => n.startsWith("unknown:"))) {
      problems.push(`assistant ${key}: tool ${n.slice(8)} is not a synced tool`);
    }
    if (!PHONE_ASSISTANTS.includes(key) && types.includes("transferCall")) {
      problems.push(`assistant ${key}: a web assistant carries transferCall`);
    }
    if (key === "knowledge") {
      for (const n of ACCOUNT_TOOLS) if (names.includes(n)) problems.push(`assistant knowledge: carries ${n}`);
    }
    const rendered = v.renderedHashes[key];
    const recorded = v.recordedHashes[key];
    if (rendered && recorded !== rendered) {
      problems.push(
        `assistant ${key}: rendered prompt ${rendered.slice(0, 12)} is not the applied one (recorded ${
          recorded?.slice(0, 12) ?? "none"
        })`,
      );
    }
  }
  if (v.squad) {
    const floor = [...FLOOR_TOOLS].sort().join(",");
    const members: any[] = Array.isArray(v.squad.members) ? v.squad.members : [];
    if (members.length !== SQUAD_MEMBERS.length) {
      problems.push(`squad: ${members.length} members, expected ${SQUAD_MEMBERS.length}`);
    }
    for (const m of members) {
      const entry = Object.entries(v.assistants).find(([, a]) => a?.id === m?.assistantId);
      if (!entry) {
        problems.push(`squad: member ${m?.assistantId} is not a synced assistant`);
        continue;
      }
      const have = toolsOf(entry[1]).names.filter((n) => (FLOOR_TOOLS as readonly string[]).includes(n));
      const got = [...new Set(have)].sort().join(",");
      if (got !== floor) problems.push(`squad: member ${entry[0]} floor tools are [${got}], expected [${floor}]`);
    }
  }
  return problems;
}

async function getOrNull(vapi: Vapi, path: string): Promise<any | null> {
  try {
    return await vapi.get(path);
  } catch (e) {
    // a recorded id that no longer exists (or was never a valid id) reads as missing
    if (e instanceof VapiError && (e.status === 404 || e.status === 400)) return null;
    throw e;
  }
}

function renderConfig(env: Env, state: SyncState): RenderConfig {
  const [supabaseUrl] = need(env, "SUPABASE_URL");
  if (!state.credentialId) {
    console.error("no credentialId in .sync-state.json: run `deno task probe credential` first");
    Deno.exit(2);
  }
  return {
    serverUrl: webhookUrl(supabaseUrl),
    credentialId: state.credentialId,
    repPhone: env.REP_PHONE_E164 || null,
    kbFileId: state.kbFileId ?? null,
    toolIds: state.tools ?? {},
    assistantIds: state.assistants ?? {},
  };
}

function appliedAssistants(desired: Rendered): AssistantKey[] {
  return ASSISTANT_KEYS.filter((k) => desired.repPhoneSet || !PHONE_ASSISTANTS.includes(k));
}

function appliedTools(desired: Rendered): string[] {
  return Object.keys(desired.tools).filter((n) => desired.repPhoneSet || desired.tools[n].type !== "transferCall");
}

// The free number answers with the phone assistant once a transfer target exists, else with the
// web assistant (callback escalation only).
function phoneBinding(env: Env, state: SyncState, desired: Rendered): { id: string; key: AssistantKey } | null {
  const id = env.VAPI_PHONE_NUMBER_ID || state.phoneNumberId;
  if (!id) return null;
  return { id, key: desired.repPhoneSet ? "solo-phone" : "solo-web" };
}

interface Report {
  drift: string[];
  notes: string[];
}

async function inspect(vapi: Vapi, env: Env, state: SyncState, desired: Rendered): Promise<Report> {
  const drift: string[] = [];
  const notes: string[] = [];
  if (!desired.repPhoneSet) notes.push("REP_PHONE_E164 is not set: transferCall and solo-phone are not synced");

  const liveTools: Record<string, any> = {};
  for (const name of appliedTools(desired)) {
    const id = state.tools?.[name];
    const live = id ? await getOrNull(vapi, `/tool/${id}`) : null;
    if (!live) {
      drift.push(`tool ${name}: ${id ? `live ${id} not found` : "not created"}`);
      continue;
    }
    liveTools[id!] = live;
    drift.push(...leafDiff(desired.tools[name], live).map((d) => `tool ${name}: ${d}`));
  }

  const file = state.kbFileId ? await getOrNull(vapi, `/file/${state.kbFileId}`) : null;
  if (!file) drift.push(`kb: ${state.kbFileId ? `live file ${state.kbFileId} not found` : "not uploaded"}`);
  else {
    if (file.status !== "done") drift.push(`kb: file status is ${file.status}`);
    if (state.kbSha256 !== desired.kbSha256) drift.push("kb: rendered text changed since the last upload");
    const bytes = new TextEncoder().encode(desired.kb).length;
    if (Number(file.bytes) !== bytes) drift.push(`kb: live file has ${file.bytes} bytes, rendered ${bytes}`);
  }

  const liveAssistants: Partial<Record<AssistantKey, any>> = {};
  const renderedHashes: Partial<Record<AssistantKey, string>> = {};
  for (const key of appliedAssistants(desired)) {
    renderedHashes[key] = desired.assistants[key].promptSha256;
    const id = state.assistants?.[key];
    const live = id ? await getOrNull(vapi, `/assistant/${id}`) : null;
    if (!live) {
      drift.push(`assistant ${key}: ${id ? `live ${id} not found` : "not created"}`);
      continue;
    }
    liveAssistants[key] = live;
    drift.push(...leafDiff(desired.assistants[key].payload, live).map((d) => `assistant ${key}: ${d}`));
  }

  const squad = state.squadId ? await getOrNull(vapi, `/squad/${state.squadId}`) : null;
  if (!squad) drift.push(`squad: ${state.squadId ? `live ${state.squadId} not found` : "not created"}`);
  else drift.push(...leafDiff(desired.squad, squad).map((d) => `squad: ${d}`));

  const phone = phoneBinding(env, state, desired);
  if (!phone) notes.push("no VAPI_PHONE_NUMBER_ID: phone binding not checked");
  else {
    const live = await getOrNull(vapi, `/phone-number/${phone.id}`);
    const want = state.assistants?.[phone.key];
    if (!live) drift.push(`phone ${phone.id}: not found`);
    else if (!want || live.assistantId !== want) {
      drift.push(
        `phone ${live.number}: answers with ${live.assistantId ?? "nothing"}, expected ${phone.key} (${want})`,
      );
    }
  }

  drift.push(...invariantProblems({
    serverUrl: desired.serverUrl,
    tools: liveTools,
    assistants: liveAssistants,
    squad,
    recordedHashes: (state.promptHashes ?? {}) as Record<string, string>,
    renderedHashes,
  }));
  return { drift, notes };
}

function printReport(r: Report, desired: Rendered, state: SyncState) {
  for (const key of appliedAssistants(desired)) {
    const rendered = desired.assistants[key].promptSha256;
    const recorded = state.promptHashes?.[key];
    console.log(
      `prompt ${key.padEnd(10)} sha256 ${rendered.slice(0, 12)} (recorded ${recorded?.slice(0, 12) ?? "none"})`,
    );
  }
  for (const n of r.notes) console.log(`note: ${n}`);
  for (const d of r.drift) console.log(`DRIFT ${d}`);
  console.log(r.drift.length ? `${r.drift.length} drift finding(s)` : "no drift: the live org matches the repo");
}

async function check(vapi: Vapi, env: Env): Promise<number> {
  const state = readState();
  const desired = await renderAll(renderConfig(env, state));
  const report = await inspect(vapi, env, state, desired);
  printReport(report, desired, state);
  return report.drift.length ? 1 : 0;
}

// Merges into the state file as it is now, so ids recorded by another script are never dropped.
function save(patch: Partial<SyncState>): SyncState {
  const next = { ...readState(), ...patch };
  writeState(next);
  return next;
}

async function upsert(
  vapi: Vapi,
  kind: "tool" | "assistant" | "squad",
  id: string | undefined,
  body: unknown,
  label: string,
): Promise<string> {
  if (id) {
    try {
      await vapi.patch(`/${kind}/${id}`, body);
      console.log(`patched ${label} ${id}`);
      return id;
    } catch (e) {
      if (!(e instanceof VapiError && e.status === 404)) throw e;
      console.log(`${label}: recorded ${id} no longer exists, creating it again`);
    }
  }
  const created = await vapi.post(`/${kind}`, body);
  console.log(`created ${label} ${created.id}`);
  return created.id;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Plain-text upload: markdown uploads have failed silently before, text/plain is processed.
async function ensureKbFile(
  vapi: Vapi,
  state: SyncState,
  desired: Rendered,
): Promise<{ id: string; replaced?: string }> {
  if (state.kbFileId && state.kbSha256 === desired.kbSha256) {
    const live = await getOrNull(vapi, `/file/${state.kbFileId}`);
    if (live?.status === "done") return { id: state.kbFileId };
  }
  const form = new FormData();
  form.append("file", new Blob([desired.kb], { type: "text/plain" }), KB_FILE_NAME);
  const created = await vapi.post("/file", form);
  console.log(`uploaded kb file ${created.id}`);
  const deadline = Date.now() + 120_000;
  for (;;) {
    const f = await vapi.get(`/file/${created.id}`);
    if (f.status === "done") break;
    if (f.status === "failed") throw new Error(`kb file ${created.id} failed processing`);
    if (Date.now() > deadline) throw new Error(`kb file ${created.id} still ${f.status} after 120 s`);
    await delay(2000);
  }
  const replaced = state.kbFileId && state.kbFileId !== created.id ? state.kbFileId : undefined;
  return { id: created.id, replaced };
}

async function apply(vapi: Vapi, env: Env): Promise<number> {
  let state = readState();
  let desired = await renderAll(renderConfig(env, state));

  // 1. Tools that reference no other live object.
  const tools: Record<string, string> = { ...(state.tools ?? {}) };
  for (const name of appliedTools(desired)) {
    if (desired.tools[name].type === "query") continue;
    tools[name] = await upsert(vapi, "tool", tools[name], desired.tools[name], `tool ${name}`);
    state = save({ tools });
  }
  if (!desired.repPhoneSet) console.log("skipped transferCall and solo-phone: REP_PHONE_E164 is not set");

  // 2. Knowledge-base file, then the query tools that point at it.
  const kb = await ensureKbFile(vapi, state, desired);
  state = save({ kbFileId: kb.id, kbSha256: desired.kbSha256 });
  desired = await renderAll(renderConfig(env, state));
  for (const name of appliedTools(desired).filter((n) => desired.tools[n].type === "query")) {
    tools[name] = await upsert(vapi, "tool", tools[name], desired.tools[name], `tool ${name}`);
    state = save({ tools });
  }
  if (kb.replaced) {
    await vapi.del(`/file/${kb.replaced}`).then(
      () => console.log(`deleted superseded kb file ${kb.replaced}`),
      (e) => console.warn(`could not delete superseded kb file ${kb.replaced}: ${(e as Error).message}`),
    );
  }

  // 3. Assistants, now that every tool id is known.
  desired = await renderAll(renderConfig(env, state));
  const assistants: Record<string, string> = { ...(state.assistants ?? {}) };
  const promptHashes: Record<string, string> = { ...(state.promptHashes ?? {}) };
  for (const key of appliedAssistants(desired)) {
    const a = desired.assistants[key];
    assistants[key] = await upsert(vapi, "assistant", assistants[key], a.payload, `assistant ${key}`);
    promptHashes[key] = a.promptSha256;
    state = save({ assistants, promptHashes });
  }

  // 4. Squad, now that the member ids are known.
  desired = await renderAll(renderConfig(env, state));
  state = save({ squadId: await upsert(vapi, "squad", state.squadId, desired.squad, "squad") });

  // 5. Phone number binding (the number itself is never created here).
  const phone = phoneBinding(env, state, desired);
  if (phone) {
    const assistantId = state.assistants![phone.key];
    const live = await vapi.patch(`/phone-number/${phone.id}`, { assistantId });
    state = save({ phoneNumberId: phone.id, phoneNumber: live.number ?? state.phoneNumber });
    console.log(`phone ${live.number ?? phone.id} answers with ${phone.key}`);
  }

  // 6. Re-read until a full check agrees with what was written.
  let report: Report = { drift: [], notes: [] };
  for (let attempt = 1; attempt <= 6; attempt++) {
    report = await inspect(vapi, env, state, desired);
    if (report.drift.length === 0) break;
    await delay(1000 * attempt);
  }
  printReport(report, desired, state);
  if (report.drift.length === 0) {
    console.log("dashboard build variables:");
    console.log(`  VITE_ASSISTANT_SOLO_ID=${state.assistants?.["solo-web"] ?? ""}`);
    console.log(`  VITE_ASSISTANT_CORE_ID=${state.assistants?.["solo-core"] ?? ""}`);
    console.log(`  VITE_SQUAD_ID=${state.squadId ?? ""}`);
  }
  return report.drift.length ? 1 : 0;
}

async function print(env: Env, what: string | undefined): Promise<number> {
  const state = readState();
  const desired = await renderAll(renderConfig(env, state));
  const out = what === "kb"
    ? desired.kb
    : what === "squad"
    ? desired.squad
    : what && what in desired.tools
    ? desired.tools[what]
    : what && (ASSISTANT_KEYS as readonly string[]).includes(what)
    ? desired.assistants[what as AssistantKey].payload
    : undefined;
  if (out === undefined) {
    console.error(
      `usage: vapi_sync.ts print <${[...Object.keys(desired.tools), ...ASSISTANT_KEYS, "squad", "kb"].join("|")}>`,
    );
    return 2;
  }
  console.log(typeof out === "string" ? out : JSON.stringify(out, null, 2));
  return 0;
}

if (import.meta.main) {
  const [cmd, arg] = Deno.args;
  const env = loadEnv();
  if (cmd === "check") Deno.exit(await check(vapiClient(env), env));
  else if (cmd === "apply") Deno.exit(await apply(vapiClient(env), env));
  else if (cmd === "print") Deno.exit(await print(env, arg));
  else {
    console.error("usage: vapi_sync.ts check | apply | print <name>");
    Deno.exit(2);
  }
}
