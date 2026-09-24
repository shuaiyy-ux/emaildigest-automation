import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { ProfileForm } from "@/components/settings/profile-form";

export default function ProfilePage() {
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
        <h1 className="text-2xl font-semibold tracking-tight">Profile</h1>
        <div className="mt-6">
          <ProfileForm />
        </div>
      </div>
    </div>
  );
}
