import { assert, assertEquals, assertFalse, assertInstanceOf, assertStringIncludes } from "@std/assert";
import { alertSinks, type EscalationAlert, renderAlert, sendAlert } from "./alert.ts";
import { sendTelegram } from "./telegram.ts";
import type { Deps, Env, Store } from "./types.ts";

const TOKEN = "123456:TEST-token_value";
const CHAT = "-1001234567890";
const CONFIGURED: Partial<Env> = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: CHAT };

interface Recorded {
  url: string;
  init: RequestInit;
}

function recordingFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Recorded[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, init: init ?? {} });
    return await respond(url, init ?? {});
  }) as typeof fetch;
  return { fetchFn, calls };
}

// Never resolves on its own; rejects with the signal's reason, like a real fetch does on abort.
const hangingFetch =
  ((_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      if (signal.aborted) reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    })) as typeof fetch;

function makeDeps(env: Partial<Env>, fetchFn: typeof fetch) {
  const logs: Record<string, unknown>[] = [];
  const deps: Deps = {
    store: {} as Store,
    fetch: fetchFn,
    env: { VAPI_ORG_ID: "org", VAPI_WEBHOOK_SECRET: "secret", ...env },
    now: () => new Date("2026-10-12T15:00:00Z"),
    waitUntil: () => {},
    log: (e) => logs.push(e),
  };
  return { deps, logs };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const ALERT: EscalationAlert = {
  kind: "representative",
  reason: "representative_requested",
  callKey: "1a2b3c4d-0000-4000-8000-000000000001",
  channel: "webCall",
  verified: true,
};

Deno.test("sendTelegram: missing configuration never fetches", async () => {
  for (
    const env of [{}, { TELEGRAM_BOT_TOKEN: TOKEN }, { TELEGRAM_CHAT_ID: CHAT }, {
      TELEGRAM_BOT_TOKEN: " ",
      TELEGRAM_CHAT_ID: CHAT,
    }]
  ) {
    const { fetchFn, calls } = recordingFetch(() => json({ ok: true }));
    const { deps } = makeDeps(env, fetchFn);
    assertEquals(await sendTelegram(deps, "hello"), { ok: false, error: "telegram not configured" });
    assertEquals(calls.length, 0, JSON.stringify(env));
  }
});

Deno.test("sendTelegram: request shape", async () => {
  const { fetchFn, calls } = recordingFetch(() => json({ ok: true, result: { message_id: 7 } }));
  const { deps } = makeDeps(CONFIGURED, fetchFn);
  assertEquals(await sendTelegram(deps, "line one\nline two"), { ok: true });
  assertEquals(calls.length, 1);
  const { url, init } = calls[0];
  assertEquals(url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
  assertEquals(init.method, "POST");
  assertEquals(new Headers(init.headers).get("content-type"), "application/json");
  assertEquals(JSON.parse(String(init.body)), {
    chat_id: CHAT,
    text: "line one\nline two",
    disable_web_page_preview: true,
  });
  assertInstanceOf(init.signal, AbortSignal);
});

Deno.test("sendTelegram: trims configuration and caps the text at Telegram's limit", async () => {
  const { fetchFn, calls } = recordingFetch(() => json({ ok: true }));
  const { deps } = makeDeps({ TELEGRAM_BOT_TOKEN: ` ${TOKEN} `, TELEGRAM_CHAT_ID: ` ${CHAT}\n` }, fetchFn);
  assertEquals(await sendTelegram(deps, "x".repeat(5000)), { ok: true });
  assertEquals(calls[0].url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
  const body = JSON.parse(String(calls[0].init.body));
  assertEquals(body.chat_id, CHAT);
  assertEquals(body.text.length, 4096);
});

Deno.test("sendTelegram: ok only on HTTP 200 with body.ok true", async () => {
  const cases: [Response, boolean, string | undefined][] = [
    [json({ ok: true }), true, undefined],
    [
      json({ ok: false, description: "Bad Request: message text is empty" }),
      false,
      "telegram 200: Bad Request: message text is empty",
    ],
    [json({ ok: "true" }), false, "telegram 200: response not ok"],
    [new Response("not json", { status: 200 }), false, "telegram 200: response not ok"],
    [json({ ok: false, error_code: 401, description: "Unauthorized" }, 401), false, "telegram 401: Unauthorized"],
    [
      json({ ok: false, error_code: 400, description: "Bad Request: chat not found" }, 400),
      false,
      "telegram 400: Bad Request: chat not found",
    ],
    [json({ ok: true }, 201), false, "telegram 201: response not ok"],
    [new Response("<html>oops</html>", { status: 502, statusText: "Bad Gateway" }), false, "telegram 502: Bad Gateway"],
    [
      json({ ok: false, error_code: 429, description: "Too Many Requests: retry after 3" }, 429),
      false,
      "telegram 429: Too Many Requests: retry after 3",
    ],
  ];
  for (const [response, ok, error] of cases) {
    const { fetchFn } = recordingFetch(() => response);
    const { deps } = makeDeps(CONFIGURED, fetchFn);
    const got = await sendTelegram(deps, "hi");
    assertEquals(got.ok, ok, error);
    assertEquals(got.error, error);
  }
});

Deno.test("sendTelegram: a network error never throws and never leaks the token", async () => {
  const fetchFn = (() => {
    throw new TypeError(`error sending request for url (https://api.telegram.org/bot${TOKEN}/sendMessage): dns error`);
  }) as typeof fetch;
  const { deps } = makeDeps(CONFIGURED, fetchFn);
  const got = await sendTelegram(deps, "hi");
  assertFalse(got.ok);
  assert(got.error?.startsWith("telegram request failed: TypeError"), got.error);
  assertFalse(got.error!.includes(TOKEN));
  assertFalse(got.error!.includes("TEST-token"));
  assertStringIncludes(got.error!, "dns error");
});

Deno.test("sendTelegram: a description echoing the token is scrubbed", async () => {
  const { fetchFn } = recordingFetch(() => json({ ok: false, description: `Not Found: bot${TOKEN}` }, 404));
  const { deps } = makeDeps(CONFIGURED, fetchFn);
  const got = await sendTelegram(deps, "hi");
  assertFalse(got.error!.includes(TOKEN));
  assertEquals(got.error, "telegram 404: Not Found: bot<token>");
});

Deno.test("sendTelegram: timeout -> ok false, error 'timeout'", async () => {
  const { deps } = makeDeps(CONFIGURED, hangingFetch);
  const started = Date.now();
  assertEquals(await sendTelegram(deps, "hi", 20), { ok: false, error: "timeout" });
  assert(Date.now() - started < 2000);
});

Deno.test("sendTelegram: a body that stalls past the budget is a timeout", async () => {
  const fetchFn = ((_input: string | URL | Request, init?: RequestInit) => {
    const signal = init!.signal!;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
      },
    });
    return Promise.resolve(new Response(body, { status: 200 }));
  }) as typeof fetch;
  const { deps } = makeDeps(CONFIGURED, fetchFn);
  assertEquals(await sendTelegram(deps, "hi", 20), { ok: false, error: "timeout" });
});

Deno.test("alertSinks: default, case, spacing and unknown names", () => {
  assertEquals(alertSinks({}), ["telegram", "email"]);
  assertEquals(alertSinks({ ALERT_SINKS: "telegram,email" }), ["telegram", "email"]);
  assertEquals(alertSinks({ ALERT_SINKS: " Telegram , EMAIL " }), ["telegram", "email"]);
  assertEquals(alertSinks({ ALERT_SINKS: "email" }), ["email"]);
  assertEquals(alertSinks({ ALERT_SINKS: "slack,telegram" }), ["telegram"]);
  assertEquals(alertSinks({ ALERT_SINKS: "" }), []);
});

Deno.test("sendAlert: default sinks post the rendered card to Telegram", async () => {
  const { fetchFn, calls } = recordingFetch(() => json({ ok: true }));
  const { deps, logs } = makeDeps({ ...CONFIGURED, DASHBOARD_URL: "https://ops.example.com/claims/" }, fetchFn);
  assertEquals(await sendAlert(deps, ALERT), { ok: true });
  assertEquals(calls.length, 1);
  const text = JSON.parse(String(calls[0].init.body)).text;
  assertEquals(text, renderAlert(ALERT, "https://ops.example.com/claims/"));
  assertEquals(
    text,
    "[Observe Claims] representative | representative_requested | normal | call 1a2b3c4d | webCall | " +
      "https://ops.example.com/claims/#/calls/1a2b3c4d-0000-4000-8000-000000000001",
  );
  assertEquals(logs.length, 0);
});

Deno.test("sendAlert: telegram switched off by ALERT_SINKS sends nothing and reports not delivered", async () => {
  for (const sinks of ["email", "", "slack"]) {
    const { fetchFn, calls } = recordingFetch(() => json({ ok: true }));
    const { deps } = makeDeps({ ...CONFIGURED, ALERT_SINKS: sinks }, fetchFn);
    const got = await sendAlert(deps, ALERT);
    assertFalse(got.ok);
    assertStringIncludes(got.error!, "ALERT_SINKS");
    assertEquals(calls.length, 0, sinks);
  }
  const { fetchFn, calls } = recordingFetch(() => json({ ok: true }));
  const { deps } = makeDeps({ ...CONFIGURED, ALERT_SINKS: " TELEGRAM " }, fetchFn);
  assertEquals(await sendAlert(deps, ALERT), { ok: true });
  assertEquals(calls.length, 1);
});

Deno.test("sendAlert: never throws; a failure is logged with the call key and no message text", async () => {
  const fetchFn = (() => Promise.reject(new Error("connection reset"))) as typeof fetch;
  const { deps, logs } = makeDeps(CONFIGURED, fetchFn);
  const got = await sendAlert(deps, { ...ALERT, kind: "emergency", reason: "emergency" });
  assertFalse(got.ok);
  assertStringIncludes(got.error!, "connection reset");
  assertEquals(logs.length, 1);
  assertEquals(logs[0].call_key, ALERT.callKey);
  assertEquals(logs[0].sink, "telegram");
  assertFalse(JSON.stringify(logs[0]).includes("Observe Claims"));
});

Deno.test("sendAlert: unconfigured Telegram is a failed delivery, not an exception", async () => {
  const { fetchFn, calls } = recordingFetch(() => json({ ok: true }));
  const throwingLog = () => {
    throw new Error("log sink down");
  };
  const { deps } = makeDeps({}, fetchFn);
  deps.log = throwingLog;
  assertEquals(await sendAlert(deps, ALERT), { ok: false, error: "telegram not configured" });
  assertEquals(calls.length, 0);
});

Deno.test("sendAlert: a malformed alert still resolves", async () => {
  const { fetchFn, calls } = recordingFetch(() => json({ ok: true }));
  const { deps } = makeDeps(CONFIGURED, fetchFn);
  const got = await sendAlert(deps, null as unknown as EscalationAlert);
  assertEquals(got, { ok: true });
  assertEquals(
    JSON.parse(String(calls[0].init.body)).text,
    "UNVERIFIED: do not disclose claim details\n[Observe Claims] unknown | unknown | normal | call unknown | unknown",
  );
});

Deno.test("sendTelegram and sendAlert: broken deps resolve instead of throwing", async () => {
  const { fetchFn, calls } = recordingFetch(() => json({ ok: true }));
  const { deps } = makeDeps(CONFIGURED, fetchFn);
  const broken = { ...deps, env: undefined as unknown as Env };
  assertFalse((await sendTelegram(broken, "hi")).ok);
  assertFalse((await sendAlert(broken, ALERT)).ok);
  assertEquals(calls.length, 0);
});
