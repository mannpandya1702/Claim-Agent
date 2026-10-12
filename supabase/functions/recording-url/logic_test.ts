import { assertEquals, assertStrictEquals } from "@std/assert";
import {
  corsHeaders,
  createHandler,
  parseAllowedOrigins,
  RECORDING_GONE,
  type RecordingDeps,
  resolveRecording,
  validCallId,
} from "./logic.ts";

const CALL_ID = "5f1c2a9e-1b2c-4d3e-8f90-a1b2c3d4e5f6";
const PAGES = "https://mannpandya1702.github.io";

function fakeFetch(respond: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    return Promise.resolve(respond(url, init));
  }) as typeof fetch;
  return { fn, calls };
}

function deps(overrides: Partial<RecordingDeps> = {}): RecordingDeps {
  return {
    vapiPrivateKey: "vapi-private",
    isStaff: () => Promise.resolve(true),
    callVisible: () => Promise.resolve(true),
    fetch:
      fakeFetch(() =>
        new Response(null, { status: 302, headers: { location: "https://storage.example/rec.wav?sig=1" } })
      ).fn,
    ...overrides,
  };
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://fn.example/recording-url", {
    method: "POST",
    headers: { authorization: "Bearer staff-jwt", origin: PAGES, "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

Deno.test("resolveRecording returns the 302 Location without following it", async () => {
  const f = fakeFetch(() =>
    new Response(null, { status: 302, headers: { location: "https://storage.example/a.wav" } })
  );
  const r = await resolveRecording(CALL_ID, "k", f.fn);
  assertEquals(r, { status: 200, body: { url: "https://storage.example/a.wav" } });
  assertEquals(f.calls[0].url, `https://api.vapi.ai/call/${CALL_ID}/mono-recording`);
  assertStrictEquals(f.calls[0].init?.redirect, "manual");
  assertEquals((f.calls[0].init?.headers as Record<string, string>).Authorization, "Bearer k");
});

Deno.test("resolveRecording maps 404 to the retention message", async () => {
  const r = await resolveRecording(CALL_ID, "k", fakeFetch(() => new Response("gone", { status: 404 })).fn);
  assertEquals(r, { status: 404, body: { error: RECORDING_GONE } });
});

Deno.test("resolveRecording reports a rejected key and other upstream failures as 502", async () => {
  const denied = await resolveRecording(CALL_ID, "k", fakeFetch(() => new Response("no", { status: 401 })).fn);
  assertEquals(denied.status, 502);
  const broken = await resolveRecording(CALL_ID, "k", fakeFetch(() => new Response("err", { status: 500 })).fn);
  assertEquals(broken, { status: 502, body: { error: "Recording service returned 500" } });
  const offline = await resolveRecording(CALL_ID, "k", (() => Promise.reject(new TypeError("dns"))) as typeof fetch);
  assertEquals(offline, { status: 502, body: { error: "Recording service unreachable" } });
});

Deno.test("resolveRecording accepts a JSON link on 200", async () => {
  const f = fakeFetch(() => Response.json({ url: "https://storage.example/b.wav" }));
  assertEquals(await resolveRecording(CALL_ID, "k", f.fn), {
    status: 200,
    body: { url: "https://storage.example/b.wav" },
  });
});

Deno.test("handler: OPTIONS preflight echoes only allowed origins", async () => {
  const handler = createHandler(deps());
  const ok = await handler(new Request("https://fn.example", { method: "OPTIONS", headers: { origin: PAGES } }));
  assertEquals(ok.status, 204);
  assertEquals(ok.headers.get("access-control-allow-origin"), PAGES);
  const evil = await handler(
    new Request("https://fn.example", { method: "OPTIONS", headers: { origin: "https://example.com" } }),
  );
  assertEquals(evil.headers.get("access-control-allow-origin"), null);
});

Deno.test("handler: staff caller gets the short-lived link, uncached", async () => {
  const res = await createHandler(deps())(post({ call_id: CALL_ID }));
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { url: "https://storage.example/rec.wav?sig=1" });
  assertEquals(res.headers.get("cache-control"), "no-store");
  assertEquals(res.headers.get("access-control-allow-origin"), PAGES);
});

Deno.test("handler: refuses without a bearer, for non-staff, and when the check fails", async () => {
  const f = fakeFetch(() => new Response(null, { status: 302, headers: { location: "https://x" } }));
  const noAuth = await createHandler(deps({ fetch: f.fn }))(post({ call_id: CALL_ID }, { authorization: "" }));
  assertEquals(noAuth.status, 401);
  await noAuth.body?.cancel();

  const notStaff = await createHandler(deps({ fetch: f.fn, isStaff: () => Promise.resolve(false) }))(
    post({ call_id: CALL_ID }),
  );
  assertEquals(notStaff.status, 403);
  await notStaff.body?.cancel();

  const failing = await createHandler(deps({ fetch: f.fn, isStaff: () => Promise.reject(new Error("db down")) }))(
    post({ call_id: CALL_ID }),
  );
  assertEquals(failing.status, 502);
  await failing.body?.cancel();

  // VAPI is never asked on behalf of a refused caller
  assertEquals(f.calls.length, 0);
});

Deno.test("handler: a call the caller cannot read gets 404 and VAPI is never asked", async () => {
  const f = fakeFetch(() => new Response(null, { status: 302, headers: { location: "https://x" } }));
  const seen: { authorization: string; callId: string }[] = [];
  const res = await createHandler(deps({
    fetch: f.fn,
    callVisible: (authorization, callId) => {
      seen.push({ authorization, callId });
      return Promise.resolve(false);
    },
  }))(post({ call_id: CALL_ID }));
  assertEquals(res.status, 404);
  assertEquals(await res.json(), { error: RECORDING_GONE });
  // checked as the caller, with the caller's own token
  assertEquals(seen, [{ authorization: "Bearer staff-jwt", callId: CALL_ID }]);
  assertEquals(f.calls.length, 0);
});

Deno.test("handler: a failing call check is a 502, not a recording", async () => {
  const f = fakeFetch(() => new Response(null, { status: 302, headers: { location: "https://x" } }));
  const res = await createHandler(deps({ fetch: f.fn, callVisible: () => Promise.reject(new Error("db down")) }))(
    post({ call_id: CALL_ID }),
  );
  assertEquals(res.status, 502);
  assertEquals(await res.json(), { error: "Could not check the call" });
  assertEquals(f.calls.length, 0);
});

Deno.test("handler: validates the body and the method", async () => {
  const handler = createHandler(deps());
  const bad = await handler(post({ call_id: "../../account" }));
  assertEquals(bad.status, 400);
  await bad.body?.cancel();
  const notJson = await handler(post("not json"));
  assertEquals(notJson.status, 400);
  await notJson.body?.cancel();
  const get = await handler(
    new Request("https://fn.example", { method: "GET", headers: { authorization: "Bearer x" } }),
  );
  assertEquals(get.status, 405);
  await get.body?.cancel();
});

Deno.test("handler: 404 from VAPI reaches the player as 'Recording no longer available'", async () => {
  const res = await createHandler(deps({ fetch: fakeFetch(() => new Response(null, { status: 404 })).fn }))(
    post({ call_id: CALL_ID }),
  );
  assertEquals(res.status, 404);
  assertEquals(await res.json(), { error: RECORDING_GONE });
});

Deno.test("handler: missing server key is a configuration error", async () => {
  const res = await createHandler(deps({ vapiPrivateKey: null }))(post({ call_id: CALL_ID }));
  assertEquals(res.status, 500);
  await res.body?.cancel();
});

Deno.test("helpers: call id shape, origin list parsing, CORS defaults", () => {
  assertEquals(validCallId(CALL_ID), true);
  assertEquals(validCallId("short"), false);
  assertEquals(validCallId("a/b/c/d/e/f/g"), false);
  assertEquals(validCallId(42), false);
  assertEquals(parseAllowedOrigins(" https://a.example , https://b.example "), [
    "https://a.example",
    "https://b.example",
  ]);
  assertEquals(parseAllowedOrigins(""), [
    "https://mannpandya1702.github.io",
    "http://localhost:5173",
    "http://localhost:4173",
  ]);
  assertEquals(corsHeaders("http://localhost:5173").get("access-control-allow-origin"), "http://localhost:5173");
  assertEquals(corsHeaders(null).get("access-control-allow-origin"), null);
});
