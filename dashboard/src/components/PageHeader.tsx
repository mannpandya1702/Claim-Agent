import { ChevronLeft } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";

interface PageHeaderProps {
  title: ReactNode;
  /** Plain-text title for the browser tab when `title` is not a string. */
  documentTitle?: string;
  description?: ReactNode;
  actions?: ReactNode;
  back?: { to: string; label: string };
  className?: string;
}

export const APP_NAME = "Observe Claims Ops";

export function PageHeader({ title, documentTitle, description, actions, back, className }: PageHeaderProps) {
  const tabTitle = documentTitle ?? (typeof title === "string" ? title : null);
  useEffect(() => {
    document.title = tabTitle ? `${tabTitle} · ${APP_NAME}` : APP_NAME;
  }, [tabTitle]);

  return (
    <header className={cn("mb-5 flex flex-col gap-3 sm:mb-6 sm:flex-row sm:items-end sm:justify-between", className)}>
      <div className="min-w-0 space-y-1">
        {back && (
          <Link
            to={back.to}
            className="-ml-1 inline-flex items-center gap-0.5 rounded-sm text-xs font-medium text-ink-2 hover:text-ink-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronLeft className="size-3.5" aria-hidden="true" />
            {back.label}
          </Link>
        )}
        <h1 className="truncate text-xl font-semibold tracking-tight text-ink-1 sm:text-2xl">{title}</h1>
        {description && <div className="text-sm text-ink-2">{description}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
