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
  CONTACT_ASSISTANTS,
  CONTACT_TOOLS,
  deepMerge,
  FAQ_HEADING,
  fill,
  FLOOR_TOOLS,
  HEADER_LINE,
  KB_CANNOT_DO_HEADING,
  KB_CORE_HEADING,
  KB_FIRST_LINE,
  loadFaq,
  OFFLINE_CONFIG,
  paths,
  PERSONA_NAME,
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
const FIRST_MESSAGE =
  "Hi, thanks for calling Observe Insurance claims. This is Ava, and this call may be recorded. How can I help you today?";
// The ElevenLabs voice every assistant speaks with (field names per the VAPI ElevenLabsVoice schema).
const VOICE = {
  provider: "11labs",
  voiceId: "bP6y87KyX5lwNEi7xOkX",
  model: "eleven_turbo_v2_5",
  speed: 0.8,
  stability: 0.7,
  style: 0.3,
  similarityBoost: 0.75,
  useSpeakerBoost: true,
  optimizeStreamingLatency: 3,
};
// What the platform says while a tool runs: request-start and the delayed line. Every tool sets its
// own request-start: without one VAPI picks a default filler ("Hold on a sec", "Just a sec").
const DELAYED = "Thanks for bearing with me, almost there.";
const FILLERS: Record<string, { start: string; delayed: string }> = {
  lookup_customer: { start: "Sure, one moment.", delayed: DELAYED },
  verify_identity: { start: "Okay, let me check that.", delayed: DELAYED },
  get_claim_status: { start: "Alright, let me pull up your claims.", delayed: DELAYED },
  escalate: { start: "Of course. Let me get that to our team.", delayed: DELAYED },
  // Outcome-neutral: most results are not a send (no address on file, not verified, already sent).
  send_info_email: { start: "Sure, let me check on that.", delayed: DELAYED },
  // The read-back opens with "Thanks, <name>", so the filler does not thank them too.
  capture_contact: { start: "Okay, one second.", delayed: DELAYED },
  // Without a request-start VAPI speaks a default filler of its own ("Hold on a sec"), and the
  // result opens with "Perfect", "Thanks" or "Sorry", so the filler is a neutral acknowledgement.
  confirm_contact: { start: "Okay.", delayed: DELAYED },
  // An emergency keeps a steady line rather than a cheerful one.
  report_emergency: {
    start:
      "If anyone is hurt or in immediate danger, please hang up and call 911 right now. If you are thinking about harming yourself, call or text 988.",
    delayed: "I'm still here with you.",
  },
};
// Never in a prompt, the knowledge base or anything spoken (whole words, any case).
const BANNED_WORDS = ["gotcha", "honey", "love", "sweetie", "dear"];
const RETIRED_PHRASES = ["Tessa", "virtual assistant"];
// The honest answer's second sentence promises only what the assistant can do: a live transfer on the
// phone assistant, a callback everywhere else (web calls cannot be transferred).
const DISCLOSURE_PHONE = "I'm Ava, Observe Insurance's automated assistant. I can connect you with a person anytime.";
const DISCLOSURE_WEB =
  "I'm Ava, Observe Insurance's automated assistant. I can have someone from our claims team call you back anytime.";
const CALLING_FROM_QUESTION = "Is the number you're calling from the best one to reach you?";
const BEST_NUMBER_QUESTION = "What's the best number to reach you?";

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
      // TTS reads a double hyphen literally; pauses come from commas and full stops.
      assert(!s.text.includes("--"), `${label} ${s.where}: "--" in a spoken string`);
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
  for (const heading of [KB_CORE_HEADING, "LONG TAIL", KB_CANNOT_DO_HEADING]) assert(kb.includes(`\n${heading}\n`));
  assertEquals(KB_CANNOT_DO_HEADING, `WHAT ${PERSONA_NAME.toUpperCase()} CANNOT DO`);
  assert(kb.length > 3000 && kb.length < 12000, `kb is ${kb.length} bytes`);
});

Deno.test("the FAQ FACTS block in every prompt equals the knowledge-base core", () => {
  const kbCore = blockAfter(Deno.readTextFileSync(paths.kb), KB_CORE_HEADING);
  assertEquals(kbCore.length, loadFaq().core.length);
  for (const key of ASSISTANT_KEYS) {
    assertEquals(blockAfter(Deno.readTextFileSync(promptPath(key)), FAQ_HEADING), kbCore, key);
  }
});

Deno.test("greetings: graded assistants greet as Ava and ask for the phone number; Knowledge arrives silently", () => {
  for (const key of ASSISTANT_KEYS) {
    const p = withRep.assistants[key].payload;
    if (key === "knowledge") {
      assertEquals(p.firstMessage, "");
      assertEquals(p.firstMessageMode, "assistant-speaks-first-with-model-generated-message");
    } else {
      assertEquals(p.firstMessageMode, "assistant-speaks-first");
      assertEquals(p.firstMessage, FIRST_MESSAGE, key);
    }
  }
  assert(FIRST_MESSAGE.includes(`This is ${PERSONA_NAME},`) && FIRST_MESSAGE.includes("may be recorded"));
});

// ---------------------------------------------------------------------------------------------
// Persona: voice, words, disclosure
// ---------------------------------------------------------------------------------------------
Deno.test("every assistant speaks with the same ElevenLabs voice", () => {
  for (const [label, r] of BOTH) {
    for (const key of ASSISTANT_KEYS) assertEquals(r.assistants[key].payload.voice, VOICE, `${label} ${key}`);
  }
});

Deno.test("no prompt, knowledge-base line, tool description or spoken string carries a retired name or a banned word", () => {
  const texts: Spoken[] = [];
  for (const [label, r] of BOTH) {
    for (const key of ASSISTANT_KEYS) texts.push({ where: `${label} ${key} prompt`, text: r.assistants[key].prompt });
    texts.push({ where: `${label} kb`, text: r.kb });
    for (const [name, t] of Object.entries(r.tools)) {
      texts.push({ where: `${label} ${name} description`, text: JSON.stringify(t.function ?? {}) });
    }
    texts.push(...spokenStrings(r).map((s) => ({ where: `${label} ${s.where}`, text: s.text })));
  }
  assert(texts.length > 40, "collector found too few texts");
  for (const { where, text } of texts) {
    for (const phrase of RETIRED_PHRASES) {
      assert(!text.toLowerCase().includes(phrase.toLowerCase()), `${where}: says "${phrase}"`);
    }
    for (const word of BANNED_WORDS) assert(!new RegExp(`\\b${word}\\b`, "i").test(text), `${where}: says "${word}"`);
  }
});

Deno.test("every prompt names Ava and carries the honest disclosure rule; none claims to be human", () => {
  for (const key of ASSISTANT_KEYS) {
    const prompt = Deno.readTextFileSync(promptPath(key));
    assertMatch(prompt, new RegExp(`^You are ${PERSONA_NAME}, and you answer the claims line for Observe Insurance`, "m"));
    const phone = PHONE_ASSISTANTS.includes(key);
    assert(prompt.includes(phone ? DISCLOSURE_PHONE : DISCLOSURE_WEB), `${key}: disclosure answer missing`);
    if (!phone) assert(!/connect you with a person/.test(prompt), `${key}: a web prompt promises a live connection`);
    assertMatch(prompt, /asks whether they're talking to a real person, a recording or an AI, answer honestly/);
    assertMatch(prompt, /never claim or suggest that you are a human/);
    assertMatch(prompt, /Never describe yourself as an AI, a bot or a computer unprompted/);
    assert(!/\bYou are an AI\b/.test(prompt), `${key}: the persona is not introduced as an AI`);
  }
});

Deno.test("conversation style rules are in every prompt", () => {
  for (const key of ASSISTANT_KEYS) {
    const prompt = Deno.readTextFileSync(promptPath(key));
    assertMatch(prompt, /^1\. One question at a time\./m, key);
    assertMatch(prompt, /never more than 60 words/, key);
    assertMatch(prompt, /narrow it first with one short question/, key);
    assertMatch(prompt, /"Right, you mentioned that\."/, key);
    assertMatch(prompt, /If they pause partway, stay quiet/, key);
    assertMatch(prompt, /Say 0 as "zero", never "oh"\./, key);
    assertMatch(prompt, /Speak with contractions/, key);
    // Six varied follow-ups to pick from after a general answer.
    const followUps = prompt.match(/^14\. .*$/m)?.[0].match(/"[^"]+\?"/g) ?? [];
    assertEquals(new Set(followUps).size, 6, `${key}: follow-up questions`);
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
Deno.test("function tools: the server tools, flat non-strict schemas, Bearer server, fillers and an offer on failure", () => {
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
    const filler = FILLERS[name];
    assert(filler, `${name}: no filler expectation`);
    assertEquals(byType("request-start").map((m: any) => m.content), [filler.start], name);
    assertEquals(byType("request-start")[0].blocking, name === "report_emergency", `${name} blocking`);
    assertEquals(byType("request-response-delayed").map((m: any) => m.timingMilliseconds), [3000], name);
    assertEquals(byType("request-response-delayed")[0].content, filler.delayed, name);
    assertEquals(byType("request-failed").length, 1, name);
    assert(byType("request-failed")[0].content.endsWith("?"), `${name}: request-failed must end in an offer`);
    assertEquals(t.messages.length, 3, `${name}: unexpected message types`);
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
  assertEquals(props("capture_contact"), {
    first_name: "string",
    last_name: "string",
    email: "string",
    callback_phone: "string",
  });
  assertEquals(props("confirm_contact"), { correct: "boolean" });
  // A verified caller's name comes from the account, so the names are not required of the model.
  assertEquals(withRep.tools.capture_contact.function.parameters.required, undefined);
  assertEquals(withRep.tools.confirm_contact.function.parameters.required, ["correct"]);
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

Deno.test("contact capture: the graded assistants carry both tools and the flow; Knowledge hands such callers back", () => {
  for (const t of CONTACT_TOOLS) {
    assert(!(FLOOR_TOOLS as readonly string[]).includes(t), `${t} must not be a squad floor tool`);
  }
  for (const key of ASSISTANT_KEYS) {
    const tools = toolsOf(withRep, key);
    const prompt = withRep.assistants[key].prompt;
    if (CONTACT_ASSISTANTS.includes(key)) {
      for (const t of CONTACT_TOOLS) assert(tools.includes(t), `${key} lacks ${t}`);
      for (const heading of ["NEW CALLERS", "ADDING AN EMAIL", "EMAIL ADDRESSES"]) {
        assert(prompt.split("\n").includes(heading), `${key}: section ${heading} missing`);
      }
      assertMatch(prompt, /"What's the best email address for you\? Please spell it out, letter by letter\."/);
      assertMatch(prompt, /never sooner, call capture_contact/);
      assertMatch(prompt, /call confirm_contact with no words at all/);
      assertMatch(prompt, /A yes means correct set to true, and a no means correct set to false/);
      assertMatch(prompt, /Only send_info_email's sentence can tell you that a verified caller has no email address/);
      assertMatch(prompt, /call send_info_email with topic how_to_start_claim/);
      assertMatch(prompt, /never call send_info_email for it/);
      assertMatch(prompt, /Take an email address only for those two reasons/);
      assertMatch(prompt, /leave first_name and last_name out: their name comes from the account/);
    } else {
      for (const t of CONTACT_TOOLS) assert(!tools.includes(t), `${key} carries ${t}`);
      assert(!prompt.includes("NEW CALLERS"), `${key}: the capture flow belongs to the graded assistants`);
      assertMatch(prompt, /would like help getting started with a new claim, call handoff_to_concierge/);
      assertMatch(prompt, /Never ask for, spell or read out an email address/);
    }
  }
});

Deno.test("contact branching: a would-be new caller is asked about a policy first, and not found is not always new", () => {
  for (const key of CONTACT_ASSISTANTS) {
    const prompt = withRep.assistants[key].prompt;
    assertMatch(prompt, /before giving a number, they say they want to start or file a new claim/, key);
    assertMatch(prompt, /"Do you already have a policy with us\?"/, key);
    assertMatch(prompt, /If the caller says they already have a policy or a claim with us, they're not new/, key);
    assertMatch(prompt, /If they say which part is wrong without the fix/, key);
    assertMatch(prompt, /asks what you got wrong/, key);
  }
  // Knowledge cannot take an address, so a caller who wants to spell one goes back to Concierge
  assertMatch(withRep.assistants.knowledge.prompt, /wants to spell an email address to add to their account/);
});

Deno.test("the callback question fits the channel: only the phone-only assistant asks about the calling number", () => {
  for (const key of CONTACT_ASSISTANTS) {
    const prompt = withRep.assistants[key].prompt;
    if (PHONE_ASSISTANTS.includes(key)) {
      assert(prompt.includes(CALLING_FROM_QUESTION), key);
      assert(!prompt.includes(BEST_NUMBER_QUESTION), key);
    } else {
      // Web assistants (and the web assistant answering the phone line) cannot know about a caller id,
      // so "the number I'm calling from" gets a request for the digits instead of an empty argument.
      assert(prompt.includes(BEST_NUMBER_QUESTION), key);
      assert(!prompt.includes(CALLING_FROM_QUESTION), key);
      assertMatch(prompt, /number they're calling from, ask them to say the digits/, key);
      assert(!/If they say to use the number they're calling from, leave callback_phone out/.test(prompt), key);
    }
  }
});

Deno.test("endpointing waits longer after every sentence that asks for a number, a date, a name or a spelling", async () => {
  const { sentenceFor } = await import("../supabase/functions/vapi-webhook/speak.ts");
  const rules: { re: RegExp; timeoutSeconds: number }[] = withRep.assistants["solo-core"].payload.startSpeakingPlan
    .customEndpointingRules.map((r: any) => ({
      re: new RegExp(r.regex, r.regexOptions?.some((o: any) => o.type === "ignore-case" && o.enabled) ? "i" : ""),
      timeoutSeconds: r.timeoutSeconds,
    }));
  const asks: [string, string][] = [
    // the greeting asks how Ava can help; the phone number is asked once the caller says what they need
    ["phone ask after intent", "I'd be happy to help with that. What's the phone number on your account?"],
    ["needs_dob", sentenceFor("needs_dob")],
    ["rep_queued_no_number", sentenceFor("rep_queued_no_number")],
    ["not_found_final", sentenceFor("not_found_final")],
    ["no_email_on_file", sentenceFor("no_email_on_file")],
    ["contact_invalid_email", sentenceFor("contact_invalid_email")],
    ["contact_needs_name", sentenceFor("contact_needs_name")],
    ["not_pending", sentenceFor("not_pending")],
    ["contact_retry", sentenceFor("contact_retry")],
    ["contact_retry (with number)", sentenceFor("contact_retry", { has_email: true, has_phone: true })],
    ["contact_retry (no email)", sentenceFor("contact_retry", { has_email: false })],
    ["contact_retry (email update)", sentenceFor("contact_retry", { part: "email" })],
    ["contact_needs_phone", sentenceFor("contact_needs_phone")],
    ["not_pending (verified)", sentenceFor("not_pending", { verified: true })],
    // the read-back: a yes or no, or a correction spelled or said in digits
    ["contact_readback", sentenceFor("contact_readback", { first_name: "Jane", last_name: "Doe", email: "jane@gmail.com" })],
    ["contact_readback (name only)", sentenceFor("contact_readback", { first_name: "Jane", last_name: "Doe" })],
    // the prompt's own callback questions, often answered with digits
    ["calling-from question", CALLING_FROM_QUESTION],
    ["best-number question", BEST_NUMBER_QUESTION],
  ];
  for (const [where, text] of asks) {
    const rule = rules.find((r) => r.re.test(text));
    assert(rule, `${where}: no endpointing rule waits after "${text}"`);
    assert(rule.timeoutSeconds >= 2, where);
  }
  // A spelled email has the longest pauses between parts.
  for (const [where, text] of asks.filter(([, t]) => /\bspell\b/i.test(t))) {
    assert(rules.find((r) => r.re.test(text))!.timeoutSeconds >= 3, `${where}: spelling needs the longer wait`);
  }
  // A plain answer turn does not wait.
  assert(!rules.some((r) => r.re.test(sentenceFor("email_sent"))));
});

Deno.test("variants differ only where intended", () => {
  const t = (k: AssistantKey) => toolsOf(withRep, k);
  assertEquals(t("solo-core").slice(-3), [...CONTACT_TOOLS, "endCall"]);
  assertEquals(t("solo-web"), [...t("solo-core").slice(0, 8), "faq_search", "endCall"]);
  assertEquals(t("solo-phone"), [...t("solo-core").slice(0, 8), "transferCall", "endCall"]);
  assertEquals(t("concierge"), [...t("solo-core").slice(0, 8), "handoff_to_knowledge", "endCall"]);
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
