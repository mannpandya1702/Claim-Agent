// In-memory GoHighLevel for the unit tests: a fetch that answers the endpoints ghl.ts uses the way
// the live sandbox answered them when it was probed (2026-10-12): the status codes, the response
// envelopes ({contacts,total}, {contact}, {note}, {task}, {tags,tagsAdded}) and the error bodies
// (a duplicate create is a 400 naming the existing contact in meta; an unknown contact id is a 400
// "not found", not a 404; a bad token is a 401). It is strict where GHL is and honest where the
// adapter could go wrong: search matches the stored E.164 number exactly (a bare ten digits finds
// nothing), POST tags merges, a PUT carrying tags replaces them, the location refuses duplicate
// contacts by phone or email, and a task without `completed` is refused. Every request is logged,
// and a failure (any status, a timeout, a network error, a hang until the caller's abort) can be
// queued per method and path. No network.

import { GHL_API_VERSION, GHL_BASE_URL } from "./ghl.ts";

export interface TwinContact {
  id: string;
  locationId: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  source: string | null;
  tags: string[];
  dnd?: boolean;
  dndSettings?: Record<string, { status: string }>;
  dateAdded: string;
}

export interface TwinNote {
  id: string;
  contactId: string;
  body: string;
  userId: string | null;
  dateAdded: string;
}

export interface TwinTask {
  id: string;
  contactId: string;
  title: string;
  body: string;
  dueDate: string;
  completed: boolean;
  assignedTo?: string;
}

export interface TwinRequest {
  method: string;
  path: string;
  url: string;
  headers: Record<string, string>; // lowercased names
  body: any; // parsed JSON, or undefined without a body
}

export type TwinFailure =
  | { status: number; body?: unknown; headers?: Record<string, string> }
  | "timeout"
  | "network"
  | "hang";

export interface GhlTwin {
  fetch: typeof fetch;
  contacts: TwinContact[];
  notes: TwinNote[];
  tasks: TwinTask[];
  requests: TwinRequest[];
  addContact(fields: Partial<TwinContact>): TwinContact;
  contact(id: string): TwinContact | undefined;
  /** The next `times` requests matching method and path get this answer instead. */
  failNext(method: string, path: string | RegExp, failure: TwinFailure, times?: number): void;
  /** The next search for this number finds nothing (an index behind a write), `times` times. */
  hideFromSearch(phone: string, times?: number): void;
  /** Every request that can change something (not a search, not a GET). */
  writes(): TwinRequest[];
}

const PUT_FIELDS = new Set(["firstName", "lastName", "name", "email", "phone", "tags", "dnd", "dndSettings", "source"]);
const RATE_HEADERS = {
  "x-ratelimit-max": "100",
  "x-ratelimit-interval-milliseconds": "10000",
  "x-ratelimit-remaining": "99",
  "x-ratelimit-limit-daily": "200000",
};

export function createGhlTwin(opts: {
  token: string;
  locationId: string;
  now?: () => Date;
  dndOnCreate?: boolean; // the location marks every new contact do-not-contact
}): GhlTwin {
  const now = opts.now ?? (() => new Date());
  const contacts: TwinContact[] = [];
  const notes: TwinNote[] = [];
  const tasks: TwinTask[] = [];
  const requests: TwinRequest[] = [];
  const failures: {
    method: string;
    path: string | RegExp;
    failure: TwinFailure;
    times: number;
  }[] = [];
  const hidden = new Map<string, number>();
  let seq = 0;
  const nextId = (prefix: string) => `${prefix}${(++seq).toString(36).padStart(6, "x")}`;

  const reply = (status: number, body?: unknown, headers: Record<string, string> = {}) =>
    new Response(body === undefined ? "" : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...RATE_HEADERS, ...headers },
    });
  const contactNotFound = (id: string) => reply(400, { error: `Contact with id ${id} not found`, status: 400 });
  const copy = <T>(v: T): T => structuredClone(v);

  function addContact(fields: Partial<TwinContact>): TwinContact {
    const c: TwinContact = {
      id: fields.id ?? nextId("ct"),
      locationId: fields.locationId ?? opts.locationId,
      firstName: fields.firstName ?? null,
      lastName: fields.lastName ?? null,
      email: fields.email ?? null,
      phone: fields.phone ?? null,
      source: fields.source ?? null,
      tags: [...(fields.tags ?? [])],
      dateAdded: fields.dateAdded ?? now().toISOString(),
      ...(fields.dnd !== undefined ? { dnd: fields.dnd } : {}),
      ...(fields.dndSettings !== undefined ? { dndSettings: copy(fields.dndSettings) } : {}),
    };
    contacts.push(c);
    return c;
  }

  function takeFailure(method: string, path: string): TwinFailure | null {
    const i = failures.findIndex((f) =>
      f.method === method &&
      (typeof f.path === "string" ? f.path === path : f.path.test(path))
    );
    if (i < 0) return null;
    const f = failures[i];
    if (--f.times <= 0) failures.splice(i, 1);
    return f.failure;
  }

  function route(method: string, path: string, body: any): Response {
    if (method === "POST" && path === "/contacts/search") {
      if (body?.locationId !== opts.locationId) return reply(403, { statusCode: 403, message: "Forbidden resource" });
      const filter = Array.isArray(body.filters) ? body.filters[0] : null;
      if (!filter || filter.field !== "phone" || filter.operator !== "eq") {
        return reply(422, { statusCode: 422, message: ["filters must be a phone eq filter in this twin"] });
      }
      const value = String(filter.value ?? "");
      const left = hidden.get(value) ?? 0;
      if (left > 0) {
        hidden.set(value, left - 1);
        return reply(200, { contacts: [], total: 0, traceId: nextId("tr") });
      }
      const hits = contacts.filter((c) => c.phone === value).map(copy);
      return reply(200, { contacts: hits, total: hits.length, traceId: nextId("tr") });
    }
    if (method === "POST" && path === "/contacts/") {
      if (body?.locationId !== opts.locationId) return reply(403, { statusCode: 403, message: "Forbidden resource" });
      const byPhone = body.phone ? contacts.find((c) => c.phone === body.phone) : undefined;
      const email = typeof body.email === "string" ? body.email.toLowerCase() : null;
      const byEmail = email ? contacts.find((c) => c.email?.toLowerCase() === email) : undefined;
      const dup = byPhone ?? byEmail;
      if (dup) {
        return reply(400, {
          statusCode: 400,
          message: "This location does not allow duplicated contacts.",
          meta: {
            contactId: dup.id,
            matchingField: byPhone ? "phone" : "email",
            contactName: `${dup.firstName ?? ""} ${dup.lastName ?? ""}`.trim(),
          },
        });
      }
      const c = addContact({
        firstName: body.firstName ?? null,
        lastName: body.lastName ?? null,
        email: body.email ?? null,
        phone: body.phone ?? null,
        source: body.source ?? null,
        tags: Array.isArray(body.tags) ? body.tags : [],
        ...(opts.dndOnCreate ? { dnd: true } : {}),
      });
      return reply(201, { contact: copy(c) });
    }
    const m = /^\/contacts\/([^/]+)(\/(tags|notes|tasks))?$/.exec(path);
    if (!m) return reply(404, { statusCode: 404, message: `Cannot ${method} ${path}` });
    const id = decodeURIComponent(m[1]);
    const c = contacts.find((x) => x.id === id);
    const sub = m[3];
    if (!c) return contactNotFound(id);
    if (!sub && method === "GET") return reply(200, { contact: copy(c) });
    if (!sub && method === "PUT") {
      const extra = Object.keys(body ?? {}).filter((k) => !PUT_FIELDS.has(k));
      if (extra.length) {
        return reply(422, { statusCode: 422, message: extra.map((k) => `property ${k} should not exist`) });
      }
      for (const [k, v] of Object.entries(body ?? {})) {
        (c as any)[k] = Array.isArray(v) ? [...v] : v; // arrays replaced
      }
      return reply(200, { succeded: true, succeeded: true, contact: copy(c) });
    }
    if (sub === "tags" && method === "POST") {
      const add = Array.isArray(body?.tags) ? body.tags.map(String) : [];
      const added = add.filter((t: string) => !c.tags.includes(t));
      c.tags.push(...added);
      return reply(201, { tags: [...c.tags], tagsAdded: added });
    }
    if (sub === "notes" && method === "POST") {
      if (typeof body?.body !== "string" || !body.body) {
        return reply(422, { statusCode: 422, message: ["body must be a string"] });
      }
      const note: TwinNote = {
        id: nextId("nt"),
        contactId: c.id,
        body: body.body,
        userId: body.userId ?? null,
        dateAdded: now().toISOString(),
      };
      notes.push(note);
      return reply(201, { note: copy(note) });
    }
    if (sub === "tasks" && method === "POST") {
      if (typeof body?.completed !== "boolean") {
        return reply(422, { statusCode: 422, message: ["completed must be a boolean value"] });
      }
      if (typeof body.title !== "string" || !Number.isFinite(Date.parse(body.dueDate))) {
        return reply(422, { statusCode: 422, message: ["title and dueDate are required"] });
      }
      const task: TwinTask = {
        id: nextId("tk"),
        contactId: c.id,
        title: body.title,
        body: body.body ?? "",
        dueDate: body.dueDate,
        completed: body.completed,
        ...(body.assignedTo ? { assignedTo: body.assignedTo } : {}),
      };
      tasks.push(task);
      return reply(201, { task: copy(task) });
    }
    return reply(404, { statusCode: 404, message: `Cannot ${method} ${path}` });
  }

  const twinFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (`${url.protocol}//${url.host}` !== GHL_BASE_URL) throw new Error(`ghl twin: unexpected host in ${url}`);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const raw = typeof init?.body === "string" ? init.body : undefined;
    const body = raw === undefined ? undefined : JSON.parse(raw);
    requests.push({ method, path: url.pathname, url: String(url), headers, body });

    const failure = takeFailure(method, url.pathname);
    if (failure === "timeout") throw new DOMException("The signal has been aborted", "TimeoutError");
    if (failure === "network") throw new TypeError("error sending request: connection reset");
    if (failure === "hang") {
      return await new Promise<Response>((_, reject) => {
        const signal = init?.signal;
        if (!signal) return; // never settles: the caller had to bring a timeout
        if (signal.aborted) reject(signal.reason);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    if (failure) return reply(failure.status, failure.body ?? {}, failure.headers);

    if (headers.authorization !== `Bearer ${opts.token}`) {
      return reply(401, { statusCode: 401, message: "Invalid Private Integration token" });
    }
    if (headers.version !== GHL_API_VERSION) {
      return reply(400, { statusCode: 400, message: "Version header is missing or not supported" });
    }
    return route(method, url.pathname, body);
  }) as typeof fetch;

  return {
    fetch: twinFetch,
    contacts,
    notes,
    tasks,
    requests,
    addContact,
    contact: (id) => contacts.find((c) => c.id === id),
    failNext(method, path, failure, times = 1) {
      failures.push({ method: method.toUpperCase(), path, failure, times });
    },
    hideFromSearch(phone, times = 1) {
      hidden.set(phone, (hidden.get(phone) ?? 0) + times);
    },
    writes: () => requests.filter((r) => r.method !== "GET" && r.path !== "/contacts/search"),
  };
}
