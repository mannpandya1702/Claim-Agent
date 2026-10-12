// Static conformance over the rendered VAPI artifacts (no network): what the platform will speak,
// which tools each assistant can reach, and that every value list matches enums.ts. Runs in CI with
// the unit tests, so a prompt or config edit goes through the same gate as code.

import { assert, assertEquals, assertMatch, assertThrows } from "@std/assert";
import {
  ANALYSIS_OUTCOMES,
  INFO_EMAIL_TOPICS,
  MODEL_ESCALATION_REASONS,
  SENTIMENTS,
  SERVER_TOOLS,
  TIMEZONE,
} from "../supabase/functions/vapi-webhook/enums.ts";
import {
  ACCOUNT_TOOLS,
  ASSISTANT_KEYS,
  type AssistantKey,
  deepMerge,
  FAQ_HEADING,
  fill,
  FLOOR_TOOLS,
  HEADER_LINE,
  KB_CORE_HEADING,
  KB_FIRST_LINE,
  loadFaq,
  OFFLINE_CONFIG,
  paths,
  PHONE_ASSISTANTS,
  promptPath,
  renderAll,
  type Rendered,
  renderKb,
  renderPrompts,
  REP_PHONE_PLACEHOLDER,
  SQUAD_MEMBERS,
} from "./render.ts";
import { extraKeys, invariantProblems, leafDiff, type LiveView, patchBody } from "./vapi_sync.ts";

const FINAL_TRANSCRIPT = 'transcript[transcriptType="final"]';
const REP_PHONE = "+16025550188";
const ENDCALL_GOODBYE = "Thanks for calling Observe Insurance. Take care.";

const ALL_TOOLS = [
  ...SERVER_TOOLS,
  "endCall",
  "transferCall",
  "faq_search",
  "handoff_to_knowledge",
  "handoff_to_concierge",
];
const ids = {
  tools: Object.fromEntries(ALL_TOOLS.map((n) => [n, `tool-${n}`])),
  assistants: Object.fromEntries(ASSISTANT_KEYS.map((k) => [k, `assistant-${k}`])) as Record<AssistantKey, string>,
};

// Rendered with stand-in ids, with and without a transfer target.
const withRep = await renderAll({
  ...OFFLINE_CONFIG,
  repPhone: REP_PHONE,
  kbFileId: "kb-file-1",
  toolIds: ids.tools,
  assistantIds: ids.assistants,
});
const withoutRep = await renderAll(OFFLINE_CONFIG);
const BOTH: [string, Rendered][] = [["with REP_PHONE_E164", withRep], ["without REP_PHONE_E164", withoutRep]];

function toolsOf(r: Rendered, key: AssistantKey): string[] {
  return r.assistants[key].tools;
}

interface Spoken {
  where: string;
  text: string;
}

// Everything the platform says itself, without the model: greetings, hook lines, tool messages,
// transfer lines.
function spokenStrings(r: Rendered): Spoken[] {
  const out: Spoken[] = [];
  for (const key of ASSISTANT_KEYS) {
    const p = r.assistants[key].payload;
    if (p.firstMessage) out.push({ where: `${key}.firstMessage`, text: p.firstMessage });
    (p.hooks ?? []).forEach((h: any, i: number) =>
      (h.do ?? []).forEach((d: any, j: number) => {
        if (d.type === "say") out.push({ where: `${key}.hooks[${i}].do[${j}]`, text: d.exact });
      })
    );
  }
  for (const [name, t] of Object.entries(r.tools)) {
    (t.messages ?? []).forEach((m: any, i: number) => out.push({ where: `${name}.messages[${i}]`, text: m.content }));
    (t.destinations ?? []).forEach((d: any, i: number) => {
      if (typeof d.message === "string" && d.message) {
        out.push({ where: `${name}.destinations[${i}]`, text: d.message });
      }
      const fb = d.transferPlan?.fallbackPlan?.message;
      if (fb) out.push({ where: `${name}.destinations[${i}].fallbackPlan`, text: fb });
    });
  }
  return out;
}

function blockAfter(text: string, heading: string): string[] {
  const lines = text.split("\n");
  const start = lines.indexOf(heading);
  assert(start >= 0, `heading ${heading} not found`);
  const end = lines.indexOf("", start + 1);
  return lines.slice(start + 1, end < 0 ? undefined : end);
}

function walk(v: unknown, visit: (key: string, value: any, parent: any, path: string) => void, path = "$") {
  if (Array.isArray(v)) v.forEach((x, i) => walk(x, visit, `${path}[${i}]`));
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      visit(k, x, v, `${path}.${k}`);
      walk(x, visit, `${path}.${k}`);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Generated files
// ---------------------------------------------------------------------------------------------
Deno.test("generated prompts and knowledge-base file match a fresh render (run deno task render)", () => {
  const prompts = renderPrompts();
  for (const key of ASSISTANT_KEYS) {
    assertEquals(Deno.readTextFileSync(promptPath(key)), prompts[key], `vapi/prompts/${key}.md is stale`);
  }
  assertEquals(Deno.readTextFileSync(paths.kb), renderKb(loadFaq()), "the knowledge-base file is stale");
});

Deno.test("every prompt opens with the date header, the only template VAPI may resolve", () => {
  assert(HEADER_LINE.includes(`"${TIMEZONE}"`));
  for (const key of ASSISTANT_KEYS) {
    const prompt = Deno.readTextFileSync(promptPath(key));
    assertEquals(prompt.split("\n")[0], HEADER_LINE, key);
    const templated = prompt.split("\n").filter((l) => l.includes("{{") || l.includes("}}"));
    assertEquals(templated, [HEADER_LINE], `${key}: a template other than the header`);
    assert(!prompt.includes("<<"), `${key}: unfilled placeholder`);
    prompt.split("\n").forEach((l, i) =>
      assertMatch(l, /^[\x20-\x7e]*$/, `${key} line ${i + 1} is not printable ASCII`)
    );
  }
});

Deno.test("no placeholder survives into any payload", () => {
  for (const [label, r] of BOTH) {
    const all = JSON.stringify({ tools: r.tools, assistants: r.assistants, squad: r.squad });
    assert(!all.includes("<<"), `${label}: unfilled placeholder in a payload`);
  }
});

// ---------------------------------------------------------------------------------------------
// Tools named in prompts
// ---------------------------------------------------------------------------------------------
Deno.test("prompts name only attached tools, and every named tool exists", () => {
  const r = withRep;
  const defined = new Set(Object.keys(r.tools));
  const vocabulary = new Set<string>(defined);
  for (const t of Object.values(r.tools)) {
    for (const [p, schema] of Object.entries<any>(t.function?.parameters?.properties ?? {})) {
      vocabulary.add(p);
      for (const e of schema.enum ?? []) vocabulary.add(e);
    }
  }
  const identifier = /\b[a-z]+(?:_[a-z0-9]+)+\b|\b[a-z]+[A-Z][A-Za-z]*\b/g;
  for (const key of ASSISTANT_KEYS) {
    const prompt = r.assistants[key].prompt;
    const attached = new Set(toolsOf(r, key));
    for (const t of attached) assert(defined.has(t), `${key} attaches ${t}, which has no tool definition`);
    const listed = prompt.match(/^Exactly these, and no others: (.+)\. Never say/m);
    assert(listed, `${key}: YOUR TOOLS line missing`);
    assertEquals(listed[1].split(", "), toolsOf(r, key), `${key}: YOUR TOOLS must list exactly the attached tools`);
    for (const word of new Set(prompt.match(identifier) ?? [])) {
      assert(vocabulary.has(word), `${key}: "${word}" is no tool, parameter or enum value`);
      if (defined.has(word)) assert(attached.has(word), `${key}: prompt names ${word}, which is not attached`);
    }
  }
});

// ---------------------------------------------------------------------------------------------
// What the platform speaks
// ---------------------------------------------------------------------------------------------
Deno.test("everything spoken is printable ASCII and passes the sentence guard", async () => {
  const { assertSpeakable } = await import("../supabase/functions/vapi-webhook/speak.ts");
  for (const [label, r] of BOTH) {
    const spoken = spokenStrings(r);
    assert(spoken.length > 20, "collector found too few spoken strings");
    for (const s of spoken) {
      assert(typeof s.text === "string" && s.text.trim(), `${label} ${s.where}: empty`);
      assertMatch(s.text, /^[\x20-\x7e]+$/, `${label} ${s.where}: not printable ASCII`);
      assert(!s.text.includes("{{"), `${label} ${s.where}: template text`);
      assertSpeakable(s.text);
    }
  }
  // Core facts are said freely by every assistant, so they meet the same bar as tool sentences.
  for (const e of loadFaq().core) assertSpeakable(e.fact);
});

Deno.test("the knowledge-base file is plain ASCII reference text with no claim-status wording", () => {
  const kb = Deno.readTextFileSync(paths.kb);
  assert(kb.startsWith(KB_FIRST_LINE + "\n"));
  kb.split("\n").forEach((l, i) => assertMatch(l, /^[\x20-\x7e]*$/, `kb line ${i + 1}`));
  assert(!/claim ending in|was approved|payment of|under review|was denied|was received on/i.test(kb));
  for (const heading of [KB_CORE_HEADING, "LONG TAIL", "WHAT TESSA CANNOT DO"]) assert(kb.includes(`\n${heading}\n`));
  assert(kb.length > 3000 && kb.length < 12000, `kb is ${kb.length} bytes`);
});

Deno.test("the FAQ FACTS block in every prompt equals the knowledge-base core", () => {
  const kbCore = blockAfter(Deno.readTextFileSync(paths.kb), KB_CORE_HEADING);
  assertEquals(kbCore.length, loadFaq().core.length);
  for (const key of ASSISTANT_KEYS) {
    assertEquals(blockAfter(Deno.readTextFileSync(promptPath(key)), FAQ_HEADING), kbCore, key);
  }
});

Deno.test("greetings: graded assistants greet and ask for the phone number; Knowledge arrives silently", () => {
  for (const key of ASSISTANT_KEYS) {
    const p = withRep.assistants[key].payload;
    if (key === "knowledge") {
      assertEquals(p.firstMessage, "");
      assertEquals(p.firstMessageMode, "assistant-speaks-first-with-model-generated-message");
    } else {
      assertEquals(p.firstMessageMode, "assistant-speaks-first");
      assertMatch(p.firstMessage, /Tessa, a virtual assistant.*may be recorded.*phone number on your account\?$/);
    }
  }
});

// ---------------------------------------------------------------------------------------------
// Assistant config
// ---------------------------------------------------------------------------------------------
Deno.test("every regex compiles with its declared options and carries no inline flags", () => {
  let count = 0;
  for (const key of ASSISTANT_KEYS) {
    walk(withRep.assistants[key].payload, (k, value, parent, path) => {
      if (k !== "regex") return;
      count++;
      assert(typeof value === "string" && value, `${key} ${path}`);
      assert(!/\(\?[a-z]+\)/.test(value), `${key} ${path}: inline flags are not supported`);
      const flags = (parent.regexOptions ?? [])
        .filter((o: any) => o.enabled)
        .map((o: any) =>
          ({ "ignore-case": "i", "multi-line": "m", "whole-word": "", global: "g" } as any)[o.type] ?? ""
        )
        .join("");
      new RegExp(value, flags);
    });
  }
  assert(count >= ASSISTANT_KEYS.length);
});

Deno.test("web assistants carry no transferCall; solo-phone transfers to exactly one number", () => {
  for (const [label, r] of BOTH) {
    for (const key of ASSISTANT_KEYS) {
      const types = toolsOf(r, key).map((t) => r.tools[t].type);
      if (PHONE_ASSISTANTS.includes(key)) assert(types.includes("transferCall"), `${label} ${key}`);
      else assert(!types.includes("transferCall"), `${label}: web assistant ${key} carries transferCall`);
    }
    const transfer = r.tools.transferCall;
    assertEquals(transfer.destinations.length, 1);
    const d = transfer.destinations[0];
    assertEquals(d.type, "number");
    assertEquals(d.number, r === withRep ? REP_PHONE : REP_PHONE_PLACEHOLDER);
    // A blind PSTN transfer leaves the call once it starts: nothing a fallback plan says is ever heard.
    assertEquals(d.transferPlan, { mode: "blind-transfer" });
    const failed = transfer.messages.find((m: any) => m.type === "request-failed");
    assert(failed?.content.endsWith("?"), "transferCall request-failed must end in a question");
  }
});

Deno.test("a transfer fallback plan only where VAPI uses it, and SIP options only on SIP destinations", () => {
  let plans = 0;
  for (const [label, r] of BOTH) {
    for (const [name, t] of Object.entries(r.tools)) {
      (t.destinations ?? []).forEach((d: any, i: number) => {
        const plan = d.transferPlan;
        if (!plan) return;
        plans++;
        const where = `${label} ${name}.destinations[${i}]`;
        // OpenAPI TransferPlan.fallbackPlan: used with warm-transfer-experimental (and SIP cold
        // transfers behind an org flag); on a blind PSTN transfer the assistant is already gone.
        if ("fallbackPlan" in plan) assertEquals(plan.mode, "warm-transfer-experimental", where);
        if ("sipVerb" in plan) assertEquals(d.type, "sip", `${where}: sipVerb is SIP-only`);
      });
    }
  }
  assert(plans >= 2, "collector found no transfer plans");
});

Deno.test("the phone prompt promises no fallback line after a transfer starts", () => {
  const phone = withRep.assistants["solo-phone"].prompt;
  assert(!/transfer does not connect|told a representative is not available/i.test(phone));
  assertMatch(phone, /transfer cannot start, its failure line asks/);
});

Deno.test("analysis schema and structured output share the enums.ts value lists", () => {
  for (const key of ASSISTANT_KEYS) {
    const p = withRep.assistants[key].payload;
    const schemas = [p.analysisPlan.structuredDataPlan.schema, p.artifactPlan.structuredOutputs[0].schema];
    for (const s of schemas) {
      assertEquals(s.properties.sentiment.enum, [...SENTIMENTS]);
      assertEquals(s.properties.outcome.enum, [...ANALYSIS_OUTCOMES]);
      assert(!s.properties.outcome.enum.includes("in_progress"));
      assertEquals(s.required, ["caller_name", "sentiment", "outcome"]);
    }
    assertEquals(p.analysisPlan.summaryPlan.enabled, true);
    assertEquals(p.analysisPlan.successEvaluationPlan.rubric, "PassFail");
  }
});

Deno.test("every assistant subscribes to final transcripts and leaves clientMessages unset", () => {
  for (const key of ASSISTANT_KEYS) {
    const p = withRep.assistants[key].payload;
    assert(p.serverMessages.includes(FINAL_TRANSCRIPT), key);
    assert(p.serverMessages.includes("end-of-call-report") && p.serverMessages.includes("status-update"), key);
    assert(!("clientMessages" in p), `${key}: clientMessages must stay unset`);
    assertEquals(p.server.url, OFFLINE_CONFIG.serverUrl);
    assertEquals(p.server.credentialId, OFFLINE_CONFIG.credentialId);
    assertEquals(p.model.messages[0].content, withRep.assistants[key].prompt);
    assertEquals(p.model.toolIds, toolsOf(withRep, key).map((t) => ids.tools[t]));
    assertEquals(p.metadata, { variant: key, promptSha256: withRep.assistants[key].promptSha256 });
  }
});

Deno.test("assistant names are unique, short enough for VAPI and match the handoff targets", () => {
  const names = ASSISTANT_KEYS.map((k) => withRep.assistants[k].name);
  assertEquals(new Set(names).size, names.length);
  for (const n of names) assert(n.length <= 40, n);
  const memberNames = new Set(SQUAD_MEMBERS.map((k) => withRep.assistants[k].name));
  for (const t of Object.values(withRep.tools).filter((t) => t.type === "handoff")) {
    for (const d of t.destinations) assert(memberNames.has(d.assistantName), `handoff to ${d.assistantName}`);
  }
});

// ---------------------------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------------------------
Deno.test("function tools: the server tools, flat non-strict schemas, Bearer server, three messages", () => {
  const fns = Object.entries(withRep.tools).filter(([, t]) => t.type === "function");
  assertEquals(fns.map(([n]) => n).sort(), [...SERVER_TOOLS].sort());
  for (const [name, t] of fns) {
    assertEquals(t.async, false, name);
    assertEquals(t.function.strict, false, name);
    const params = t.function.parameters;
    assertEquals(params.type, "object", name);
    assertEquals(params.additionalProperties, false, name);
    for (const [p, s] of Object.entries<any>(params.properties)) {
      assert(["string", "integer", "number", "boolean"].includes(s.type), `${name}.${p} is not flat`);
    }
    for (const req of params.required ?? []) assert(req in params.properties, `${name} requires unknown ${req}`);
    assertEquals(t.server, {
      url: OFFLINE_CONFIG.serverUrl,
      credentialId: OFFLINE_CONFIG.credentialId,
      timeoutSeconds: 10,
    });
    const byType = (type: string) => t.messages.filter((m: any) => m.type === type);
    assertEquals(byType("request-start").length, 1, name);
    assertEquals(byType("request-start")[0].blocking, name === "report_emergency", `${name} blocking`);
    assertEquals(byType("request-response-delayed").map((m: any) => m.timingMilliseconds), [3000], name);
    assertEquals(byType("request-failed").length, 1, name);
    assert(byType("request-failed")[0].content.endsWith("?"), `${name}: request-failed must end in an offer`);
  }
  const props = (n: string) =>
    Object.fromEntries(
      Object.entries<any>(withRep.tools[n].function.parameters.properties).map(([k, s]) => [k, s.type]),
    );
  assertEquals(props("lookup_customer"), { phone: "string" });
  assertEquals(props("verify_identity"), { dob_month: "integer", dob_day: "integer", dob_year: "integer" });
  assertEquals(props("get_claim_status"), {});
  assertEquals(props("escalate"), { reason: "string", details: "string", callback_phone: "string" });
  assertEquals(props("report_emergency"), { note: "string" });
  assertEquals(props("send_info_email"), { topic: "string" });
  const start = withRep.tools.report_emergency.messages[0].content;
  assert(start.includes("911") && start.includes("988"));
});

Deno.test("tool enums match enums.ts", () => {
  const p = (n: string) => withRep.tools[n].function.parameters.properties;
  assertEquals(p("escalate").reason.enum, [...MODEL_ESCALATION_REASONS]);
  assertEquals(p("send_info_email").topic.enum, [...INFO_EMAIL_TOPICS]);
});

Deno.test("native tools: endCall says the goodbye, handoffs arrive silently, faq_search reads the KB file", () => {
  const end = withRep.tools.endCall;
  assertEquals(end.function.name, "endCall");
  assertEquals(end.messages, [{ type: "request-start", blocking: true, content: ENDCALL_GOODBYE }]);
  for (const name of ["handoff_to_knowledge", "handoff_to_concierge"]) {
    const t = withRep.tools[name];
    assertEquals(t.messages, [], name);
    assertEquals(t.destinations.length, 1, name);
    const d = t.destinations[0];
    assertEquals(d.type, "assistant");
    assertEquals(d.contextEngineeringPlan, { type: "all" });
    assertEquals(d.assistantOverrides, {
      firstMessage: "",
      firstMessageMode: "assistant-speaks-first-with-model-generated-message",
    });
  }
  const q = withRep.tools.faq_search;
  assertEquals(q.type, "query");
  assertEquals(q.knowledgeBases.length, 1);
  assertEquals(q.knowledgeBases[0].provider, "google");
  assertEquals(q.knowledgeBases[0].fileIds, ["kb-file-1"]);
  assert(withoutRep.tools.faq_search.knowledgeBases[0].fileIds[0].startsWith("unsynced:"));
});

Deno.test("squad: Concierge first, members share the floor tools, Knowledge has no account tools", () => {
  assertEquals(withRep.squad.members.map((m: any) => m.assistantId), SQUAD_MEMBERS.map((k) => ids.assistants[k]));
  assertEquals(SQUAD_MEMBERS[0], "concierge");
  assert(!("membersOverrides" in withRep.squad));
  const floor = [...FLOOR_TOOLS].sort();
  for (const key of SQUAD_MEMBERS) {
    assertEquals(
      toolsOf(withRep, key).filter((t) => (FLOOR_TOOLS as readonly string[]).includes(t)).sort(),
      floor,
      key,
    );
  }
  for (const t of ACCOUNT_TOOLS) assert(!toolsOf(withRep, "knowledge").includes(t), `knowledge carries ${t}`);
  assert(toolsOf(withRep, "concierge").includes("handoff_to_knowledge"));
  assert(toolsOf(withRep, "knowledge").includes("handoff_to_concierge"));
});

Deno.test("variants differ only where intended", () => {
  const t = (k: AssistantKey) => toolsOf(withRep, k);
  assertEquals(t("solo-web"), [...t("solo-core").slice(0, 6), "faq_search", "endCall"]);
  assertEquals(t("solo-phone"), [...t("solo-core").slice(0, 6), "transferCall", "endCall"]);
  assertEquals(t("concierge"), [...t("solo-core").slice(0, 6), "handoff_to_knowledge", "endCall"]);
  assert(!t("solo-core").includes("faq_search"));
  const strip = (k: AssistantKey) => {
    const { name: _n, model, metadata: _m, ...rest } = withRep.assistants[k].payload;
    const { messages: _msg, toolIds: _ids, ...modelRest } = model;
    return { ...rest, model: modelRest };
  };
  for (const key of ["solo-web", "solo-phone", "concierge"] as AssistantKey[]) {
    assertEquals(strip(key), strip("solo-core"));
  }
});

Deno.test("renderAll refuses a transfer target that is not E.164", async () => {
  let threw = false;
  try {
    await renderAll({ ...OFFLINE_CONFIG, repPhone: "602-555-0188" });
  } catch {
    threw = true;
  }
  assert(threw);
});

// ---------------------------------------------------------------------------------------------
// Render and sync mechanics
// ---------------------------------------------------------------------------------------------
Deno.test("fill: whole-value and inline placeholders, and loud failure on anything unfilled", () => {
  assertEquals(fill({ a: "<<OBJ>>", b: ["x <<S>> y"], c: 3 }, { OBJ: { k: [1] }, S: "s" }), {
    a: { k: [1] },
    b: ["x s y"],
    c: 3,
  });
  assertEquals(fill("<<ASSISTANT_ID:solo-web>>", { "ASSISTANT_ID:solo-web": "id-1" }), "id-1");
  assertThrows(() => fill({ a: "<<MISSING>>" }, {}), Error, "unfilled <<MISSING>> at $.a");
  assertThrows(() => fill("pre <<OBJ>>", { OBJ: {} }), Error, "unfilled");
  assertThrows(() => fill("<<lower>>", {}), Error, "malformed");
});

Deno.test("deepMerge: objects merge, arrays and scalars replace, inputs are untouched", () => {
  const base = { a: { b: 1, c: [1, 2] }, d: "x" };
  const merged = deepMerge(base, { a: { c: [3] }, e: true });
  assertEquals(merged, { a: { b: 1, c: [3] }, d: "x", e: true });
  assertEquals(base, { a: { b: 1, c: [1, 2] }, d: "x" });
});

Deno.test("leafDiff: compares only what is sent and names the leaf that drifted", () => {
  assertEquals(leafDiff({ a: 1, b: { c: [1, { d: "x" }] } }, { a: 1, b: { c: [1, { d: "x", e: 2 }] }, id: "z" }), []);
  assertEquals(leafDiff({ firstMessage: "" }, {}), []);
  assertEquals(leafDiff({ a: { b: 2 } }, { a: { b: 3 } }), ["changed: a.b 2 -> live 3"]);
  assertEquals(leafDiff({ a: [1, 2] }, { a: [1] }), ["changed: a has 1 items, expected 2"]);
  assertEquals(leafDiff({ a: "x" }, {}), ["missing: a"]);
  assertEquals(leafDiff({ m: [{ c: "p" }] }, { m: [{ c: "q" }] }), ['changed: m[0].c "p" -> live "q"']);
});

Deno.test("extraKeys: keys the live object has and the repo does not send are drift, at any depth", () => {
  const want = { name: "a", model: { provider: "openai", messages: [{ role: "system", content: "x" }] } };
  const live = {
    ...structuredClone(want),
    id: "z",
    orgId: "o",
    createdAt: "t",
    updatedAt: "t",
    latestVersion: 3,
    isServerUrlSecretSet: false,
  };
  assertEquals(extraKeys(want, live), []);
  // removed from the repo after it was applied, or added in the dashboard
  assertEquals(extraKeys(want, { ...live, hooks: [{ on: "x" }], silenceTimeoutSeconds: 45 }), [
    "hooks",
    "silenceTimeoutSeconds",
  ]);
  const nested = structuredClone(live) as any;
  nested.model.tools = [{ type: "function" }];
  nested.model.messages[0].name = "extra";
  assertEquals(extraKeys(want, nested), ["model.messages[0].name", "model.tools"]);
  // null and empty values, and server-managed keys only at the root, are not drift
  assertEquals(extraKeys(want, { ...live, voicemailMessage: null, endCallMessage: "" }), []);
  assertEquals(extraKeys(want, { ...live, model: { ...live.model, id: "m" } }), ["model.id"]);
});

Deno.test("patchBody: clears every top-level key the repo no longer sends; nested objects go whole", () => {
  const want = { name: "a", model: { provider: "openai" } };
  const live = { ...want, id: "z", hooks: [{ on: "x" }], model: { provider: "openai", tools: [] }, metadata: {} };
  assertEquals(patchBody(want, live), { name: "a", model: { provider: "openai" }, hooks: null, metadata: null });
  assertEquals(patchBody(want, { ...want, id: "z" }), want);
});

function liveViewOf(r: Rendered): LiveView {
  const tools = Object.fromEntries(Object.entries(r.tools).map(([n, t]) => [ids.tools[n], { ...t, id: ids.tools[n] }]));
  const assistants = Object.fromEntries(
    ASSISTANT_KEYS.map((k) => [k, { ...structuredClone(r.assistants[k].payload), id: ids.assistants[k] }]),
  );
  const hashes = Object.fromEntries(ASSISTANT_KEYS.map((k) => [k, r.assistants[k].promptSha256]));
  return {
    serverUrl: r.serverUrl,
    tools,
    assistants,
    squad: structuredClone(r.squad),
    recordedHashes: hashes,
    renderedHashes: hashes,
  };
}

Deno.test("sync invariants hold for the rendered org and catch each kind of break", () => {
  assertEquals(invariantProblems(liveViewOf(withRep)), []);

  const transfer = liveViewOf(withRep);
  transfer.assistants["solo-web"].model.toolIds.push(ids.tools.transferCall);
  assertEquals(invariantProblems(transfer), ["assistant solo-web: a web assistant carries transferCall"]);

  const floor = liveViewOf(withRep);
  floor.assistants.knowledge.model.toolIds = floor.assistants.knowledge.model.toolIds.filter((id: string) =>
    id !== ids.tools.endCall
  );
  assertMatch(invariantProblems(floor).join("\n"), /squad: member knowledge floor tools/);

  const url = liveViewOf(withRep);
  url.tools[ids.tools.escalate].server.url = "https://elsewhere.example/functions/v1/vapi-webhook";
  assertMatch(invariantProblems(url).join("\n"), /tool escalate: server.url/);

  const hash = liveViewOf(withRep);
  hash.recordedHashes = { ...hash.recordedHashes, concierge: "0".repeat(64) };
  assertMatch(invariantProblems(hash).join("\n"), /assistant concierge: rendered prompt .* is not the applied one/);

  const account = liveViewOf(withRep);
  account.assistants.knowledge.model.toolIds.push(ids.tools.get_claim_status);
  assertMatch(invariantProblems(account).join("\n"), /assistant knowledge: carries get_claim_status/);

  const stray = liveViewOf(withRep);
  stray.assistants["solo-core"].model.toolIds.push("tool-from-elsewhere");
  assertMatch(invariantProblems(stray).join("\n"), /solo-core: tool tool-from-elsewhere is not a synced tool/);
});
