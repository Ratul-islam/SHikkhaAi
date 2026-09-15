"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { isAxiosError } from "axios";
import { AlertTriangle, ArrowLeft, CheckCircle2, Info, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { IngestionJobStatus } from "../../lib/types";

/**
 * The admin console's shared building blocks — its surfaces, fields and status
 * vocabulary live here once, so every admin page reads as the same tool.
 */

export const FIELD_CLASS =
  "h-9 w-full rounded-[10px] border border-outline-variant bg-surface-container-lowest px-3 text-sm text-on-surface placeholder:text-on-surface-variant/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:bg-surface-container-low disabled:text-on-surface-variant";

export const CLASS_LEVELS = Array.from({ length: 12 }, (_, i) => i + 1);

export function errorMessage(err: unknown, fallback: string): string {
  if (isAxiosError(err)) {
    const data = err.response?.data as { error?: unknown } | undefined;
    if (typeof data?.error === "string") return data.error;
  }
  return fallback;
}

export function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

export function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function PageHeader({
  title,
  description,
  actions,
  backHref,
  backLabel,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  backHref?: string;
  backLabel?: string;
}): JSX.Element {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4 pb-6">
      <div className="min-w-0">
        {backHref && (
          <Link
            href={backHref}
            className="mb-2 inline-flex items-center gap-1 rounded text-sm text-on-surface-variant hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            <ArrowLeft className="size-3.5" />
            {backLabel}
          </Link>
        )}
        <h1 className="break-words text-[26px] font-semibold leading-tight tracking-tight text-on-surface">{title}</h1>
        {description && <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-on-surface-variant">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function Panel({
  title,
  description,
  actions,
  children,
  flush,
  className,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  /** No inner padding — for tables and lists that run edge to edge. */
  flush?: boolean;
  className?: string;
}): JSX.Element {
  return (
    <section className={cn("overflow-hidden rounded-2xl border border-outline-variant/70 bg-surface-container-lowest", className)}>
      {(title || actions) && (
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-outline-variant/50 px-5 py-4">
          <div className="min-w-0">
            {title && <h2 className="text-[15px] font-semibold text-on-surface">{title}</h2>}
            {description && <p className="mt-0.5 max-w-2xl text-sm text-on-surface-variant">{description}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={flush ? undefined : "p-5"}>{children}</div>
    </section>
  );
}

export function Field({ label, children, className }: { label: string; children: ReactNode; className?: string }): JSX.Element {
  return (
    <label className={cn("flex flex-col gap-1.5 text-sm font-medium text-on-surface", className)}>
      {label}
      {children}
    </label>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }): JSX.Element {
  return (
    <div className="rounded-xl border border-dashed border-outline-variant px-5 py-8 text-center">
      <p className="text-sm font-medium text-on-surface">{title}</p>
      {children && <div className="mx-auto mt-1 max-w-md text-sm text-on-surface-variant">{children}</div>}
    </div>
  );
}

const NOTICE_TONES = {
  error: { icon: XCircle, className: "border-error/30 bg-error-container/50 text-on-error-container" },
  warning: { icon: AlertTriangle, className: "border-secondary/30 bg-secondary-fixed/40 text-on-secondary-fixed-variant" },
  success: { icon: CheckCircle2, className: "border-primary/25 bg-primary-fixed/35 text-on-primary-fixed-variant" },
  info: { icon: Info, className: "border-outline-variant bg-surface-container-low text-on-surface-variant" },
} as const;

export function Notice({
  tone,
  children,
  className,
}: {
  tone: keyof typeof NOTICE_TONES;
  children: ReactNode;
  className?: string;
}): JSX.Element {
  const { icon: Icon, className: toneClass } = NOTICE_TONES[tone];
  return (
    <div role={tone === "error" ? "alert" : "status"} className={cn("flex gap-2.5 rounded-xl border px-3.5 py-2.5 text-sm", toneClass, className)}>
      <Icon className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

const JOB_STATUS: Record<IngestionJobStatus, { label: string; className: string; busy: boolean }> = {
  QUEUED: { label: "Queued", className: "bg-tertiary-fixed text-on-tertiary-fixed-variant", busy: true },
  READING: { label: "Reading pages", className: "bg-tertiary-fixed text-on-tertiary-fixed-variant", busy: true },
  READY_FOR_REVIEW: { label: "Ready for review", className: "bg-secondary-fixed text-on-secondary-fixed-variant", busy: false },
  COMMITTING: { label: "Publishing", className: "bg-tertiary-fixed text-on-tertiary-fixed-variant", busy: true },
  COMMITTED: { label: "Published", className: "bg-primary-fixed text-on-primary-fixed-variant", busy: false },
  FAILED: { label: "Failed", className: "bg-error-container text-on-error-container", busy: false },
};

/** A job whose status is still moving on its own — worth polling. */
export function isJobBusy(status: IngestionJobStatus): boolean {
  return JOB_STATUS[status].busy;
}

export function JobStatusPill({ status }: { status: IngestionJobStatus }): JSX.Element {
  const s = JOB_STATUS[status];
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium", s.className)}>
      <span className={cn("size-1.5 rounded-full bg-current", s.busy && "motion-safe:animate-pulse")} />
      {s.label}
    </span>
  );
}

export function ProgressBar({ value, label }: { value: number; label: string }): JSX.Element {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
      className="h-1.5 w-full overflow-hidden rounded-full bg-surface-container-high"
    >
      <div className="h-full rounded-full bg-primary transition-[width] duration-500 motion-reduce:transition-none" style={{ width: `${pct}%` }} />
    </div>
  );
}

export const TABLE_HEAD_CLASS = "border-b border-outline-variant/60 text-left text-xs font-medium text-on-surface-variant";
export const TABLE_ROW_CLASS = "border-b border-outline-variant/40 last:border-b-0";
