/*
 * The seeded demo customers (supabase seed), so a presenter can run every scenario without a
 * second screen. These are fictional records; the 0199 number has no customer on purpose.
 * A web call carries no caller ID, so the caller says the phone number out loud.
 */

export interface DemoIdentity {
  /** Stable key for React and tests. */
  key: string;
  name: string | null;
  /** E.164, which is what the copy button puts on the clipboard. */
  phone: string;
  /** How the number is written on the card and read aloud. */
  phoneDisplay: string;
  dob: string | null;
  /** What to try with this identity. */
  scenarios: string[];
}

export const DEMO_IDENTITIES: readonly DemoIdentity[] = [
  {
    key: "tobias",
    name: "Tobias Halvorsen",
    phone: "+16025550101",
    phoneDisplay: "+1 602 555 0101",
    dob: "March 14, 1986",
    scenarios: [
      "Happy path: verify, then ask for the claim status",
      "Auth failure: give a wrong date of birth twice",
      "Ask for the document checklist by email",
      "Call again: Tessa greets a returning caller",
    ],
  },
  {
    key: "ronan",
    name: "Ronan Quintero",
    phone: "+16025550102",
    phoneDisplay: "+1 602 555 0102",
    dob: "November 2, 1979",
    scenarios: ["Ask to speak to a representative (escalation)"],
  },
  {
    key: "sloane",
    name: "Sloane Marchetti",
    phone: "+16025550103",
    phoneDisplay: "+1 602 555 0103",
    dob: "July 21, 1992",
    scenarios: ["Denied claim, then ask how to appeal"],
  },
  {
    key: "teague",
    name: "Teague Ashdown",
    phone: "+16025550104",
    phoneDisplay: "+1 602 555 0104",
    dob: "January 30, 1965",
    scenarios: ["Early-stage claim; no email on file"],
  },
  {
    key: "ines",
    name: "Ines Lindqvist",
    phone: "+16025550105",
    phoneDisplay: "+1 602 555 0105",
    dob: "May 9, 1990",
    scenarios: ["Customer with no claims"],
  },
  {
    key: "not-found",
    name: null,
    phone: "+16025550199",
    phoneDisplay: "+1 602 555 0199",
    dob: null,
    scenarios: ["No customer has this number (not found)"],
  },
];
