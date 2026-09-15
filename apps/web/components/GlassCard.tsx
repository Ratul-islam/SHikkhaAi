import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export interface GlassCardProps extends HTMLAttributes<HTMLDivElement> {
  strong?: boolean;
}

/** The one recurring surface treatment across the app: a translucent, blurred panel over the paper background. */
export default function GlassCard({ strong, className, ...props }: GlassCardProps) {
  return (
    <div
      className={cn(
        "bg-surface-container-lowest/60 backdrop-blur-3xl border border-outline-variant/30 shadow-[0_16px_40px_rgba(0,0,0,0.08)] rounded-[2.5rem]",
        className,
      )}
      {...props}
    />
  );
}
