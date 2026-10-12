import type { CSSProperties } from "react";
import { Toaster as Sonner, toast, type ToasterProps } from "sonner";
import { useTheme } from "@/lib/theme";

// Toasts follow the app theme store (not next-themes) and the same surface tokens as cards.
function Toaster(props: ToasterProps) {
  const { resolved } = useTheme();
  return (
    <Sonner
      theme={resolved}
      position="bottom-right"
      closeButton
      style={
        {
          "--normal-bg": "var(--card)",
          "--normal-text": "var(--ink-1)",
          "--normal-border": "var(--border)",
        } as CSSProperties
      }
      toastOptions={{ classNames: { description: "text-ink-2" } }}
      {...props}
    />
  );
}

export { toast, Toaster };
