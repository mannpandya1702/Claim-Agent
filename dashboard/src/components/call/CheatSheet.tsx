import { IdCard, Phone, UserRoundX } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatPhone } from "@/lib/format";
import { cn } from "@/lib/utils";
import { CopyButton } from "./CopyButton";
import { DEMO_IDENTITIES, type DemoIdentity } from "./identities";

interface CheatSheetProps {
  /** Backup phone number (E.164); the section is hidden when it is not set. */
  phoneNumber: string | null;
  className?: string;
}

/** Demo identities with copyable numbers, plus the backup phone line. */
export function CheatSheet({ phoneNumber, className }: CheatSheetProps) {
  return (
    <Card role="region" className={className} aria-labelledby="cheat-sheet-title">
      <CardHeader>
        <CardTitle id="cheat-sheet-title" className="flex items-center gap-2">
          <IdCard className="size-4 text-ink-3" aria-hidden="true" />
          Demo identities
        </CardTitle>
        <CardDescription>
          A web call has no caller ID, so say the phone number when Tessa asks, then the date of birth. All records are fictional.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ul className="grid gap-3 sm:grid-cols-2" aria-label="Demo identities">
          {DEMO_IDENTITIES.map((identity) => (
            <IdentityCard key={identity.key} identity={identity} />
          ))}
        </ul>
        {phoneNumber && <BackupPhone phoneNumber={phoneNumber} />}
      </CardContent>
    </Card>
  );
}

function IdentityCard({ identity }: { identity: DemoIdentity }) {
  const titleId = `identity-${identity.key}`;
  const notFound = identity.name === null;
  return (
    <li
      className={cn("flex min-w-0 flex-col gap-2 rounded-lg border p-3", notFound && "border-dashed")}
      data-identity={identity.key}
    >
      <p id={titleId} className="flex items-center gap-1.5 text-sm font-semibold text-ink-1">
        {notFound && <UserRoundX className="size-4 shrink-0 text-ink-3" aria-hidden="true" />}
        {identity.name ?? "Unknown number"}
      </p>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1 text-sm">
        <dt className="text-xs text-ink-3">Phone</dt>
        <dd className="flex min-w-0 items-center gap-1">
          <span className="truncate font-mono text-[13px] tabular text-ink-1">{identity.phoneDisplay}</span>
          <CopyButton value={identity.phone} label={`${identity.name ?? "not found"} phone number ${identity.phoneDisplay}`} className="-my-1" />
        </dd>
        {identity.dob && (
          <>
            <dt className="text-xs text-ink-3">Date of birth</dt>
            <dd className="text-ink-1">{identity.dob}</dd>
          </>
        )}
      </dl>
      <ul className="space-y-0.5 text-xs text-ink-2" aria-label={`Scenarios for ${identity.name ?? "the unknown number"}`}>
        {identity.scenarios.map((s) => (
          <li key={s} className="flex gap-1.5">
            <span aria-hidden="true" className="mt-[7px] size-1 shrink-0 rounded-full bg-ink-3" />
            <span>{s}</span>
          </li>
        ))}
      </ul>
    </li>
  );
}

function BackupPhone({ phoneNumber }: { phoneNumber: string }) {
  const display = formatPhone(phoneNumber);
  return (
    <section aria-labelledby="backup-phone-title" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-muted px-3 py-2.5">
      <Phone className="size-4 shrink-0 text-ink-3" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <h3 id="backup-phone-title" className="text-xs font-medium text-ink-2">
          Backup: call Tessa by phone
        </h3>
        <a
          href={`tel:${phoneNumber}`}
          className="rounded-sm font-mono text-sm font-semibold tabular text-link underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {display}
        </a>
      </div>
      <CopyButton value={phoneNumber} label={`backup phone number ${display}`} showText variant="outline" />
    </section>
  );
}
