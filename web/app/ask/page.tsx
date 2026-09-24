import { Suspense } from "react";
import { AskPageClient } from "@/components/ask/ask-page-client";

export default function AskPage() {
  return (
    <Suspense fallback={<div className="h-screen flex items-center justify-center text-muted-foreground">Loading…</div>}>
      <AskPageClient />
    </Suspense>
  );
}
