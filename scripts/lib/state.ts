// .sync-state.json (gitignored): ids of live VAPI objects (credential, tools, assistants, squad,
// files, phone number), rendered-prompt hashes and probe results. The repo holds the desired
// config; this file maps it onto the live org.

const path = new URL("../../.sync-state.json", import.meta.url);

export interface SyncState {
  credentialId?: string;
  tools?: Record<string, string>;
  assistants?: Record<string, string>;
  squadId?: string;
  kbFileId?: string;
  phoneNumberId?: string;
  phoneNumber?: string;
  promptHashes?: Record<string, string>;
  probes?: Record<string, unknown>;
  [k: string]: unknown;
}

export function readState(): SyncState {
  try {
    return JSON.parse(Deno.readTextFileSync(path));
  } catch {
    return {};
  }
}

export function writeState(s: SyncState) {
  Deno.writeTextFileSync(path, JSON.stringify(s, null, 2) + "\n");
}
