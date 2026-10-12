import { OctagonAlert, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface ErrorStateProps {
  title?: string;
  error?: unknown;
  onRetry?: () => void;
  compact?: boolean;
  className?: string;
}

export function errorMessage(error: unknown): string {
  if (!error) return "";
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (typeof error === "object" && "message" in error && typeof (error as { message: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return "Unexpected error.";
}

export function ErrorState({ title = "Could not load this", error, onRetry, compact = false, className }: ErrorStateProps) {
  const message = errorMessage(error);
  return (
    <div
      role="alert"
      className={cn("flex flex-col items-center justify-center text-center", compact ? "gap-2 px-4 py-8" : "gap-3 px-6 py-14", className)}
    >
      <span className="flex size-10 items-center justify-center rounded-full bg-[color-mix(in_oklab,var(--status-critical)_14%,var(--card))] text-critical-ink">
        <OctagonAlert className="size-5" aria-hidden="true" />
      </span>
      <div className="max-w-md space-y-1">
        <p className="text-sm font-semibold text-ink-1">{title}</p>
        {message && <p className="break-words text-sm text-ink-2">{message}</p>}
      </div>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RotateCw aria-hidden="true" />
          Try again
        </Button>
      )}
    </div>
  );
}
