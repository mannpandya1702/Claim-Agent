# Runbook

How to set up, deploy, reset and debug the system. Call walkthroughs are in
[scenarios.md](scenarios.md); the latency analysis behind section 6.2 is in
[latency-investigation.md](latency-investigation.md).

All commands run from the repo root with Deno on the PATH (`export PATH="$HOME/.deno/bin:$PATH"`).
The scripts read `.env` through `scripts/lib/env.ts` and fail naming any missing key. The Supabase
CLI does not, so export the file first when a step uses it: `set -a; . ./.env; set +a`.

## Contents

1. [Live system](#1-live-system)
2. [Setup](#2-setup)
3. [Deploying changes](#3-deploying-changes)
4. [Demo data](#4-demo-data)
5. [Health checks](#5-health-checks)
6. [Reading the logs](#6-reading-the-logs)
7. [Troubleshooting](#7-troubleshooting)

---

## 1. Live system

| What | Where |
|---|---|
| Phone | +1 520 521 0277, answered by Observe Claims Web (no transfer target, so a representative request is a callback) |
| Web call, no sign-in | https://mannpandya1702.github.io/Claim-Agent/#/call (`?mode=solo`, `core` or `squad`) |
| Ops dashboard, staff sign-in | https://mannpandya1702.github.io/Claim-Agent/ |
| Webhook | `$SUPABASE_URL/functions/v1/vapi-webhook`; `GET .../health` is public |
| VAPI | Observe Claims Web (primary), Observe Claims Core (fallback without the knowledge base), squad `observe-claims-web` (Concierge and Knowledge) |
| Call log | Airtable table "Call Log" |
| CRM | GoHighLevel; agent-created contacts have the source "Observe voice agent", and every tag starts with `oi-` |
| Alerts | Telegram bot chat; Resend from its sandbox sender, which delivers only to the Resend account's own address |
| Inboxes | Team alerts to `CLAIMS_TEAM_EMAIL`; customer emails to `OWNER_EMAIL`, which the reset sets on the seeded customers |

Configuration names are in `.env.example` and in
[architecture.md](architecture.md#11-deployment-and-configuration). No values belong in any
document.

## 2. Setup

Prerequisites: Deno 2.x, the Supabase CLI, Node 22 for the dashboard, and Python 3 with gTTS and
ffmpeg for the voice harness only. Copy `.env.example` to `.env` and fill it in.

Bring-up from an empty Supabase project and VAPI org, in order:

1. Point the function URL in `invoke_job` (`0004_automation.sql`) at the new project, then
   `deno task db push` to apply `supabase/migrations/*.sql`. This registers the cron jobs, which
   fail every run until step 5 is done.
2. `deno task probe credential` creates the VAPI Bearer credential for the webhook.
3. `supabase secrets set NAME=<value> --project-ref $SUPABASE_PROJECT_REF` for the function's
   secrets (GoHighLevel stays off without `GHL_TOKEN` and `GHL_LOCATION_ID`).
4. `supabase link --project-ref $SUPABASE_PROJECT_REF` once, then `deno task deploy`: it deploys
   `vapi-webhook` (JWT verification off, Bearer checked in code) and `recording-url` (staff JWT).
5. Create the Vault secret `jobs_bearer` with the same value as `JOBS_BEARER`.
6. `deno task airtable:setup` creates or completes the "Call Log" table.
7. `deno task render`, then `deno task sync:apply`.
8. Disable Auth sign-ups in Supabase, then `deno task staff` for the dashboard user.
9. `deno task reset -- --yes`, `deno task smoke`, `deno task sync:check`.

## 3. Deploying changes

A release that touches several layers goes in this order, each step after the previous one passes:

| # | Command | Why here |
|---|---|---|
| 1 | `deno task db push` | The new function calls SQL only the migrations create. Migrations are additive, so the running function keeps working |
| 2 | `deno task airtable:setup` | A field the table lacks returns 422 `UNKNOWN_FIELD_NAME` and pauses the call log. The script only adds fields |
| 3 | `set -a; . ./.env; set +a; deno task deploy` | The server must know a tool before any assistant calls it |
| 4 | `deno task sync:apply` | On the old function, new tools would answer `unknown_tool` and the caller would hear the trouble line |
| 5 | `deno task smoke` | Proves sentences, auth and the identity ladder against the live function |

| What changed | Commands | Verify |
|---|---|---|
| Edge Function code | `deno task test`, then `deno task deploy` | `curl` the health route, `deno task smoke` |
| Prompts, tools, assistants, squad, FAQ (`vapi/`, `data/faq.json`) | `deno task render`, `deno task test` (conformance), `deno task sync:apply` | `deno task sync:check`; `deno task battery -- --n 1` if behaviour changed |
| Voice settings or a tool filler | As above, then one warm call (section 4.3) | The first use of a new filler is not cached and starts late |
| Schema | Add `supabase/migrations/NNNN_*.sql`, then `deno task db push` (one transaction per file). Never edit an applied file | `deno task db status`, `deno task db:test` |
| A function secret | `supabase secrets set ...`, then `deno task deploy`: an isolate reads its environment once at boot | `deno task smoke`; `deno task ghl:check --call <id>` for GoHighLevel |
| Dashboard | Push to `main`; on a push that touches `dashboard/`, `.github/workflows/dashboard.yml` tests, builds and publishes to Pages (or `gh workflow run dashboard.yml --ref main`) | The footer shows the new commit |

Rollback is a redeploy of an earlier commit, VAPI config first, then the functions:
`git checkout <good sha> -- vapi data/faq.json && deno task render && deno task sync:apply`, then
`git checkout <good sha> -- supabase/functions && deno task deploy`. Migrations are not rolled back;
being additive, an older function works against the newer schema. `sync:check` shows which rendered
prompt is live through each assistant's `metadata.promptSha256`.

Two deploy traps:

- The Supabase remote bundler cannot read the Deno 2.9 lockfile (v5) and fails with an opaque
  `500 internal error`. Each function has its own `deno.json` with `"lock": false`; keep them.
- VAPI validates endpointing regexes with RE2 and refuses lookarounds with HTTP 400 (`invalid perl
  operator: (?!`). Spell the cases out instead; the conformance tests reject lookarounds first.

## 4. Demo data

### 4.1 Reset the database

`deno task reset` prints what it would delete and exits 1. `deno task reset -- --yes` empties the
ten per-call tables (`attempts`, `lookup_numbers`, `call_sessions`, `escalations`, `emails`,
`caller_contacts`, `claim_intakes`, `transcript_lines`, `call_interactions`, `outbox_events`) and
the claims filed by phone (`reported_call_key` set). It then sets `OWNER_EMAIL` on four seeded
customers; Teague Ashdown keeps none, for the no-email branch. Customers and the seeded claims are
never deleted. If it reports `rows written during the reset`, a call landed mid-reset: run it again.

Identity counters are per call, so the lockout and the happy path can run back to back on the same
number. After a reset no call is on file, so a verified caller hears no "Welcome back.". Webhook
captures stay until the reaper prunes them after 7 days.

### 4.2 Clean Airtable and GoHighLevel

The reset touches neither.

- Airtable: a view sorted by Started At, newest first, makes test rows easy to find and delete,
  including `smoke-` records.
- GoHighLevel: delete contacts with the source "Observe voice agent" that tests created, such as
  "Tobias Halvorsen", "Sloane Marchetti" and "Smoke Tester". While "Smoke Tester" exists, a web new
  caller who gives 602 555 0177 is skipped (`lead_number_not_caller_id`).
- `deno task smoke` deletes its call rows but leaves the outbox rows its end-of-call report queued:
  a call-log row (often a `smoke-` Airtable record) and a GoHighLevel row that goes dead as "record
  missing" after 90 s. The next reset clears both.
- After a test from a real phone: reset, then delete GoHighLevel contacts keyed on that number and
  team emails that quote it.

### 4.3 Before a live demo

| Step | Command or action | Expected |
|---|---|---|
| Config and wallet | `deno task sync:check`, `deno task probe p3` | `no drift: the live org matches the repo`; `p3 chat ok` (a `402` means top up the VAPI wallet) |
| Tool path | `deno task smoke` | `N/N cases passed` |
| Clean data | `deno task reset -- --yes`, then section 4.2 | Open test escalations would otherwise be re-paged by the `sla` job after 30 minutes |
| Warm voice cache | One web call that hears the lookup, verify, claims and email fillers and the goodbye | Fillers start at once: uncached 0.3 to 1.2 s, cached 46 to 78 ms |
| Phone | Call +1 520 521 0277 and hear the greeting | Greeting heard |
| Audio | Wired headset for web calls | Speaker echo would trigger barge-in on 0.4 s of voice |
| Order | Run the happy path before the returning-caller scenario | The welcome-back clause needs `PRIOR_CONTACTS_ENABLED=true` and a verified call with a summary on file |

The warm-up calls create rows and possibly a GoHighLevel contact (90 s to about 3 minutes later);
delete them as in 4.2 afterwards.

## 5. Health checks

| Check | Command | Expected |
|---|---|---|
| Types and lint | `deno task check && deno task lint` | Clean |
| Unit and conformance | `deno task test` | `0 failed` |
| Sensitive strings | `deno task clean-room` | `clean-room: N files clean` |
| Dashboard | `cd dashboard && npm ci && npm run typecheck && npm test && npm run build && npm run smoke` | Tests pass; Playwright smoke with axe passes |
| Webhook alive | `curl -sS "$SUPABASE_URL/functions/v1/vapi-webhook/health"` | `{"ok":true}` |
| Schema | `deno task db status` | Every migration `applied`, no `PENDING` |
| Database | `deno task db:test` | One `PASS` per case, then `all cases passed`; everything rolled back or cleaned up |
| Live tool path | `deno task smoke` | `N/N cases passed`; never pages anyone; up to three emails reach `OWNER_EMAIL` |
| Scheduled jobs | `deno task jobs outbox`, `sla`, `reaper` (`digest` sends the one digest of the day) | `HTTP 200` and JSON counts; `"skipped": true` for a job already run in its period |
| Alerts end to end | `deno task voice escalation` (one real call with a synthetic caller) | `native-message check: PASS`; a Telegram card, a team email, an Airtable record within a minute, a GoHighLevel contact with a callback task 90 s to 3 minutes later |
| Claim filing end to end | `deno task voice fnol-verified` | A claim number read back, a confirmation email, "Claim reported" on the call detail, an `oi-claim-filed` tag |
| Prompt regression | `deno task battery -- --n 1`; a subset with `--persona 'cant-hear*,f1'` (quote the `*`) | Spends VAPI credit; checks a 402 first. Words after a tool's sentence are recorded as `continuation`, not failures |

## 6. Reading the logs

### 6.1 Edge Function logs

Supabase dashboard, Edge Functions, `vapi-webhook`, Logs: one JSON line per request.

| Field | Meaning |
|---|---|
| `call_key` | The VAPI call id (`chat.sessionId` for `/chat`); filter on it to follow one call |
| `type` | `tool-calls`, `status-update`, `transcript`, `end-of-call-report`, `job`, `health` |
| `status` | HTTP status; every tool outcome is 200 with a sentence, only auth and parse rejections are 4xx |
| `tool`, `code` | Tool names and result codes |
| `ms` | Time to answer |

Named events include `tool_timeout`, `tool_error`, `alert_failed`, `backfill`, `outbox_failed`,
`outbox_paused`, `ghl_skipped` (with `reason`), `ghl_contact`, `job_finished` and `config_missing`.
The logger drops keys named `phone`, `dob`, `date_of_birth`, `email`, `args` and `arguments` at any
depth and redacts every string, so a line carries at most the last four digits of a number.

### 6.2 A call's latency in the VAPI log

The call object holds VAPI's per-turn numbers; the event log has a timestamp for every pipeline
step. Both include the caller's words, so keep them local and quote only ids, event names and
timings.

```bash
set -a; . ./.env; set +a
curl -sS -H "Authorization: Bearer $VAPI_PRIVATE_KEY" "https://api.vapi.ai/call/<call id>" > call.json
# per turn, in ms: transcriber, endpointing, model, voice, whole turn
jq -c '.artifact.performanceMetrics | {turnLatencyAverage, endpointingLatencyAverage,
  turns: [.turnLatencies[] | [.transcriberLatency, .endpointingLatency, .modelLatency, .voiceLatency, .turnLatency]]}' call.json
```

The event log is gzipped JSON lines at `artifact.logUrl`. Each line has `time` (epoch ms),
`attributes.event` and `attributes.turnId`.

```bash
gunzip -c <downloaded log>.jsonl.gz > call.log.jsonl
# each turn's steps
jq -r 'select(.attributes.event | IN("assistant.transcriber.finalTranscript", "pipeline.endpointingTriggered",
    "assistant.model.firstTokenReceived", "assistant.voice.firstAudioReceived", "assistant.tool.completed",
    "pipeline.botSpeechStarted", "pipeline.botSpeechStopped"))
  | select(.attributes.channel != "assistant")
  | [.time, .attributes.event, (.attributes.latency // "")] | @tsv' call.log.jsonl
# audio stalls inside VAPI, by leg
jq -sc '[.[] | select(.attributes.event == "call.driftDetected")] | {events: length,
  by_leg: (group_by(.attributes.identifier) | map({(.[0].attributes.identifier): length}) | add)}' call.log.jsonl
```

What to read, with the values measured on `01a13635` before tuning and what the current config
should give (projected until measured):

| Signal | Before | Expect now |
|---|---|---|
| `turnLatencies[].endpointingLatency` | Up to 2,874 ms; VAPI's curve capped near 2.87 s | At most about 2,000 ms. Confident turns near 230 ms mean `waitSeconds` 0.4 is not a floor; near 400 ms mean it is |
| The caller's `finalTranscript` to `pipeline.endpointingTriggered` | 2,875 ms on a hearing complaint; 1,605 ms on a number said with "triple" | About 500 ms on both |
| `assistant.voice.firstAudioReceived` latency | Median 836 ms (Multilingual v2) | About 300 ms (Turbo v2.5) |
| `assistant.model.firstTokenReceived` latency | About 0.89 s median | Unchanged |
| `assistant.tool.completed` vs the filler's `pipeline.botSpeechStopped` | 1 to 2 ms apart: VAPI holds the result until the filler ends | Unchanged (platform behaviour) |
| `assistant.tool.completed` to the next `pipeline.botSpeechStarted` | 1,749 to 2,003 ms | About 1.2 s |
| `turnLatencyAverage` (also the dashboard's "Avg turn latency") | 3,299 ms | Lower (2,656 ms on `01a13691`, before the endpointing changes); compare phone calls with similar tool turns |
| `call.driftDetected` | 68 events in 10 clusters, 7 while Ava spoke | Any cluster while Ava speaks is an audible hole |
| `pipeline.userSpeechStarted` while Ava speaks | Never fired; interruptions landed on a partial transcript 0.66 to 1.23 s in | Shows whether the 0.4 s voice setting now stops her sooner |

The "LiveKit prediction ... Awaiting for" lines are missing from some logs; do not rely on them.

### 6.3 The database

`deno task db query "<sql>"` prints rows as JSON.

```bash
# last calls: outcome, reason, analysis
deno task db query "select vapi_call_id, outcome, call_reason, call_reason_source, claim_number,
  caller_type, analysis_status, started_at from call_interactions order by started_at desc nulls last limit 10"
# one call's tool timeline (a status read chained onto verification ends in :status)
deno task db query "select created_at, tool_call_id, tool_name, kind, code from attempts
  where call_key = '<call id>' order by created_at"
# a loss reported on a call, and whether it was filed
deno task db query "select kind, claim_type, loss_date, claim_number, confirmed from claim_intakes
  where call_key = '<call id>'"
# escalations and emails
deno task db query "select kind, alert_status, delivery_error, status from escalations order by created_at desc limit 5"
deno task db query "select kind, status, error from emails order by created_at desc limit 5"
# outbox, both destinations (GoHighLevel's progress holds steps done or a skip reason)
deno task db query "select destination, ref_id, attempts, next_attempt_at, delivered_at, last_error, progress
  from outbox_events order by created_at desc limit 10"
# jobs and the Ops page summary
deno task db query "select job, period_key, finished_at, result from job_runs order by started_at desc limit 10"
deno task db query "select * from ops_health"
```

### 6.4 Capture and replay

With `CAPTURE_WEBHOOKS=true` (set on the deployed function), webhook bodies land in
`webhook_captures` with tool arguments stripped.

```bash
deno task db query "select id, message_type, call_key, received_at from webhook_captures order by id desc limit 10"
deno task replay --capture <id> --new-id --dry-run   # show what would be sent
deno task replay --capture <id> --new-id             # re-send under a fresh call id
deno task replay fixtures/eocr/full.json --new-id    # a fixture end-of-call report
```

`replay` refuses bodies that act when replayed (tool calls, a `forwarding` status update) unless
`--allow-side-effects` is passed. The debugging loop: find the call on the dashboard, read its tool
timeline and flags, follow its `call_key` through the function logs, compare with the VAPI call log,
replay the captured body, fix, and turn the artifact into a unit test.

### 6.5 One call's GoHighLevel delivery

```bash
deno task ghl:check --call <call id>             # print the row; deliver it now if due
deno task ghl:check --call <call id> --wait      # wait up to 150 s for the 90 s delay or a lease
deno task ghl:check --call <call id> --enqueue   # queue a missing row, or re-arm one (progress kept)
```

It runs the outbox job's path and prints the row before and after. Exit 0 when delivered, 1 when
not, 3 when not yet claimable without `--wait`.

## 7. Troubleshooting

| Symptom | Action | Why |
|---|---|---|
| Call page shows a microphone error | Allow the microphone and reload; otherwise use the phone | The page checks the mic before starting a call |
| "Voice account out of credit", the battery halts on 402, or `probe p3` prints `402` | Top up the VAPI wallet, then `deno task probe p3` until `p3 chat ok` | VAPI answers 402 while the wallet is empty or frozen |
| Pages returns 404 | `cd dashboard && npm run dev`, open `http://localhost:5173/#/call`, or use the phone | The dashboard is a static client over Supabase and RLS |
| Every tool answers "Sorry, I'm having trouble on our end right now..." | `curl` the health route, read the function logs, `deno task smoke`; redeploy if a deploy broke it | The designed failure line: a system problem is never "I can't find you" |
| The function logs `unknown_tool` | `deno task deploy`, then `deno task smoke` | Assistants were synced ahead of the function |
| Knowledge-base answers slow or wrong | Switch the call page to Core | Core has the FAQ in the prompt and no knowledge base |
| No Telegram card after an escalation | Call detail: `alert_status`, `delivery_error`; Ops "Delivery by channel" | If both channels failed, Ava said "Okay, I've recorded your request." instead of "I've passed this to our claims team..." |
| No email | Spam folder; call detail "Emails sent" shows status and the Resend id | The Resend sandbox delivers only to its own account's address, so a confirmation to any other address fails and Ava does not say it was sent |
| A claim was not filed | Call detail "Claim reported" card; the `claim_intakes` query in 6.3 | Nothing is filed without a yes to the read-back |
| No Airtable record | Ops page; `deno task jobs outbox`; the outbox query in 6.3 | At-least-once, up to 5 attempts, upserted on Call ID. A 422 `UNKNOWN_FIELD_NAME` pauses the run: `deno task airtable:setup` |
| No GoHighLevel contact | Wait 90 s plus a job tick, then `deno task ghl:check --call <id> --wait`; read the skip reason below | Only numbers the server trusts find or create a contact; a skip is a decision, not a failure |
| `deno task jobs outbox` reports `ghl_config_error` | Fix the token, `supabase secrets set GHL_TOKEN=<value> --project-ref $SUPABASE_PROJECT_REF`, `deno task deploy` | A refused token pauses only GoHighLevel; the call log keeps delivering |
| GoHighLevel row dead | `deno task ghl:check --call <id> --enqueue` | Re-arms with progress kept, so it never writes a second note |
| Summary or sentiment empty | Wait about 65 s; call detail shows `analysis_status` | The backfill retries after 5, 15 and 45 s; then `missing`, never invented |
| A spoken line differs from the expected server sentence | Check the call page mode, then `deno task sync:check` and `deno task smoke` | A stale deploy, the wrong assistant, or the model misreading a sentence over 12 words |
| A pause of 1 to 2 s after each filler | Expected | VAPI releases a tool's result only after its filler finishes |
| Ava waits about 1.6 s after a number or date of birth | Say it whole, in one go | A partial number or date waits 1.6 s on purpose. A whole one gets the normal end-of-turn wait; a whole number with one "double" or "triple" waits 0.5 s, with two it still waits 1.6 s |
| Ava's voice breaks up on the phone | Say "Sorry, your voice is breaking" (rule 25); move to the web call if it persists; count `call.driftDetected` afterwards | Stalls inside VAPI's media path, seen with three voice models; the carrier leg lost 1 packet of 8,508 on the measured call |
| After "I can't hear you" Ava re-reads a whole answer or calls a tool | Note the call id; read that turn's model request in the VAPI log; add the case to the battery | Rule 25 should give one turn with a line check and only the missed part |
| VAPI outage | `deno task smoke`; `deno task replay fixtures/eocr/full.json --new-id` | The backend is independent of the voice layer |

GoHighLevel skip reasons, in the row's `progress.skipped` and the `ghl_skipped` log line:

| Reason | Meaning |
|---|---|
| `web_unverified` | A web call with no verified customer and no confirmed new-caller details |
| `no_caller_id` | A phone call with no usable caller ID (withheld, not E.164, or one of our own numbers) |
| `no_matching_contact` | A caller-ID search found nothing; that path never creates a contact |
| `locked_candidate_number` | A locked caller on the account's own number; that account is never touched |
| `lead_number_not_caller_id` | A new caller's stated number already belongs to a contact, who may be a stranger |
| `new_caller_without_number` | A confirmed new caller with no callback number |
| `new_caller_number_without_country_code` | A confirmed new caller whose number was noted as said, without a country code, on a call with no caller ID to key on (a web call): GHL takes E.164 only, so the lead stays on the dashboard and in the team email |
| `verified_customer_missing`, `verified_without_phone` | The verified customer's row is unreadable or has no number: a data problem |
