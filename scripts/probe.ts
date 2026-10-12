// Hour-0 probes. Each probe spends at most one API call's worth of credit and prints what the
// live API actually accepts, so config and code are written against observed behaviour.
//
//   deno task probe p1   POST/GET/PATCH a throwaway assistant with the full production block;
//                        report every key VAPI rejects or silently drops, then delete it
//   deno task probe p3   wallet probe: one /chat turn on a transient code-tool assistant (402 = frozen)
//   deno task probe credential   create (or reuse) the Bearer custom credential for the webhook

import { loadEnv, need } from "./lib/env.ts";
import { vapiClient, VapiError } from "./lib/vapi.ts";
import { readState, writeState } from "./lib/state.ts";

const env = loadEnv();
const vapi = vapiClient(env);

async function ensureCredential(): Promise<string> {
  const state = readState();
  const [secret] = need(env, "VAPI_WEBHOOK_SECRET");
  if (state.credentialId) {
    try {
      await vapi.get(`/credential/${state.credentialId}`);
      return state.credentialId;
    } catch { /* recreate below */ }
  }
  const cred = await vapi.post("/credential", {
    provider: "custom-credential",
    name: "claims-webhook-bearer",
    authenticationPlan: { type: "bearer", token: secret },
  });
  writeState({ ...state, credentialId: cred.id });
  console.log(`created credential ${cred.id}`);
  return cred.id;
}

function fullBlock(credentialId: string) {
  const fnUrl = `${need(env, "SUPABASE_URL")[0]}/functions/v1/vapi-webhook`;
  const schema = {
    type: "object",
    properties: {
      caller_name: { type: "string" },
      sentiment: { type: "string", enum: ["positive", "neutral", "negative"] },
      outcome: {
        type: "string",
        enum: ["resolved", "auth_failed", "not_found", "escalated", "emergency", "unsupported", "abandoned"],
      },
      escalated: { type: "boolean" },
      emergency: { type: "boolean" },
    },
    required: ["caller_name", "sentiment", "outcome"],
  };
  return {
    name: "probe-throwaway",
    model: {
      provider: "openai",
      model: "gpt-5.4",
      temperature: 0.3,
      maxTokens: 400,
      messages: [{ role: "system", content: "You are a probe. Say hello." }],
    },
    voice: {
      provider: "11labs",
      model: "eleven_flash_v2_5",
      voiceId: "EXAVITQu4vr4xnSDxMaL",
      stability: 0.5,
      similarityBoost: 0.75,
      optimizeStreamingLatency: 2,
    },
    transcriber: {
      provider: "deepgram",
      model: "nova-3",
      language: "en",
      numerals: true,
      smartFormat: false,
      confidenceThreshold: 0.3,
      endpointing: 300,
      keyterm: ["Observe Insurance", "claim number", "policy number", "date of birth"],
    },
    startSpeakingPlan: {
      waitSeconds: 0.4,
      smartEndpointingPlan: { provider: "livekit" },
      customEndpointingRules: [{
        type: "assistant",
        regex: "(phone number|date of birth)",
        regexOptions: [{ type: "ignore-case", enabled: true }],
        timeoutSeconds: 2,
      }],
    },
    stopSpeakingPlan: { numWords: 2, voiceSeconds: 0.3, backoffSeconds: 2 },
    backgroundSound: "off",
    firstMessage: "Thanks for calling Observe Insurance claims support.",
    firstMessageMode: "assistant-speaks-first",
    hooks: [
      {
        on: "customer.speech.timeout",
        options: { timeoutSeconds: 10, triggerMaxCount: 3, triggerResetMode: "onUserSpeech" },
        do: [{ type: "say", exact: "Are you still there? Take your time." }],
      },
      {
        on: "customer.speech.timeout",
        options: { timeoutSeconds: 20, triggerMaxCount: 3, triggerResetMode: "onUserSpeech" },
        do: [{ type: "say", exact: "I'm still here whenever you're ready." }],
      },
      {
        on: "customer.speech.timeout",
        options: { timeoutSeconds: 40, triggerMaxCount: 1 },
        do: [
          {
            type: "say",
            exact:
              "If this is an emergency, please hang up and call 911. Otherwise, please call back any time. Goodbye.",
          },
          { type: "tool", tool: { type: "endCall" } },
        ],
      },
      {
        on: "assistant.transcriber.endpointedSpeechLowConfidence[confidence=0.1:0.3]",
        do: [{ type: "say", exact: "Sorry, I didn't catch that. Could you say it again?" }],
      },
    ],
    silenceTimeoutSeconds: 45,
    maxDurationSeconds: 900,
    server: {
      url: fnUrl,
      credentialId,
      timeoutSeconds: 20,
      backoffPlan: { type: "exponential", maxRetries: 3, baseDelaySeconds: 1 },
    },
    serverMessages: ["end-of-call-report", "status-update", 'transcript[transcriptType="final"]'],
    analysisPlan: {
      summaryPlan: {
        enabled: true,
        timeoutSeconds: 10,
        messages: [
          { role: "system", content: "Summarise the call in 2-3 sentences." },
          { role: "user", content: "{{transcript}}" },
        ],
      },
      structuredDataPlan: {
        enabled: true,
        timeoutSeconds: 10,
        schema,
        messages: [
          { role: "system", content: "Extract the fields from the transcript." },
          { role: "user", content: "{{transcript}}" },
        ],
      },
      successEvaluationPlan: { enabled: true, rubric: "PassFail" },
    },
    artifactPlan: {
      recordingEnabled: true,
      fullMessageHistoryEnabled: true,
      structuredOutputs: [{ name: "claims_call", type: "ai", description: "Caller name, sentiment, outcome", schema }],
    },
  };
}

// Compare what we sent with what VAPI stored; report keys that vanished or changed.
function diff(sent: any, got: any, path = ""): string[] {
  const out: string[] = [];
  if (sent && typeof sent === "object" && !Array.isArray(sent)) {
    for (const k of Object.keys(sent)) {
      if (!(got && k in got)) out.push(`dropped: ${path}${k}`);
      else out.push(...diff(sent[k], got[k], `${path}${k}.`));
    }
  } else if (Array.isArray(sent)) {
    if (!Array.isArray(got) || got.length !== sent.length) out.push(`changed array: ${path.slice(0, -1)}`);
    else sent.forEach((v, i) => out.push(...diff(v, got[i], `${path}${i}.`)));
  } else if (sent !== got) {
    out.push(`changed: ${path.slice(0, -1)} ${JSON.stringify(sent)} -> ${JSON.stringify(got)}`);
  }
  return out;
}

async function p1() {
  const credentialId = await ensureCredential();
  const body: any = fullBlock(credentialId);
  const rejected: string[] = [];
  let created: any;
  for (let i = 0; i < 12; i++) {
    try {
      created = await vapi.post("/assistant", body);
      break;
    } catch (e) {
      if (!(e instanceof VapiError) || e.status !== 400) throw e;
      const msgs: string[] = ([] as string[]).concat((e.body as any)?.message ?? []);
      console.log("400:", msgs.join(" | "));
      // "property X should not exist" -> strip X and retry; anything else is reported and stops
      let stripped = false;
      for (const m of msgs) {
        const match = m.match(/property (\S+) should not exist/);
        if (match) {
          const keyPath = match[1].split(".");
          let o = body;
          for (const k of keyPath.slice(0, -1)) o = o?.[k];
          if (o && keyPath.at(-1)! in o) {
            delete o[keyPath.at(-1)!];
            rejected.push(match[1]);
            stripped = true;
          }
        }
      }
      if (!stripped) throw e;
    }
  }
  if (!created) throw new Error("could not create the probe assistant");
  const got = await vapi.get(`/assistant/${created.id}`);
  const drops = diff(body, got);
  const patched = await vapi.patch(`/assistant/${created.id}`, { firstMessage: "Patched." });
  const regot = await vapi.get(`/assistant/${created.id}`);
  const patchKept = diff(body.hooks, regot.hooks).length === 0 && regot.firstMessage === "Patched.";
  await vapi.del(`/assistant/${created.id}`);
  const result = { rejected, droppedOrChanged: drops, patchKeptOtherFields: patchKept, patchedId: patched.id };
  console.log(JSON.stringify(result, null, 2));
  writeState({
    ...readState(),
    probes: { ...(readState().probes ?? {}), p1: { at: new Date().toISOString(), ...result } },
  });
}

async function p3() {
  // a transient assistant with no server: the cheapest possible /chat turn
  try {
    const r = await vapi.post("/chat", {
      assistant: {
        model: {
          provider: "openai",
          model: "gpt-5.4",
          messages: [{ role: "system", content: "Reply with the word ok." }],
        },
      },
      input: "ping",
    });
    console.log("p3 chat ok:", JSON.stringify(r.output ?? r).slice(0, 300));
  } catch (e) {
    if (e instanceof VapiError && e.status === 402) {
      console.log("p3: 402 — wallet empty or frozen; top up before any battery");
    } else throw e;
  }
}

const which = Deno.args[0];
if (which === "credential") console.log(await ensureCredential());
else if (which === "p1") await p1();
else if (which === "p3") await p3();
else {
  console.error("usage: deno task probe p1|p3|credential");
  Deno.exit(2);
}
