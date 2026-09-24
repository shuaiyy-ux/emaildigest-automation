"use client";

import { useDemo } from "./demo-context";
import { cn } from "@/lib/utils";

/** Corner watermark for dashboard panels and charts. Place inside a `relative` container. */
export function DemoWatermark({ className }: { className?: string }) {
  const demo = useDemo();
  if (!demo) return null;
  return (
    <span
      aria-hidden
      className={cn(
        "pointer-events-none select-none absolute z-10 text-[10px] font-medium text-white/30",
        className ?? "bottom-2 right-3",
      )}
    >
      Anonymized sample data
    </span>
  );
}

/** Visible note on the Jobs page and on job-related emails. */
export function CompanyNameNote({ className }: { className?: string }) {
  const demo = useDemo();
  if (!demo) return null;
  return (
    <p
      className={cn(
        "rounded-md border border-[rgba(252,211,77,0.25)] bg-[rgba(252,211,77,0.06)] px-3 py-1.5 text-xs text-[#fde68a]",
        className,
      )}
    >
      Company names are intentionally anonymized in this demo.
    </p>
  );
}
