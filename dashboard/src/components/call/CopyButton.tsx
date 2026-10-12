import { Check, Copy, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type CopyState = "idle" | "copied" | "failed";

/** Clipboard API first; the execCommand fallback covers browsers that only allow it in a gesture. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permission or focus problems: fall through to the legacy path.
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand?.("copy") ?? false;
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

interface CopyButtonProps extends Omit<ButtonProps, "onClick" | "children"> {
  value: string;
  /** What is being copied, for the accessible name ("Copy phone number +1 602 555 0101"). */
  label: string;
  /** Show a word next to the icon. Icon-only buttons still carry the label for screen readers. */
  showText?: boolean;
}

export function CopyButton({ value, label, showText = false, className, variant = "ghost", size, ...rest }: CopyButtonProps) {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  async function onClick() {
    const ok = await copyText(value);
    setState(ok ? "copied" : "failed");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 2000);
  }

  const Icon = state === "copied" ? Check : state === "failed" ? X : Copy;
  const word = state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy";

  return (
    <>
      <Button
        variant={variant}
        size={size ?? (showText ? "sm" : "icon-sm")}
        onClick={() => void onClick()}
        aria-label={`Copy ${label}`}
        title={`Copy ${label}`}
        className={cn(state === "copied" && "text-good-ink", state === "failed" && "text-critical-ink", className)}
        {...rest}
      >
        <Icon aria-hidden="true" />
        {showText && <span>{word}</span>}
      </Button>
      {/* Announced separately so the button keeps a stable accessible name. */}
      <span className="sr-only" role="status" aria-live="polite">
        {state === "copied" ? `Copied ${label}` : state === "failed" ? `Could not copy ${label}` : ""}
      </span>
    </>
  );
}
