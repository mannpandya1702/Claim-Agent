import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "@/lib/utils";

// Status variants tint the background and use the status ink (AA on the tint); they still need
// an icon or a word, never color alone.
const badgeVariants = cva(
  "inline-flex max-w-full items-center gap-1.5 whitespace-nowrap rounded-md border px-2 py-0.5 text-xs font-medium leading-5 [&_svg]:size-3.5 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-ink",
        neutral: "border-border bg-card text-ink-1",
        muted: "border-transparent bg-muted text-ink-2",
        outline: "border-border-strong text-ink-1",
        good: "border-transparent bg-[color-mix(in_oklab,var(--status-good)_14%,var(--card))] text-good-ink",
        warning: "border-transparent bg-[color-mix(in_oklab,var(--status-warning)_18%,var(--card))] text-warning-ink",
        serious: "border-transparent bg-[color-mix(in_oklab,var(--status-serious)_16%,var(--card))] text-serious-ink",
        critical: "border-transparent bg-[color-mix(in_oklab,var(--status-critical)_14%,var(--card))] text-critical-ink",
      },
    },
    defaultVariants: { variant: "neutral" },
  },
);

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
