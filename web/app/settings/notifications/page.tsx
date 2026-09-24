import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { NotificationsForm } from "@/components/settings/notifications-form";

export default function NotificationsPage() {
  return (
    <div className="h-full overflow-auto pt-safe pb-safe">
      <div className="max-w-xl mx-auto p-6">
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to inbox
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Notifications</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Digest summary at 9 AM, 3 PM and 9 PM PT, sent only when an email needs action.
        </p>
        <div className="mt-6">
          <NotificationsForm />
        </div>
      </div>
    </div>
  );
}
