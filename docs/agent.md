# Agent

How Ava, the Observe Insurance claims assistant, is configured on VAPI: assistant settings, the
five variants and the squad, prompt structure, the core rules, and the tools with the sentences the
server speaks through them. Everything here is rendered from `vapi/` and `data/faq.json` by
`scripts/render.ts` and pushed by `scripts/vapi_sync.ts`.

Related: system design in [architecture.md](architecture.md), test strategy in
[reliability.md](reliability.md), call walkthroughs in [scenarios.md](scenarios.md), latency
measurements in [latency-investigation.md](latency-investigation.md).

## Contents

1. [Assistant configuration](#1-assistant-configuration)
2. [Variants and the squad](#2-variants-and-the-squad)
3. [Prompt structure](#3-prompt-structure)
4. [Core rules](#4-core-rules)
5. [Tools](#5-tools)
6. [Squad handoffs](#6-squad-handoffs)
7. [Configuration as code](#7-configuration-as-code)

---

## 1. Assistant configuration

Every assistant is `vapi/assistants/_shared.json` deep-merged with a small variant file (objects
merge, arrays and scalars replace). Variants differ only in `name`, the system prompt,
`model.toolIds`, `metadata` and, for Knowledge, the first message; a conformance test asserts that
everything else is identical across the four claims assistants.

The P1 probe (`deno task probe p1`) posts the full block to a throwaway assistant and reads it
back. When it ran on the first version of the block, nothing was rejected or dropped, including
`silenceTimeoutSeconds`, which VAPI's published DTO omits. `sync:check` now compares every live
key against the repo.

### 1.1 Model

| Setting | Value | Why |
|---|---|---|
| Provider, model | `openai`, `gpt-5.4` | A pinned id, so the model cannot change without a config change |
| `temperature` | `0.3` | Consistent tool choice; still natural in short free-text turns |
| `maxTokens` | `400` | Spoken turns are one or two sentences, but tool arguments (a loss description) share the budget |
| System prompt | Rendered from partials (section 3) | Never edited in the VAPI dashboard |
| `toolIds` | The variant's tools | Tools are standalone VAPI objects shared across assistants |

### 1.2 Transcriber

| Setting | Value | Why |
|---|---|---|
| Provider, model | `deepgram`, `nova-3`, `en` | Accurate on digits and short answers; supports keyterm prompting |
| `numerals` | `true` | Spoken digits arrive as digits, ready for `lookup_customer` |
| `smartFormat` | `false` | Formatting is the server's job (`normalisePhone`, `parseDobParts`, `normaliseEmail`, `parseLossDate`) |
| `keyterm` | Observe Insurance, claim number, policy number, date of birth, Ava, Gmail, Outlook, Hotmail, iCloud | The brand, the flow's key phrases, the persona's name and mail providers said while spelling an email |
| `endpointing` | `300` ms | Shorter values split or drop one-word "yes" and "no" answers |
| `confidenceThreshold` | `0.3` | Low-confidence speech reaches the model instead of being dropped as dead air; rule 23 handles unclear speech |

### 1.3 Voice

| Setting | Value | Why |
|---|---|---|
| Provider, model | `11labs`, `eleven_turbo_v2_5` | Low first-audio latency (below) |
| `voiceId` | The ElevenLabs voice "Ava" | One voice object on every assistant (conformance test), so a handoff never changes how she sounds |
| `speed`, `stability`, `style`, `similarityBoost` | `0.9`, `0.75`, `0`, `0.75` | A calm pace and a steady read for numbers and read-backs |
| `useSpeakerBoost` | `true` | Stays close to the source voice |
| `enableSsmlParsing` | `false` | Nothing sends SSML, and parsing costs latency |
| `optimizeStreamingLatency` | `3` | VAPI's default, written out so `sync:check` compares it |
| `language` | `en` | Turbo v2.5 requires one |
| `chunkPlan` | At least 80 characters, cut only at `.` `!` `?` | Whole sentences reach TTS, so intonation runs across a sentence |
| `backgroundSound` | `off` | No synthetic office noise on a recorded, transcribed call |

I chose Turbo v2.5 for first-audio latency and kept the slower, steadier delivery settings above.
On test phone calls with the same voice, first audio took a median of about 0.84 s per reply on
Multilingual v2 and about 0.30 s on Turbo v2.5. The Turbo call also ran other latency settings, so
the saving belongs to that combination, not to the model alone.

The server makes TTS predictable: every tool sentence passes `assertSpeakable` (printable ASCII, no
braces, no `null`, `undefined`, `json` or `data`, no run of four or more digits except the main
line), and amounts, dates and digits arrive as words ("four thousand eight hundred twenty dollars",
"Saturday, October tenth", "ending in one one five"). Zero is always "zero", and phone numbers are
read in three comma-separated groups (`speakPhone`), the same format rule 3 gives the model.

### 1.4 Turn-taking

#### `startSpeakingPlan`

- `waitSeconds: 0.4`, VAPI's default.
- `smartEndpointingPlan`: LiveKit with `waitFunction` `200 + 300 * sqrt(x) + 1500 * x^3`, where `x`
  is the probability the caller is still speaking (1 minus LiveKit's end-of-utterance probability,
  confirmed against 44 logged predictions). That gives 200 ms when the caller is surely done, about
  600 ms at x = 0.5 and 2 s at most. Left unset, VAPI's own curve waited up to 2.86 s on test calls.
  The new range is computed from the formula and not yet measured live.
- Six `customEndpointingRules`, checked in order, first match wins:

| # | Type | Matches | Wait | Purpose |
|---|---|---|---|---|
| 1 | both | Ava's last line asks to `spell` or go `letter by letter`; any caller speech | 2.5 s | A spelled email has the longest pauses |
| 2 | both | Ava asked for a number (phone cue below); the caller's words form a whole number with one "triple" (8 numerals) or one "double" (9 numerals) | 0.5 s | Deepgram writes "triple 5" as one numeral, so "6 0 2 triple 5 0 1 0 1" looked partial to rule 3 and waited 1.6 s |
| 3 | both | Phone cue; the caller has said 1 to 9 digits in all | 1.6 s | Callers read numbers in groups with pauses; ten digits match no rule and get a fast answer |
| 4 | both | Ava asked for the `date of birth` or `day and year`; the answer ends mid-date (a month, a month and day, short numbers, or "19"/"20") | 1.6 s | A date of birth comes in parts; a finished one gets no extra wait |
| 5 | assistant | Ava asked `what happened` or `a little more about` | 1.2 s | Callers think before describing a loss |
| 6 | customer | The caller's words so far end in a hearing complaint ("can't hear you", "you're breaking up", "are you there", "can you hear me", "hello? hello?") | 0.5 s | A line complaint is answered at once; `$`-anchored and last, so a pending number, date, spelling or loss keeps its own wait |

The phone cue is `(phone number|best number|reach you|right number|that number|another number|number on)`;
"right number" covers a caller reading a new number after "Is that the right number?".

VAPI validates rules with RE2, so the patterns use no lookarounds or backreferences (rule 2 spells
out each position "triple" or "double" can take), and case-insensitivity is set through
`regexOptions`, not an inline `(?i)`. Conformance tests compile every pattern, reject lookarounds,
and run each rule on transcripts as Deepgram writes them ("6 0 2 5 5 5" waits, "602 555 0101" does
not). They also check that every server sentence asking for a number waits for a partial number and
never for a whole one.

#### `stopSpeakingPlan`

| Setting | Value | Why |
|---|---|---|
| `numWords` | `0` | Barge-in on voice activity. On one test call speech-to-text took up to 7.7 s on some turns, and a word-count threshold waits for that transcript while Ava keeps talking |
| `voiceSeconds` | `0.4` | Ignores clicks and line noise but catches "wait" |
| `backoffSeconds` | `0.5` | A test call heard about four seconds of silence after an interruption, a full second of it backoff |
| `interruptionPhrases` | VAPI's 20 defaults plus "sorry", "excuse", "hang", "hey", "ava", "question" (26) | How callers actually tried to stop Ava on test calls |
| `acknowledgementPhrases` | VAPI's 22 defaults ("okay", "yeah", "mm-hmm", ...) | A backchannel never cuts her off |

Both phrase lists are written out so `sync:check` compares them. `firstMessageInterruptionsEnabled`
stays unset, so the recording notice is heard in full.

One caveat from four test phone calls: VAPI stopped Ava only when a partial transcript arrived
(0.66 to 1.23 s after the caller began on one of them), never on voice activity alone. Three of
the calls came after `numWords: 0` was committed, but the call logs do not record the live setting.
Shorter turns shrink that window.

### 1.5 Hooks, silence and limits

| Setting | Value | Why |
|---|---|---|
| `customer.speech.timeout` 10 s | "No rush, I'm right here." (up to 3 times, reset when the caller speaks) | A gentle nudge |
| `customer.speech.timeout` 20 s | "Take all the time you need." (up to 3, reset on speech) | For a caller looking for a document |
| `customer.speech.timeout` 40 s | "If this is an emergency, please hang up and call 911. Otherwise, call us back any time. Take care." then `endCall` | The only silence hangup, and it names 911: a caller may have gone quiet because something is wrong |
| `silenceTimeoutSeconds` | `45` | Above the 40 s hook, so VAPI never hangs up before the spoken goodbye |
| `maxDurationSeconds` | `900` | Bounds cost and stuck calls |

There is no low-confidence hook. One that re-asked on low-confidence speech fired on a noisy
fragment while the model answered the real sentence, and the two lines collided ("Sorry. Could you
repeat I can look into that."). Rule 23 asks the caller to repeat instead. VAPI hooks cannot react
to what the caller said or to audio quality, so line trouble is handled by rule 25.

### 1.6 Greeting and disclosure

| Setting | Value |
|---|---|
| `firstMessage` | "Hey, thanks for calling Observe Insurance claims. This is Ava, and this call may be recorded. How can I help you today?" |
| `firstMessageMode` | `assistant-speaks-first` |
| Knowledge only | `firstMessage: ""`, `assistant-speaks-first-with-model-generated-message`: it joins only through a handoff and must not greet |

The greeting asks for intent first, like a person at a claims desk. General questions then need no
lookup, and what the caller asked for is passed to `verify_identity` as its `intent`, so the
verified answer goes straight to it.

Ava never calls herself an AI unprompted and never claims or suggests she is human. Asked directly,
she answers without starting with yes or no: "I'm Ava, an AI assistant for Observe Insurance." plus
the channel's line (web: "I can still help with your claim, or have someone from our claims team
call you back if you'd rather."; phone: "... or get a person on the line if you'd rather.").

### 1.7 Server, analysis and artifacts

| Setting | Value | Why |
|---|---|---|
| `server` | Webhook URL, `credentialId`, `timeoutSeconds: 20`, exponential `backoffPlan` (3 retries, 1 s base) | One endpoint for every message; a 5xx on a post-call message is redelivered into an idempotent upsert. Tool servers have no retries |
| `serverMessages` | `end-of-call-report`, `status-update`, `transcript[transcriptType="final"]` | Only what the server uses; no partial transcripts |
| `clientMessages` | Unset | VAPI's defaults for the browser SDK (asserted by a conformance test) |
| `analysisPlan.summaryPlan` | 2 to 3 sentences: who called (first name only), existing or new caller, what was asked and resolved, next step; never a DOB, full phone number, email or policy number | PII is excluded at the source, and the server redacts again |
| `analysisPlan.structuredDataPlan` | `caller_name`, `sentiment`, `outcome`, `escalated`, `emergency`, `call_reason`, with the schema generated from `enums.ts` | The analysis can never produce a value the database rejects |
| `analysisPlan.successEvaluationPlan` | `PassFail` | A cheap per-call quality signal |
| `artifactPlan` | Recording, full message history, structured output `claims_call` with the same schema | Full history keeps a squad call's analysis complete; two analysis paths so the record does not depend on either alone |
| `metadata` | `variant`, `promptSha256` | `sync:check` proves which prompt is live |

The analysis is the second source, never the first: outcome and call reason come from server facts
when they exist ([architecture.md](architecture.md#8-post-call-pipeline-and-outbox)).

---

## 2. Variants and the squad

All five variants are Ava, rendered from the same partials and shared block. They differ in what
each can do, and the attached tools enforce that rather than prompt wording.

| Key | Name | Tools | Knowledge rule | Representative | Status |
|---|---|---|---|---|---|
| `solo-web` | Observe Claims Web | Server tools, `faq_search`, `endCall` | `knowledge-kb` | Callback (`escalate`) | Synced; default on `#/call`; answers +1 520 521 0277 |
| `solo-core` | Observe Claims Core | Server tools, `endCall` | `knowledge-core` | Callback | Synced; fallback with no optional dependencies; the prompt the persona battery runs |
| `concierge` | Concierge | Server tools, `handoff_to_knowledge`, `endCall` | `knowledge-handoff` | Callback | Synced; squad member 1 |
| `knowledge` | Knowledge | `faq_search`, `handoff_to_concierge`, `escalate`, `report_emergency`, `send_info_email`, `endCall` | `knowledge-kb` | Callback | Synced; squad member 2 |
| `solo-phone` | Observe Claims Phone | Server tools, `transferCall` (blind), `endCall` | `knowledge-core` | Transfer, callback if it cannot start | Built and tested; not synced until `REP_PHONE_E164` is set |

The ten server tools are `lookup_customer`, `verify_identity`, `get_claim_status`, `escalate`,
`report_emergency`, `send_info_email`, `capture_contact`, `confirm_contact`, `start_claim` and
`confirm_claim`.

A browser call cannot be transferred to a phone number, so web variants do not carry
`transferCall`; `sync:check` and a conformance test both fail if one does. Until a transfer target
exists, +1 520 521 0277 answers with Observe Claims Web; `vapi_sync.ts` rebinds it to `solo-phone`
once `REP_PHONE_E164` is set.

The squad (`vapi/squad.json`, `observe-claims-web`) is Concierge, then Knowledge, with no
`membersOverrides`:

- Concierge greets and owns identity, claim status, contact capture and claim intake, so those flows
  behave the same with or without the squad.
- Every member carries the floor tools (`escalate`, `report_emergency`, `send_info_email`, `endCall`;
  `FLOOR_TOOLS` in `render.ts`), so a request for a person or an emergency never waits on a hop.
- Knowledge has no account, contact or claim tools, so a policy question can never touch account
  data. A caller who wants to give details or report a loss is handed back.
- Without `membersOverrides`, each member keeps its own server, credential and analysis settings.
- Identity, contacts and intakes survive a handoff because they live in Postgres, keyed on the call.

---

## 3. Prompt structure

```mermaid
flowchart LR
  faq["data/faq.json"] --> r["scripts/render.ts"]
  parts["vapi/prompts/partials/*.md"] --> r
  var["vapi/assistants/variant.json<br/>sections, slots, tools"] --> r
  enums["enums.ts<br/>analysis schema"] --> r
  r --> md["vapi/prompts/variant.md<br/>(committed)"]
  r --> kbf["vapi/kb/observe_insurance_faq.txt"]
  r --> pay["tool, assistant, squad payloads"]
  pay --> sync["vapi_sync.ts apply"] --> live["VAPI org"]
  kbf --> sync
```

Each variant file lists its `sections` in order; `render.ts` joins the partials and fills the
placeholders:

| Placeholder | Filled with |
|---|---|
| `<<TOOLS>>` | The variant's tool names, so the prompt names exactly the attached tools |
| `<<FAQ_FACTS>>` | The five core facts from `data/faq.json`: office hours, mailing address, starting a claim, how claims work, sending documents |
| `<<REPRESENTATIVE>>` | `representative-web` or `representative-phone`, which becomes rule 8 |
| `<<EMAIL>>` (slot) | `email-capture` or `email-knowledge`, which becomes rule 18 |
| `<<CALLBACK>>` (slot) | `callback-web` ("What's the best number to reach you?") or `callback-phone` ("Is the number you're calling from the best one to reach you?") |
| `<<DISCLOSURE>>` (slot) | `disclosure-web` or `disclosure-phone`, the second sentence of the rule 22 answer |

Section order for the four claims assistants (`solo-core`, `solo-web`, `solo-phone`, `concierge`):
`header`, `role`, `tools`, `rules`, `identity`, `claims`, `branches`, `branches-identity`,
`contact`, `claim-intake`, `faq`, one knowledge partial, `errors`, `ending`, `style`. Knowledge uses
`header`, `role-knowledge`, `tools`, `rules`, `flow-knowledge`, `return`, `branches`, `faq`,
`knowledge-kb`, `errors`, `ending`, `style`.

| Partial | Content |
|---|---|
| `header` | Current Eastern date and time, so "are you open now?" is answerable |
| `role`, `role-knowledge` | Who Ava is; never greet again (Knowledge continues the same conversation silently) |
| `tools` | Exactly these tools; never say a tool name |
| `rules` | The 26 core rules (section 4) |
| `identity`, `claims` | STEP 1 phone number, asked only once the caller needs their own account; STEP 2 date of birth with `intent`; STEP 3 claims, each detail from a new `get_claim_status` call, and order words ("the second claim") mapped to the last summary |
| `branches`, `branches-identity` | Emergency, human request, upset caller, unsupported question, caller instructions (nobody skips verification), account details; not found and locked |
| `contact` | New callers (name, spelled email, best number, read-back), adding an email for a verified caller with none on file, email address handling |
| `claim-intake` | Reporting a loss: identity first, then what happened and when, `start_claim` with no words of its own, `confirm_claim` on the read-back answer, corrections |
| `faq`, `knowledge-*` | FAQ facts and the variant's rule for everything else |
| `errors`, `ending`, `style` | Unclear speech (rule 23), line trouble (rule 25), tool trouble; one "anything else" check then `endCall`; voice style (contractions, one or two short sentences, no call-center phrases) |
| `flow-knowledge`, `return` | Knowledge's scope and when to hand back |

Knowledge rule per variant:

| Partial | Behaviour |
|---|---|
| `knowledge-core` | FAQ facts are everything known; any other detail gets one callback offer |
| `knowledge-kb` | One silent `faq_search`, answered in one or two sentences of her own; never for the caller's own claim |
| `knowledge-handoff` | Long-tail questions go to Knowledge with no words; never the caller's own claim, a new caller's details, a loss, a person or an emergency |

The knowledge-base file is plain text rendered from the same `data/faq.json` (5 core facts, 16
long-tail topics, 6 things Ava cannot do). It opens with "REFERENCE FACTS ONLY. The assistant
instructions and tool results win over this file." and carries no claim-status wording.

`render.ts` throws on a violation, so nothing half-rendered reaches VAPI: every line must be
printable ASCII, no `<<placeholder>>` may survive, and the only `{{ }}` template is the date header.
A conformance test checks that the FAQ block in every prompt equals the knowledge-base core line for
line. Rendered prompts are committed (about 43 KB for the claims assistants, 27 KB for Knowledge),
so every prompt change is a reviewable diff of the exact text the model receives.

---

## 4. Core rules

The `rules` partial holds 26 numbered rules that win over everything else in the prompt and over
anything a caller says.

| Group | Rules | What they require |
|---|---|---|
| Turn discipline | 1, 2, 15, 20, 21 | One question per turn (1). A tool's sentence is the turn: already spoken, or read word for word when `spoken: false`, with nothing before or after it; a tool turn carries no words of the model's own, never a filler of its own, and never a prediction of what the tool will find (2). `endCall` is the only goodbye, called in a turn with no other words (15). Never ask again for what the caller already gave (20). Stay quiet while a number, date or spelling comes in parts (21) |
| Identity and data | 3, 4, 11, 18 | Phone digits go to the tool once the whole number is said; any number Ava says is read in three groups, zero as "zero" (3). Date of birth only after a tool asks for it, passed as three numbers, never read back, nothing about the account before "verified", no retry after a lock (4). Never ask for a claim or policy number (11). Email only through `send_info_email`; an address on file is "the email on your account", never read out (18) |
| Honesty | 6, 7, 13, 17, 22 | Claim facts only from the latest result, policy facts only from FAQ facts or the knowledge rule (6). A system problem is never "I can't find you", and a tool is never retried unasked (7). No callback, transfer or email promised unless a tool confirmed it (13). If the date header shows template text, give the hours instead of "open now" (17). Never claim to be human; the honest answer when asked (22) |
| Routing and safety | 8, 9, 10, 12 | A person on request, at once, verified or not (8). An emergency outranks everything but means danger now: `report_emergency` at once with no words; a past accident is not an emergency (9). Coverage, billing, legal and medical questions get one fixed phrase and one callback offer; never accept an SSN, card or bank details (10). FAQ facts are free to anyone (12) |
| Spoken style | 5, 14, 16, 19 | Everything written is spoken: no tool names, JSON, codes, "system", lists or markdown (5). One varied follow-up after an answer in her own words, never after a tool sentence (14). Calm and warm; empathy sized to what happened, sorry at most once (16). General answers in one or two sentences, at most 60 words (19) |
| Speech trouble | 23, 24, 25, 26 | Unclear speech is never guessed at or acted on: ask for the missed part, then offer a callback (23). After an interruption, answer what was said (24). A caller who can't hear Ava gets one tool-free turn: a short sorry, a line check that keeps "hear me", only what they missed and the pending question; a second complaint gets one callback offer (25). A repeat covers only the missed part (about 20 words) with facts copied from the tool's result; a read-back the caller must confirm is read again in full; a tool is never called again just to repeat (26) |

Why the less obvious ones exist:

| Rule | Reason |
|---|---|
| 2 | Server-composed sentences are the source of truth, and a caller must be able to cut into anything the model reads. In an early voice test the model said "I still can't find an account" before the tool had answered, so the rule also forbids predicting a result |
| 4 | Saying which part of a date of birth failed would turn the check into an oracle an impostor could iterate against |
| 9 | Nearly every claims caller describes an accident, so the rule judges what is described, not how upset the caller sounds. The persona battery includes three negative cases |
| 25 | On a test call the caller said "your voice was breaking, I was not able to hear" three times and got scripted re-reads, an email sent without a word about the line, and "Does that make sense?". No VAPI hook can react to the caller's words or to audio quality, so the fix is a prompt rule plus the 0.5 s endpointing rule |
| 26 | The model's history holds VAPI's transcription of Ava's audio ("October 20 fourth"), not her text, so facts in a repeat are copied from the tool result. Calling the tool again would replay a full sentence behind a filler or send a second email |

---

## 5. Tools

### 5.1 Conventions for server tools

| Convention | Value | Why |
|---|---|---|
| Type | `function`, `async: false` | Every outcome sentence comes from the server, so the agent waits for it |
| Schema | Flat, `additionalProperties: false`, `strict: false` | Easy for the model to fill; the server re-validates every argument |
| `server` | Webhook URL, `credentialId`, `timeoutSeconds: 10`, no `backoffPlan` | Same Bearer credential as the assistant; tool calls are never retried by configuration |
| `request-start` | One short filler; blocking only for `report_emergency` | Covers database latency; the safety line must finish first |
| `request-response-delayed` | At 3,000 ms: "Thanks for bearing with me, almost there." (`report_emergency`: "I'm still here with you.") | A second reassurance on a slow call |
| `request-failed` | One line ending in a question that offers the next step | Spoken only when the HTTP call itself fails; the handler answers 200 even on a server fault |
| Result | `{code, message, data?}` inside `result` | The model's history matches what the caller heard |

A conformance test pins these conventions, each tool's exact filler and its parameter names and
types.

### 5.2 Tool reference

| Tool | Arguments | Server behaviour | Result codes | Filler |
|---|---|---|---|---|
| `lookup_customer` | `phone` | Any ten digits (or eleven with a leading 1) are looked up; `lookup_customer_attempt` runs under the session lock with the replay guard | `needs_dob`, `not_found`, `not_found_final`, `invalid_phone`, `already_verified`, `locked` | "Sure, let me look that up." |
| `verify_identity` | `dob_month`, `dob_day`, `dob_year`; optional `intent` (`claim_status`, `file_claim`, `other`) | Rejects impossible dates, then `verify_dob_attempt`. On a match, `claim_status` reads the claims in the same turn (recorded as its own ledger row) and `file_claim` asks what happened. With `PRIOR_CONTACTS_ENABLED`, a returning caller hears "Welcome back." | `verified`, `auth_failed`, `locked`, `dob_unreadable`, `dob_give_up`, `no_lookup_yet` | "Okay, let me check that." |
| `get_claim_status` | Optional `detail` (`summary`, `documents`, `claim`) and `claim_ending`; no account argument | Reads only the verified session's customer. `summary`: at most four clauses within 60 spoken words, the rest counted. `documents`: up to two claims awaiting documents with list, due date and how to send. `claim`: one claim in full | `ok`, `claim_documents`, `no_documents_needed`, `claim_detail`, `claim_not_identified`, `no_claims`, `not_verified` | "Sure, one moment." |
| `escalate` | `reason` (`representative_requested`, `unsupported_question`, `transfer_failed`), `details`, `callback_phone` | Writes the escalation row first, then Telegram and team email in parallel. Reason adjusted from server state (`auth_locked`, `not_found`). Callback target: the number given, else the account's, else a captured one, else caller ID; any number the caller gives is kept (North American, international with its country code, or noted as said; on a call from abroad one without a country code is never made `+1`), and one not North American is read back in full. A repeat with no number anywhere asks for one instead of promising a call | `rep_queued`, `rep_queued_no_number`, `callback_updated`, `rep_recorded`, `rep_already_queued`, `rep_unavailable` | "Of course, one moment." |
| `report_emergency` | `note` | Never refuses. Writes the emergency row, pages Telegram and emails the team; Telegram is paged even if the row fails | `emergency_logged` | Blocking: "If anyone is hurt or in immediate danger, please hang up and call 911 right now. If you're thinking about harming yourself, call or text 988." |
| `send_info_email` | `topic` (`document_checklist`, `claim_summary`, `how_to_start_claim`) | Verified caller: address on file only. Confirmed new caller: only `how_to_start_claim`. Ledger row before the send; "sent" only after Resend returns an id; one send per topic per call | `email_sent`, `email_already_sent`, `no_email_on_file`, `email_failed`, `not_verified` | "One moment." |
| `capture_contact` | `first_name`, `last_name`, `email`, `callback_phone` | Normalises a name, a spelled email and a callback number (never refused for its country or length; one that came out wrong, with no caller ID, is asked for once); stores them unconfirmed and reads them back | `contact_readback`, `contact_invalid_email`, `contact_needs_name`, `contact_needs_phone`, `email_on_file` | "Got it, one second." |
| `confirm_contact` | `correct` | Confirms or clears the captured details | `contact_saved_new`, `contact_saved_existing`, `contact_retry`, `not_pending` | "Okay." |
| `start_claim` | `claim_type` (`auto`, `home`, `property`), `loss_date` (as said), `description`, `summary` (at most eight words) | Claim gate from server state, server-side date parsing, one unconfirmed intake per call, read-back of the stored row | `claim_readback`, `claim_needs_lookup`, `claim_needs_contact`, `claim_needs_verification`, `claim_needs_phone`, `claim_locked`, `claim_needs_description`, `claim_bad_date`, `claim_date_help`, `claim_too_old`, `claim_already_filed` | "Alright, one moment." |
| `confirm_claim` | `correct` | Yes files under a row lock: a verified customer's intake becomes a `claims` row with a `CLM-` number, a new caller's a lead intake (only with a number to call: else it asks for one); then confirmation email and team notice | `claim_filed`, `claim_intake_saved`, `claim_needs_phone`, `claim_retry`, `claim_not_pending`, `claim_already_filed` | "Okay, one moment." |
| `endCall` | none (VAPI) | Hangs up | none | Blocking: "Thanks for calling Observe Insurance. Take care." |
| `faq_search` | The question (VAPI query tool) | Gemini 2.5 Flash over the knowledge-base file; the model answers in its own words | none | "Let me check that for you." |
| `handoff_to_knowledge`, `handoff_to_concierge` | none (VAPI handoff) | Silent move with the full conversation | none | none |
| `transferCall` | none (VAPI) | Blind transfer to `REP_PHONE_E164` with "Sure thing. Please hold while I connect you to a claims representative."; the webhook learns of it from `status-update: forwarding` | none | none |

Every server tool can also return `bad_args`, `system_error` or `unknown_tool`. The prompt calls
`confirm_contact` and `confirm_claim` with no words at all: the filler is the acknowledgement, so
the caller never hears two.

### 5.3 How a result is spoken

The webhook composes one sentence per result code and always puts it inside `result`. Delivery
depends on length:

- Up to 12 spoken words (`NATIVE_MAX_WORDS`; a number in figures counts one word per digit): also
  sent as a native `request-complete` message, which VAPI speaks exactly once. This is the fastest
  path.
- Longer, or over 1,000 characters: no native message and `spoken: false` in the result. Rule 2
  makes the model read it word for word.

The reason for the low threshold is barge-in. VAPI speaks a native tool message to the end, and in a
voice test a caller's "Sorry, wait" nine seconds into a native claims summary was not even
transcribed. The model's own speech stopped 1.26 s after the caller started. Ava must always stop
when the caller talks, so only short sentences stay native: `bad_args`, the plain `verified`,
`rep_recorded`, `emergency_logged`, `contact_needs_name`, `claim_bad_date`, `claim_retry` and a few
others. Read-backs, summaries, callbacks and the date-of-birth question (16 words) are model-read.

The cost is a second model turn, about 0.9 s of model time, and it starts only after the filler has
finished: VAPI releases a tool result when its filler stops playing, even with `blocking: false`.
That is why fillers are short ("One moment.", "Sure, one moment."). The persona battery marks its
mocked sentences the same way and fails any paraphrase or missed reading.
`NATIVE_TOOL_MESSAGES=false` switches every tool to the model-read path.

### 5.4 Sentences

`speak.ts` has a sentence for every one of the 56 result codes (a unit test asserts full coverage),
each within one 60-word spoken turn (75 for a read-back that spells an email). The wording is one
warm script: contractions, an opener now and then ("Got it.", "There you go,"), sorry once where it
matters, and no stock phrases.

Every sentence has a single phrasing (`PHRASINGS = 1`), so every call hears the same words. The
selection plumbing stays: `variantIndex` hashes the call key and the code (FNV-1a, no clock or
randomness), so a VAPI retry or a ledger replay always gets the same words, and phrasings added
later would keep that guarantee. Sentences keep the cue words the endpointing rules and transcript
masking depend on ("date of birth", "right number", "your email is", "the best number is").

Examples, using the fictional customer Tobias Halvorsen and a fictional new caller, Dana Whitfield:

| Code | Words | Sentence |
|---|---|---|
| `needs_dob` | 16 | "Thanks! And just to keep your account safe, what's the date of birth on the account?" |
| `not_found` | 21 | "I'm not finding an account under six zero two, five five five, zero one nine nine. Is that the right number?" |
| `not_found_final` | 32 | "I'm sorry, I still can't find an account for that number. If you're new with us, I'd be glad to help you get started. Could I get your first and last name?" |
| `verified` | 12 | "Thanks, Tobias. You're all verified. What can I help you with today?" |
| `verified` (intent `claim_status`) | 57 | "Thanks, Tobias. You're all verified. You have two claims. Your home claim ending in one nine eight needs documents from you by October twenty-fourth. Your auto claim ending in one one five was paid, four thousand eight hundred twenty dollars on October eighth. Would you like me to go over what's needed, or email you the list?" |
| `auth_failed` | 20 | "That doesn't quite match what we have on file. Could you give me your date of birth one more time?" |
| `locked` | 41 | "I'm sorry, but I'm not able to verify your identity on this call, so I can't share claim details. I can have a representative call you back, or you can call back with your policy number handy. Which would you prefer?" |
| `rep_queued` | 28 | "I've passed this to our claims team. Someone will call you back at the number on your account within one business day. Anything else I can help with?" |
| `rep_recorded` | 11 | "Okay, I've recorded your request. Anything else I can help with?" |
| `emergency_logged` | 9 | "I've told our team. Are you safe right now?" |
| `contact_readback` | 49 | "Thanks! Let me read that back. Dana Whitfield, your email is D, A, N, A, dot, W, H, I, T, F, I, E, L, D, at gmail dot com, and the best number is six zero two, five five five, zero one eight eight. Did I get that right?" |
| `claim_readback` | 22 | "Let me make sure I have this right. An auto claim, for a cracked windshield, from Saturday, October tenth. Is that correct?" |
| `claim_filed` | 38 | "You're all set. Your claim number ends in eight four nine, and I've emailed the details to the email on file. An adjuster will reach out within one business day. Is there anything else I can help with?" |
| `claim_retry` | 6 | "No problem. What should I change?" |
| `system_error` | 30 | "Sorry, I'm having trouble on our end right now. I can have a representative call you back, or you can try again in a few minutes. Which would you prefer?" |

Honest-result clauses are conditional: "passed" and a timeframe only when Telegram or email confirmed
delivery (otherwise `rep_recorded`), and "I've emailed the details" only when Resend returned an id.
`system_error` says "on our end" because rule 5 bans the word "system".

---

## 6. Squad handoffs

| From | To | When | How |
|---|---|---|---|
| Concierge | Knowledge | A general question the FAQ facts do not answer (appeals, file types, faxing, timelines, payments, adjusters, rental cars, holiday closures, language help, terms) | `handoff_to_knowledge` at once with no words; never for the caller's own claim, a new caller's details, a loss, a person or an emergency |
| Knowledge | Concierge | The caller turns to their own account or claim, wants to report a loss, wants to spell an email for their account, or has no account and wants help starting a claim | `handoff_to_concierge` at once with no words |
| Knowledge | stays | A request for a person, or an emergency | Knowledge calls `escalate` or `report_emergency` itself (floor tools) |

Both handoff tools have no messages, use `contextEngineeringPlan: {type: "all"}` so the whole
conversation moves, and override the destination's first message to empty in model-generated mode,
so the receiving assistant speaks only to answer. Handoffs target members by `assistantName`; a
conformance test asserts each target is a squad member. If a handoff does not fire, `solo-web` gives
the same knowledge answers with no handoff.

---

## 7. Configuration as code

The repo is the source of truth for the live VAPI org; nothing is edited in the VAPI dashboard.

1. Edit a partial, tool JSON, variant file or `data/faq.json`.
2. `deno task render` writes the prompts and the knowledge-base file. It reads only repo files, and
   a conformance test re-renders in CI and fails if a committed file is stale.
3. `deno task test` runs the 48 conformance tests over the rendered configuration, with the unit
   tests, on every push.
4. `deno task sync:apply` pushes, in dependency order: tools, the knowledge-base file, assistants,
   the squad, then the phone-number binding. Live ids go to `.sync-state.json` (gitignored).
5. `deno task sync:check` exits 1 on any drift.

Three VAPI behaviours shaped `sync:apply`:

- PATCH replaces nested objects whole, so every PATCH carries the full object. A top-level key
  omitted from a PATCH is kept, so a key removed from the repo is sent as `null` to clear it.
- GET can briefly return the previous version, so apply re-reads up to six times, with growing
  delays, until a full check agrees.
- Knowledge-base files are processed asynchronously. The file is uploaded as `text/plain` and
  polled until done (120 s limit); then the query tool is pointed at it and the old file deleted.

`sync:check` renders the desired state, reads every live object and reports value diffs, missing
keys, live-only keys at any depth, knowledge-base file mismatches, the phone binding and broken
invariants: every function tool's `server.url` is the webhook, no web assistant carries
`transferCall`, Knowledge carries no account tool, each prompt hash matches the one recorded at
apply time, and the squad has two members that share exactly the floor tools.

The conformance tests also assert that prompts name only attached tools, every spoken string passes
`assertSpeakable`, the claims assistants greet as Ava while Knowledge arrives silently, every prompt
carries the disclosure rule, the endpointing rules give the intended waits on realistic
transcripts, the barge-in settings are as above, and the analysis schema uses the `enums.ts` value
lists. Prompt behaviour is tested separately by the
persona battery: 45 personas on VAPI `/chat`, with mocked tools that answer with the real `speak.ts`
sentences ([reliability.md](reliability.md)).
