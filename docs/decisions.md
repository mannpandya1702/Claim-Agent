# Design decisions

Architecture decision records: context, decision, consequences and, where something was measured,
evidence. Shortcuts name the production upgrade they would need.

The voice records cite four test calls I made to the phone line on 2026-10-13 (VAPI call ids
`01a134e6`, `01a13604`, `01a13617`, `01a13635`, each on the configuration of its hour). The full
analysis is in [latency-investigation.md](latency-investigation.md). An effect marked *projected*
has not yet been measured on a live call.

Related: [architecture.md](architecture.md), [agent.md](agent.md),
[integrations.md](integrations.md), [reliability.md](reliability.md).

## Contents

1. [Principle](#1-principle)
2. [Platform](#2-platform)
3. [Identity and trust](#3-identity-and-trust)
4. [What the caller hears](#4-what-the-caller-hears)
5. [Turn-taking and latency](#5-turn-taking-and-latency)
6. [Contact capture and claims by voice](#6-contact-capture-and-claims-by-voice)
7. [After the call](#7-after-the-call)
8. [Dashboard and automation](#8-dashboard-and-automation)
9. [Not built yet / future work](#9-not-built-yet--future-work)

---

## 1. Principle

The model carries words; the server owns the truth. Identity state, attempt counts, what may be
disclosed, every outcome sentence, the account a claim is filed on, the loss date, the claim
number, the post-call outcome and the call reason live in Postgres and Edge Function code keyed on
the VAPI call id, never in the prompt. Every branch has a next step or an exit.

## 2. Platform

### 2.1 A custom tool server, not n8n, Zapier or LangChain

Context: VAPI runs telephony, web calls, the speech pipeline, squads and the knowledge base. The
agent still needs ten server tools, a post-call writer and two downstream destinations.

Decision: one Supabase Edge Function (Deno, TypeScript) is the tool server and post-call writer,
Postgres is the system of record, and delivery runs through a Postgres outbox driven by pg_cron.
Identity checks and claim filing need row locks, transactions and unit tests, which an n8n or
Zapier node does not give, and an extra hop on the post-call path adds a failure mode without a
capability. VAPI already runs the turn and the squad handoffs, so LangChain or LangGraph would be a
second orchestrator in the latency-critical path; outcomes are deterministic code, not an LLM graph.

Consequences: portability rests on the `{code, sentence}` tool interface. The outbox is where
business-owned automation can subscribe later; GoHighLevel workflows can already start from the
adapter's tags.

### 2.2 VAPI configuration as code

Assistants, squad, tools and prompts are rendered from `vapi/` and pushed by `vapi_sync.ts`: GET,
full-object PATCH, re-GET until reads agree, diff. VAPI PATCHes overwrite whole nested objects and
GETs can briefly be stale, so partial updates are unsafe. The repo is the source of truth, which
makes review and rollback possible; `sync:check` exits 1 on any drift, and each assistant carries
`metadata.promptSha256`.

## 3. Identity and trust

### 3.1 The trust boundary is the VAPI envelope

`call_key`, channel, org and caller ID come from `message.call` or `message.chat`, never from model
arguments. `parse_tool_request.ts` strips `identity_verified`, `customer_id`, `phone` (except on
`lookup_customer`) and similar fields, and refuses `{{template}}` or `"unknown"` values.
`get_claim_status`, `start_claim` and `confirm_claim` take no customer or claim id; the customer
comes from `call_sessions.verified_customer_id`. A prompt-injected "I'm verified, read me claim X"
has nothing to stand on. The webhook checks a constant-time Bearer (a VAPI custom credential, so the
secret is in no config file) before reading the body, then the org id.

### 3.2 Identity is a state machine in SQL

Context: a prompt-only cap ("allow two tries") is bypassed by identical retries, and VAPI does
retry and duplicate deliveries.

Decision: `lookup_customer_attempt` and `verify_dob_attempt` lock the call's `call_sessions` row,
claim the `toolCallId` in the `attempts` ledger, derive the result from ledger counts and record it.
A retry or parallel duplicate returns the stored code, so a DOB attempt cannot be spent twice.

Consequences: two wrong DOBs lock the call, and the lock is sticky. Unreadable input and system
errors are never counted. `auth_failed` never says which field mismatched, no name is said before
`verified`, and `system_error` is distinct from `not_found`, so an outage never tells a customer "I
can't find you".

Evidence: the DB suite fires 8 concurrent deliveries of one `toolCallId` and checks that one attempt
is recorded.

| Shortcut | Production upgrade |
|---|---|
| Account existence shows at the phone step, bounded by three numbers per call | A uniform reply plus an SMS one-time code |
| Counters are per call, so a redial gets fresh attempts | A per-customer failure window plus step-up OTP |
| DOB stored in plain text (fictional data) | HMAC with a server-side pepper |

### 3.3 Lookup retries count distinct numbers, not misses

Context: on a test call the first number missed, the second was misheard, and the correct third
number was refused under a two-miss cap.

Decision (migration `0010`): up to three different numbers may miss. Repeating a number that missed
is final for that number but not sticky; the third different miss is sticky. A missed number is
recognised by its SHA-256 in `lookup_numbers`, readable only by the service role and never on
Realtime, because a hash of a ten-digit number is reversible by brute force and `attempts` is
staff-readable.

Evidence: DB suite case "up to three different numbers"; smoke case `lookup-third-number`; battery
persona `f3-third-number`.

### 3.4 Intent first, verification only when needed

The greeting asks what the caller needs. General questions need no verification. `verify_identity`
takes an optional `intent` (`claim_status`, `file_claim`, `other`), so the verified turn goes
straight to the request; the chained status read is recorded as its own attempt
(`<toolCallId>:status`). The intent only picks the next sentence and never widens disclosure.

## 4. What the caller hears

### 4.1 Server-owned sentences

Every server tool returns `{code, sentence}`, with the sentence inside the JSON `result` so the
model's history matches what was said. Read-backs are built from the stored row, and the prompt
forbids the model to repeat or pre-announce them. The agent cannot announce a transfer, email or
claim that never happened.

- The 911 and 988 line is `report_emergency`'s blocking `request-start` message, spoken before the
  row is written. The model never has to "say X, then call Y".
- The goodbye is `endCall`'s blocking `request-start`, so a hang-up is never silent.
- Every claims answer fits one turn of at most 60 spoken words: a summary of at most four clauses,
  the rest counted, with documents or one claim's details on request. Reading every claim in full
  took 110 words for one customer's two claims.

### 4.2 The 12-word `spoken: false` threshold

Context: VAPI speaks a native tool message to the end. In voice test `01a13421` a caller's "Sorry,
wait" nine seconds into the claims summary was not even transcribed. In `01a13425` the model's own
speech stopped 1.26 s after the caller started. The threshold had been 20 words, then 28.

Decision: `NATIVE_MAX_WORDS = 12`, about four seconds of speech. A longer sentence goes with
`spoken: false` and the model reads it word for word (prompt rule 2). `NATIVE_TOOL_MESSAGES=false` turns
native messages off.

Consequences: only short codes stay native (the plain verified sentence, `rep_recorded`,
`emergency_logged`, `claim_retry` and a few more). The DOB question (16 words), summaries,
read-backs and callbacks can be interrupted. The cost is a second model turn after the filler.
Raising the threshold is the largest tool-turn saving left (about 0.9 s), pending a test showing
native speech can be interrupted.

Evidence: the battery checks model-read sentences word for word. On `01a13635` the post-filler gap
averaged 2.33 s: 0.42 s filler tail and stop detection, 0.91 s to first token, 0.05 s chunking,
0.87 s to first audio.

### 4.3 One warm phrasing per sentence

Context: each server sentence once had three phrasings, picked per call from a hash of the call key
and the code.

Decision: `PHRASINGS = 1`, the one warm phrasing I preferred for each sentence. The selection code
stays (`variantIndex`, FNV-1a, no clock or randomness).

Consequences: every call hears the same tested words, so battery patterns, conformance pins and the
cue words that endpointing and masking key on ("date of birth", "right number") check one script. A
repeat caller hears identical lines. `speak_test.ts` pins `PHRASINGS` to 1.

### 4.4 Persona: sounds human, never claims to be

Contractions, one question per turn, digits one by one with "zero", turns of 60 words or fewer.
Prompt rule 22: asked whether she is a person, Ava says "I'm Ava, an AI assistant for Observe
Insurance", never opening with yes or no, and she never claims to be human. The greeting says the
call may be recorded. Production upgrade: follow carrier and local disclosure rules, which may
require the disclosure in the greeting.

### 4.5 Live transfer is off

Context: a web call cannot be transferred to a phone, and there is no representative number.

Decision: web assistants have no `transferCall`, enforced by render, a conformance test and a
`sync:check` invariant. The phone number is bound to Observe Claims Web, so a representative
request becomes a callback (`escalate`, Telegram and email). The Observe Claims Phone variant (blind
transfer, a callback offer on failure, `forwarding` alerts) is built and tested, but `vapi_sync.ts`
skips it until `REP_PHONE_E164` is set, so a transfer to a placeholder is never callable.

Consequences: no live handoff; an unclaimed callback is re-paged after 30 minutes. Setting
`REP_PHONE_E164` and syncing binds the number to the phone variant.

## 5. Turn-taking and latency

The case study is `01a13635` (175 s, Multilingual v2 voice): I heard 2 to 3 s before each answer,
said "your voice was breaking", and hung up after Ava re-read a script. Each change followed a
turn-by-turn measurement from the stereo recording and VAPI's event log.

### 5.1 Longer waits only while an answer is unfinished

Context: a fixed 2 s wait after every number question made up most of an earlier 3.0 s turn
average, and still let Ava cut in after "Is that the right number?".

Decision: `waitSeconds` 0.4 plus six custom endpointing rules, checked in order:

| # | Ava's last turn | The caller's words so far | Wait |
|---|---|---|---|
| 1 | Asks to spell | Anything | 2.5 s |
| 2 | Asks for or about a phone number | A whole number with one "triple" or one "double" | 0.5 s |
| 3 | Asks for or about a phone number | 1 to 9 digits | 1.6 s |
| 4 | Asks for the date of birth | A partial date | 1.6 s |
| 5 | Asks what happened | Anything | 1.2 s |
| 6 | Anything | Ends in a hearing complaint | 0.5 s |

Any other turn is left to LiveKit smart endpointing (5.4).

Consequences: VAPI validates rule regexes with RE2 and refuses lookarounds with HTTP 400, so every
rule is RE2-only; a conformance test rejects lookarounds and backreferences before a sync.

### 5.2 Turbo v2.5 over Multilingual v2

Context: on Multilingual v2 a plain reply came 2.66 to 3.82 s after the caller stopped (median
2.90 s), and first audio took a median 836 ms of that.

Decision: `eleven_turbo_v2_5` with the same voice and delivery (speed 0.9, stability 0.75, style 0,
80-character sentence chunks), SSML off, `optimizeStreamingLatency` 3. I chose speed over the
multilingual model's quality. Flash v2.5 measured faster (231 ms) and was not kept. ElevenLabs auto
mode was rejected: on `01a13617` VAPI already sent 22 to 48 character fragments, and auto mode
synthesises fragments unbuffered, which risks choppy audio.

Consequences: about 0.5 s less on every reply, and tool content about 1.2 s after release instead of
1.75 to 2.0 s. The Turbo comparison call also used 15-character chunks; the live config keeps 80,
so those figures are *projected* for the current bundle.

Evidence: median first audio 836 ms and 690 ms on Multilingual v2, 302 ms on Turbo, 231 ms on Flash.
On the follow-up call `01a13691`, with Turbo and the shorter fillers live, VAPI's
`voiceLatencyAverage` was 329 ms against 579 ms on `01a13635`.

### 5.3 Shorter fillers

Context: VAPI released a tool's result only after its `request-start` filler finished, even with
`blocking: false`: `tool.completed` fired 1 to 2 ms after the filler stopped in 12 of 13 tool calls,
although the webhook had answered 212 to 1,784 ms earlier. Tool turns took 5.76 to 6.82 s from the
caller's last word to the answer.

Decision: `get_claim_status` "Alright, let me pull up your claims." became "Sure, one moment.";
`send_info_email` "One moment, let me check on that." became "One moment.". Native speech would
remove the hold but cannot be interrupted (4.2).

Consequences: when the webhook answers before the filler ends, results are released about 0.6 s
(claims) and 0.85 s (email) sooner (*projected*). A new filler is not yet in VAPI's voice cache
(1,129 and 1,174 ms to start uncached, 46 to 78 ms cached), so the runbook adds one warm call after
a voice or filler change.

### 5.4 A LiveKit wait curve capped at 2 s

Context: with no `waitFunction`, VAPI's live curve waited 2,860 ms at end-of-utterance probability
0, 685 ms at 0.507 and 382 ms at 0.992. All four calls hit the 2.86 s cap; the complaint "...I was
not able to hear" waited 2,875 ms.

Decision: `waitFunction: "200 + 300 * sqrt(x) + 1500 * x^3"`, where x is the probability the caller
is still speaking (1 minus the end-of-utterance probability, confirmed from 44 logged predictions).

Consequences: 200 ms when the caller is surely done, about 600 ms at x = 0.5, 2,000 ms at most;
computed against VAPI's curve, 227 vs 382 ms at probability 0.992 and 2,000 vs 2,860 ms at 0. Open
question: whether `waitSeconds` 0.4 acts as a floor. Confident turns near 230 ms mean no, near
400 ms mean yes.

Evidence: a maximum `endpointingLatency` of 2,866 to 2,882 ms on every call; a conformance test pins
200 ms at x = 0, 2,000 ms at x = 1 and under 700 ms at x = 0.5.

### 5.5 A hearing complaint is answered after 0.5 s

Context: my two complaints about hearing Ava waited 2,875 ms and 1,432 ms. Both sounded unfinished
to the end-of-turn model, so it waited longest when an answer was most needed.

Decision: the sixth rule waits 0.5 s while the transcript ends in a hearing complaint ("can't hear
you", "your voice was breaking", "you're cutting out", "are you there", "hello? hello?"). It is
`$`-anchored and comes last, so a pending number, DOB or spelling keeps its own wait.

Consequences: both waits become 0.5 s (*projected*). A single "hello?", "what?" or "the pipe keeps
breaking" does not match.

Evidence: conformance cases built from both transcripts; every rule regex checked with Go's RE2
(69 transcripts, 0 mismatches).

### 5.6 A whole number with "double" or "triple" is answered after 0.5 s

Context: Deepgram writes "triple 5" as one numeral, so "6 0 2 triple 5 0 1 0 1" has eight numerals.
The partial-number rule waited 1,605 ms, and that turn took 6.82 s.

Decision: a rule ahead of the digit count waits 0.5 s once the numerals reach ten digits with one
"triple" (eight numerals) or one "double" (nine). RE2 has no lookahead, so the pattern spells out
each position the word can take.

Consequences: 1.6 s becomes 0.5 s. A number in progress keeps 1.6 s, and so does a whole number
with two doubles: slower, never early. Conformance cases and the RE2 check guard the long regex.

### 5.7 Barge-in on voice activity

Context: on `01a134e6` speech-to-text took up to 7.7 s on some turns, and with `numWords: 1` VAPI
waits for that transcript before stopping Ava. An earlier call (`01a13449`) had about four seconds
of silence after an interruption, 1 s of it the backoff.

Decision: `numWords: 0`, `voiceSeconds: 0.4`, `backoffSeconds` 0.5 (from 1). Any of 26 interruption
phrases stops her at once; 22 acknowledgements ("okay", "mm-hmm") never do.

Consequences: 0.4 s of voice ignores clicks but catches "wait". On all four calls, though, VAPI
stopped Ava only when a partial transcript arrived (0.66 to 1.23 s after the caller began on
`01a13635`), and the logs do not record the live value. Whether VAPI honours the setting on the phone
path is open. A conformance test pins the whole `stopSpeakingPlan`.

### 5.8 Rules 25 and 26: a bad line is handled in the prompt

Context: rule 23 covered Ava not catching the caller; nothing covered the caller not hearing Ava.
On `01a13635` Ava re-listed the services after "I am not able to listen. What?", sent an email with
no word about the line, re-read a 24-word list from memory and closed with "Does that make sense?".
Seven hearing complaints across the four calls got no line check, and no VAPI hook reacts to the
caller's words or to audio quality.

Decision:

- Rule 25, CAN'T HEAR YOU: one turn, no tool. A short sorry, a line check that keeps "hear me", "I
  was saying" with only the missed part, then the pending question. A same-breath request gets
  "Should I still ...?". Still bad on the next turn: one callback offer.
- Rule 26, SAYING IT AGAIN: only the missed part, about 20 words, every fact copied from the tool
  result, because the model's history holds VAPI's transcription of Ava's audio ("October 20
  fourth"). No second tool call. A read-back to confirm is read again in full.

Consequences: a complaint gets one short turn about 2.6 to 2.9 s after the caller stops, instead of
5.7 s to a filler (*projected*). The `solo-core` prompt grew from 37,934 to 43,261 bytes. Masking
now carries across a line check (`REASK_RE`, the latest 6 assistant lines on the live path). The
breaking audio itself came from stalls inside VAPI's media path, which no setting removes.

Evidence: nine line-trouble battery personas. A live battery on 14 personas passed 13; `garbled` failed
on wording only, and its widened pattern passes on the saved transcripts.

### 5.9 The low-confidence re-ask hook is gone

Context: a hook on low-confidence transcripts said "Sorry, could you repeat that?". On `01a13604` it
fired on a noisy fragment while the model answered: "Sorry. Could you repeat I can look into that."

Decision: remove it. Rule 23 asks the caller to repeat, in the model's words. `confidenceThreshold`
stays 0.3, so quiet speech still reaches the model.

Consequences: one voice per turn. Rule 23 forbids guessing or calling a tool on garbled words. The
three silence hooks (10, 20 and 40 s) stay. In no live run of the `garbled` persona did the model
call a tool, escalate or promise anything on a garbled turn.

## 6. Contact capture and claims by voice

### 6.1 Email addresses only spelled, read back and confirmed

Speech recognition cannot be trusted with an address. `capture_contact` joins spelled letters and
"at", "dot", "underscore" on the server, stores the details unconfirmed and reads the address back
letter by letter; `confirm_contact` records the yes. A verified customer can spell an email only
when none is on file, for staff to add; it is never sent to. A changed callback number needs a new
yes (`0009`). Production upgrade: a verification link, since a read-back proves the address was
heard right, not that the caller owns it.

### 6.2 Claims: the server gates, reads back and files

`start_claim` is gated on server state only: locked gives `claim_locked`, an unverified phone match
gives `claim_needs_verification`, and a caller with no account needs a confirmed contact first. It
stores one unconfirmed intake per call and reads back the stored row; only `confirm_claim` with a
yes files it. `file_claim_intake_once` (`0009`) takes the row lock and returns `filed_now`, so only
the filing delivery sends the confirmation; the DB suite runs 8 concurrent filings and checks that
one claim is filed.

| Shortcut | Production upgrade |
|---|---|
| The yes is the model's reading of the answer | A confirmation message with a correction link; read-back kept for audit |
| One intake per call | Several intakes per call |

### 6.3 Loss dates are parsed by the server

A model is unreliable at date arithmetic, so `loss_date` is passed as said ("last Tuesday",
"October tenth") and `parseLossDate` reads it against today in New York. "Last week" is unreadable,
never guessed; future dates are refused, and dates over 365 days old go to a specialist. The
read-back speaks the weekday and date, which is where a misheard date is caught. Production
upgrade: the caller's own time zone ("yesterday" after 9 pm Pacific lands a day late).

### 6.4 Claim numbers, and leads for new callers

A verified filing inserts a `claims` row in the same transaction: `CLM-` plus six random digits
(up to 20 draws on collision), status `received`, and `reported_call_key`, so resets remove
phone-filed claims and keep the seed data. A new caller has no policy, so their intake is a
`lead_intake`: no `claims` row, a team alert, and a specialist call within one business day, which
requires a dialable number first. Production upgrade: the claims system issues the number behind
the same `Store` interface.

## 7. After the call

### 7.1 The record comes from the end-of-call report

A hang-up tool never runs after silence or a dropped call; the report always arrives. The row is
upserted on the call id with a per-column merge and a forward-only guard. The outcome comes from
server facts first (emergency, escalation, filed intake, locked, not found, status read); the
model's structured output fills only sentiment and an unverified caller's name. Sentiment is never
invented: a backfill fetches the call after 5, 15 and 45 s waits, then marks the row
`analysis_status = 'missing'`.

### 7.2 Call reasons: server facts outrank the model

One reason per call, with its source: server facts, then the structured output, then a reason
derived from the tools used. A stored reason is replaced only by one of equal or higher rank
(server 3, structured output 2, derived 1). The structured output outranks the derived reason
because a caller who rang about documents may also hear their status.

### 7.3 The honest-result rule

A sentence claims a side effect only after the server saw it: "I've passed this to our claims
team" only when Telegram or email delivered, otherwise "Okay, I've recorded your request."; "emailed"
only when Resend returned an id; "filed" only from `confirm_claim`. The escalation row is written
before either channel is tried, each with 2.5 s inside the 5 s tool budget. Post-call flags catch
the model saying it anyway (`email_promised_without_send`, `claim_promised_without_filing`,
`promised_callback_without_escalation`). Telegram cards carry only ids and enums.

Production upgrade: a verified sending domain (the Resend sandbox delivers only to its own account)
and bounce webhooks, since a Resend id means accepted, not delivered.

### 7.4 PII minimisation is a mechanism

Transcripts, summaries and descriptions are redacted before storage; the answer to a DOB or phone
question is stored as `[answer withheld]`. Logs carry the last four digits at most. Airtable gets
the last four digits and no transcript; the GoHighLevel note never carries a transcript, DOB or full
number. Production upgrade: recordings carry spoken PII, so private storage plus audio redaction.

### 7.5 One outbox, isolated destinations

Context: two destinations with different failure modes must never block each other or the record.

Decision: the record is written to Supabase first; Airtable and GoHighLevel receive it through
`outbox_events`, one row per event and destination. Each attempt is counted before the request is
sent (at most 5), a 30 s lease keeps two runners off one row, and the payload is read fresh at
delivery. Each destination has its own loop and retry clock (`0008`) inside the every-minute job's
8 s.

Consequences: an Airtable outage never blocks GoHighLevel, or the reverse, and a refused token
pauses only its own destination. Airtable is an upsert on the call id. GoHighLevel notes and tasks
are not idempotent, so delivery runs in steps (contact, tags, note, tasks) saved to `progress`, and a
retry redoes only what is missing. A GHL 429 waits the `x-ratelimit-interval-milliseconds` window
(10 s default); other transient failures back off 60 to 480 s.

Production upgrade: one cron run a minute caps throughput; a queue per destination with concurrent
workers and a dead-letter view.

### 7.6 GoHighLevel: trusted identifiers, additive writes

The GHL row waits 90 s so the backfilled analysis lands first. A contact is matched only on a
number the server trusts: the verified customer's number, a new caller's confirmed number, or a
phone call's caller ID. A number the caller only stated may create a contact, but a hit on it is
skipped (`lead_number_not_caller_id`). The one PUT fills only empty fields, tags go through the
additive endpoint, and notes carry no `userId`, so a human's edit always wins. Do-not-contact holds
back `oi-lead-new`, the one tag a workflow could start outreach from.

| Shortcut | Production upgrade |
|---|---|
| A 90 s timer; a delivered call is not posted again | Deliver when the record is final; swap tags on change |
| The phone number is the only key | Our customer id in a GHL custom field |
| Task due dates skip weekends only | A holiday calendar |

## 8. Dashboard and automation

The dashboard is a least-privilege client: sign-ups off, a `staff` allowlist, default grants
revoked, one staff-only select policy per granted table. Browser writes are one column grant
(`staff_notes`) and two security-definer escalation functions; the security advisor's warning on
those two (`get_advisors` WARN 0029) is accepted, since both check staff membership. Recordings come through a staff-only
function that returns a short-lived presigned link.

Automation sits with whoever changes it: identity, sentences and delivery guarantees in tested
code; the SLA re-alert, digest, reaper and outbox in pg_cron with idempotent `(job, period_key)` run
keys; CRM follow-up workflows in GoHighLevel, started from the adapter's tags.

## 9. Not built yet / future work

- Quality and operations: an LLM-judge call score bounded by server facts, automated config
  rollback, a delivery canary, a customer 360 page.
- Security: HMAC-signed claim links in alerts, an emailed one-time code after a lockout.
- Channels: SMS of document links, voicemail and after-hours flows.
- Claims: a real claims-system adapter, several claims per call, a lead-to-policy lookup, loss time
  and place, other languages and date orders.
- GoHighLevel: custom fields, opportunities, SMS, inbound webhooks, more than one location.
- Call reasons: several per call, and a review of the model's labels.

Voice and latency options considered and not taken:

| Option | Why not |
|---|---|
| Native speech for long tool sentences | Saves about 0.9 s per tool turn, but cannot be interrupted |
| A faster model tier | Unmeasured; `serviceTier` "fast" is not valid on `gpt-5.4` |
| Pinning `reasoningEffort` "none" | VAPI already sends it on the OpenAI path |
| A prompt cache key | No latency evidence: the first, uncached request of a call was no slower |
| `MAX_TURN_WORDS` 40 | Would rewrite the tested script |
| Partial-number wait at 1.2 s, Deepgram endpointing at 150 ms | Current values are deliberate and tested |
| A VAPI hook for line trouble | No such event exists |
| An imported Twilio or Telnyx number | An open question for VAPI support, given the media-path stalls |
