# Changelog

Build history, newest first. Times are UTC. Test counts are `deno task test` at that commit;
"battery" is the persona battery over VAPI's chat API, "smoke" the live tool checks.

## 2026-10-14

### Callbacks: who to ask for
An unverified caller's callback request reached the team, and the call record, as "Unknown caller".
After the request is logged and the team alerted (unchanged), a caller with no verified account, no
confirmed details and no name on the request is asked once, in place of the sentence's closing
question: "Who should they ask for?" (`rep_queued` at any target, or `callback_updated`). `escalate`
takes the answer as `caller_name`, cleaned on the server (letters, spaces, apostrophes, hyphens and full
stops, 1 to 80 characters; "unknown", "no", numbers and addresses refused), stores it on the escalation
row and answers `callback_name_saved` ("Thanks, Priya. I've added your name to the request. Anything else
I can help with?"); a name volunteered with the first request is stored and nothing is asked. A repeat
never pages again, a replay keeps its words, and a decline is never asked again. The post-call
`caller_name` takes the name after a verified or confirmed one and before the analysis' guess, never next
to an account the caller did not verify; the callback email, the SLA re-alert email and the dashboard
card show "Ask for" (never the Telegram card). `0012_callback_caller_name.sql` adds
`escalations.caller_name` and `p_caller_name` on `upsert_escalation`. Battery personas `callback-name` and
`callback-name-declined`: 8 personas live, 6 of 8 on the first run; the decline ended the call without
the "anything else" check the name question had displaced, so the rule now says to check once, and `f4`
failed on the known filler read; both passed on rerun. 925 tests.

### Callbacks: live battery
Battery over the callback and escalation personas, one run each: 11 of 14 passed on the first run. Asked
"I'm calling from Australia ... call me back on this number", the model passed `+61` as the callback
number. The server drops a bare country code and still used the caller ID, but `escalate` and
`capture_contact` now say never to pass a country code on its own or one worked out from a country the
caller mentions, and `escalate` leaves the number out for "the number I'm calling from"; the persona then
passed. `f4` and `f2` failed on a tool sentence read with words of the model's own (known flakes, nothing
to do with callbacks) and passed on rerun. 898 tests.

### Callbacks: review fixes
On a call from abroad, a number given without a country code is read against the caller ID: the
caller's own number in its national form is the caller ID, read back with "plus" and the country code,
and any other is noted as said instead of being made `+1`; a stored number is never read again. A new
caller's intake is filed only with a number to call (`confirm_claim` asks too), and a number that came
out wrong is asked for once rather than dropped. A first callback request reads a number from abroad, or
one noted as said, in full. Redaction takes 11 to 15 digits read back in groups whole and never joins
numbers across a sentence end or a list of amounts or years. GoHighLevel keys a lead whose number was
noted as said on the call's caller ID; the call page links only numbers with a country code. 898 tests.

### Callbacks: any number the caller gives
A live call from abroad asked for a callback "on this number": the caller ID (outside North America)
was dropped, the number then said was refused, and the repeat promised a callback with no number on
record. A callback number is now noted as given: North American as before, international with its
country code as E.164, anything else of 7 to 15 digits as said (`0011_intl_callbacks.sql`). A repeat
with no number anywhere asks for one. Read-backs say "plus" and the country code; redaction covers
numbers from abroad; GoHighLevel gets E.164 only. Rule 3 counts "double five" as two digits.

## 2026-10-13

### Whole numbers said with "double" or "triple" answered in 0.5 s
`65d72e0` (19:20). Deepgram writes "triple 5" as one numeral, so a complete number counted 8 digits,
matched the partial-number rule and waited 1.6 s. A new rule ahead of it answers in 0.5 s once a
whole number is said with one "triple" or one "double". RE2 has no lookahead, so the pattern spells
out each position. Six custom rules now, first match wins. 863 tests.

### Line trouble: rules 25 and 26, faster endpointing, masking carry
`f24d5eb`, `a894a81`, `d3b4bbc` (19:19). Fixes from the
[call 01a13635 investigation](latency-investigation.md). Rule 25 answers "I can't hear you" with a
line check and only the missed part, with no tool call; rule 26 keeps a repeat to about 20 words
copied from the tool's result and reads a pending read-back again in full. A LiveKit `waitFunction`
caps the smart-endpointing wait at 2.0 s (VAPI's curve reached 2.86 s), and a hearing complaint
waits 0.5 s. `REASK_RE` keeps transcript masking on through a line check. Live battery on 14
personas: 13 of 14. 863 tests.

### Turbo v2.5 voice and shorter fillers
`ead992f` (18:39). Multilingual v2 took a median 836 ms to first audio against 302 ms on Turbo v2.5,
and VAPI releases a tool result only after its filler finishes playing. Voice back to
`eleven_turbo_v2_5` with the same delivery, SSML off, `optimizeStreamingLatency` 3. Claims filler
"Sure, one moment.", email filler "One moment.". The next phone call averaged 2.66 s per turn
against 3.30 s (VAPI's `turnLatencyAverage`).

### One warm phrasing per sentence
`e84f66d` (16:56). `PHRASINGS` 3 to 1: I preferred the single warm wording of each server sentence
to rotating variants. The selection plumbing stays (a hash of the call key and the code, no clock or
randomness), so variants added later rotate with the same replay guarantee. 855 tests.

### Low-confidence re-ask hook removed
`afab621` (16:29). On a 16:06 phone call the hook fired on a noisy fragment while the model answered
the real sentence, and the two collided: "Sorry. Could you repeat I can look into that." Rule 23
already re-asks in the model's own turn. The three idle hooks (10, 20 and 40 s) stay.

### Quality-first voice settings
`860b501` (16:25). ElevenLabs `eleven_multilingual_v2` at speed 0.9, stability 0.75, style 0, SSML
on, `optimizeStreamingLatency` 0, and sentence chunks of at least 80 characters so intonation runs
across a sentence. Measured later at about 0.84 s to first audio per reply; the delivery settings
stayed when Turbo v2.5 came back.

### Ava speaks like a person on the phone
`3e0bf4d`, `bc98021` (13:51). Style rules (no acknowledgement on every turn,
the caller's own words, the first name sparingly), rule 16 sizing sympathy to what happened, an
UPSET CALLER section, rule 22 for "are you a person?" ("I'm Ava, an AI assistant for Observe
Insurance."), phone read-backs in three comma groups, up to three phrasings per frequent sentence,
softer idle lines and the Flash v2.5 voice. Battery 31 of 33; both failures fixed in `bc98021`.
857 tests.

### Barge-in on voice activity
`da0d9b5` (11:39). On a 10:54 phone call speech-to-text took up to 7.7 s
on some turns, and a one-word barge-in waits for that transcript. `numWords` 1 to 0 and
`voiceSeconds` 0.2 to 0.4, so 0.4 s of voice should stop Ava; the
[latency investigation](latency-investigation.md#what-config-cannot-fix) later found VAPI still
waits for a partial transcript. VAPI cannot interrupt a native tool message, so `NATIVE_MAX_WORDS`
went from 28 to 12 (about four seconds). 842 tests.

### Warmer, faster Ava
`021ee05` (09:11). On an 08:02 phone call a garbled barge-in ("Red desk, the
home team") triggered `escalate`, and a follow-up question left about 4 s of silence. Voice speed
1.0, stability 0.45, 15-character chunks; `backoffSeconds` 1 to 0.5; `NATIVE_MAX_WORDS` 20 to 28.
Rule 23 re-asks garbled speech and never calls a tool on it; rule 24 answers what an interrupting
caller said; "the second one" maps to the summary just read. A warmth pass over every sentence.
842 tests.

### Long tool sentences read by the model
`7e00656` (07:32). VAPI plays a native tool message to the end: in a barge-in test call, "Sorry,
wait" 9.2 s into a claims summary was not even transcribed. In a control call the model's own
speech stopped 1.26 s after the caller started. Sentences over 20 spoken words now go out `spoken: false` and the
model reads them word for word; the battery fails any paraphrase. 834 tests.

### RE2-compatible endpointing rules
`8a2d17a` (07:17). VAPI validates endpointing regexes with RE2 and refused the lookaheads (400
"invalid perl operator"). The rules now count digits only, every pattern was compiled with Go's RE2,
and a conformance test rejects lookarounds and backreferences. 831 tests.

### Turn-taking, interruptions, three lookups, "Hey" greeting
`4642bc7` (07:08), then `8580712` (07:12). Two phone tests averaged 2.83 and
3.26 s per turn, with a flat 2.0 s wait after every number or date question. `waitSeconds` 0.6 to
0.4, and custom rules wait only while an answer is unfinished (spelling 2.5 s, partial number 1.6 s, date without a
year 1.6 s, "what happened" 1.2 s). Migration 0010 allows three different numbers per call; a
missed number's hash sits in the service-role-only `lookup_numbers` table, since ten digits can be
brute-forced. Barge-in on one word. 830 tests.

### Short claim-status summary, details on request
`d8378a8` (06:45). The status sentence for two claims ran to 110 words.
`get_claim_status` takes `detail` (`summary`, `documents`, `claim`) and `claim_ending`; the summary
gives one clause per claim (at most four), most urgent first. Every server sentence fits 60 spoken
words (75 for a spelled email read-back), checked by a test with worst-case data. 800 tests.

### Voice claim intake, call reasons, GoHighLevel
`a69efda` (04:48), then `cacde5e`, `9427430`, `5f71ca5`. `start_claim` and `confirm_claim` file a
first notice of loss, gated on server state, with the loss date parsed server-side; a verified
caller gets a `CLM-` claim, a new caller's intake goes to the claims team. Every call gets a reason
(server facts beat structured output beat derived facts). GoHighLevel is a third outbox destination
with per-step progress, its own retry clock, and contacts keyed only on trusted numbers. Migrations
0007 to 0009. 779 tests, smoke 23/23, battery 26/28, four synthetic voice calls.

### Ava: persona, intent-first greeting, contact capture
`ea36428`, `9e582de`, `51f378e` (01:02). The assistant became Ava, on Turbo v2.5 at speed 0.8. The
greeting asks what the caller needs before any number, and general questions need no verification.
`capture_contact` stores a name, spelled email and callback number unconfirmed and reads them back;
`confirm_contact` records the caller's yes or no. Migration 0006 adds `caller_contacts` and
`caller_type`. The battery records words after a tool's spoken sentence as a chat-only
continuation. 618 tests, smoke 19/19.

## 2026-10-12

### Any ten digits can be looked up
`8ad6bda` (22:49). A ten-digit number whose exchange starts with 1 was rejected as `invalid_phone`
by the numbering-plan rule. The lookup key now accepts any ten digits (or eleven with a leading 1);
the NANP rule applies only to callback numbers, which must be dialable. 524 tests.

### Dashboard on GitHub Pages
The `dashboard.yml` workflow published the build to https://mannpandya1702.github.io/Claim-Agent/
(22:44).

### Voice harness and whole-turn flags
`2cdedeb`, `864be81` (22:06). `deno task voice` places real VAPI calls over WebSocket with a
synthesized caller and records both sides. Five scenarios passed (happy path, auth failure, not
found, escalation, emergency) and confirmed one assistant turn per tool result on voice. VAPI splits
one sentence into several messages around tool calls, so flags now judge whole assistant turns.

### Prompt fixes from the persona battery
`b699db6`, `3a6e0fb` (21:19). 17 personas: 13 of 17, then 15 of 17 after rule 2 (a spoken tool
sentence ends the turn) and a callback offer for third parties. The live DB suite was renamed out of
the `*_test.ts` pattern, because its early exit without credentials stopped the CI test runner.

### Scheduled jobs and outbox delivery
`677b03a` (21:09). `/jobs/{sla,digest,reaper,outbox}`, run by pg_cron through pg_net: outbox every
minute, sla every 10 minutes, reaper hourly, digest daily.
Overlapping runners could re-claim one outbox row and spend all five attempts in a second; a
30-second lease (compare-and-set on `attempts` and `updated_at`) prevents it. Verified live: the
escalation row first, then Telegram and Resend; the Airtable record within about 5 s. 521 tests.

### First deploy
`3582b61` (19:46). Supabase's remote bundler cannot read the lockfile v5 written by Deno 2.9 (an
opaque 500 on deploy), so each function has its own `deno.json` with `lock: false`. Smoke 16/16.
Live chat tests send a `sessionId`, because chaining with `previousChatId` gives every turn a new
chat id. +1 520 521 0277 answers with the web assistant.

### Ops dashboard and public call page
`c170b6d` (19:13). React 18, Vite, Tailwind and shadcn/ui, plus the staff-only `recording-url`
function. List responses never carry a full phone number (masked generated columns in
`0003_dashboard.sql`); the recording link checks visibility with the caller's JWT before presigning.
287 vitest tests; Playwright smoke with axe in light and dark.

### Airtable call-log mirror
`6dae54b` (18:33). One redacted record per call, upserted on Call ID through `outbox_events`
(`0005_outbox.sql`): tried once off the request path, retried every minute, at most 5 attempts.

### Webhook modules, VAPI config as code, CI
`2c7186e` (16:56) to `e27d264` (19:38). `vapi-webhook` is small modules that take all I/O through a
`Deps` object (store, fetch, env, clock, waitUntil, logger), so unit tests run against fakes.
Prompts render from partials; `vapi_sync` checks and applies assistants and tools; CI runs check,
lint and test. 440 tests, including 13 live DB cases.

### Schema, identity state machine, VAPI probes
`e7f5335` (15:34), `bdef91b`. Every table in `0001_init.sql`, RLS on with no policies, `anon` and
`authenticated` revoked (the project granted them everything by default). Lookup and DOB checks are
SQL functions keyed on `(call_key, tool_call_id)`, so a retried delivery gets the same answer and
never burns a second attempt. Probe P1 showed VAPI keeps the full assistant block unchanged.

### Scaffold
`b8a4197` (15:24). Deno tasks, Supabase config, and a migration runner over the Management API's
HTTPS SQL endpoint, because Postgres TCP was blocked from the development container. A pre-push
guard fails when any repo file contains a string from a local, gitignored list.
