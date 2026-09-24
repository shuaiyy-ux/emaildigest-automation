"use client";

import { useEffect, useState } from "react";
import { BookmarkCheck, Bookmark } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";

interface Category { id: string; name: string }

/** Tags an email with a gold-standard category for the eval_set regression test. */
export function GoldLabelPicker({ emailId }: { emailId: string }) {
  const [categories, setCategories] = useState<Category[]>([]);
  const [goldId, setGoldId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/categories")
      .then((r) => r.json())
      .then((d) => setCategories(d.categories || []));
    // Check current label
    fetch("/api/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "listEvalSet" }),
    })
      .then((r) => r.json())
      .then((d) => {
        const row = (d.evalSet || []).find((r: { email_id: string; gold_category_id: string }) => r.email_id === emailId);
        setGoldId(row?.gold_category_id || null);
      });
  }, [emailId]);

  async function setLabel(categoryId: string) {
    setSaving(true);
    await fetch("/api/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "addEvalLabel", emailId, goldCategoryId: categoryId }),
    });
    setGoldId(categoryId);
    setSaving(false);
  }

  async function removeLabel() {
    setSaving(true);
    await fetch("/api/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "removeEvalLabel", emailId }),
    });
    setGoldId(null);
    setSaving(false);
  }

  const labeled = !!goldId;
  const Icon = labeled ? BookmarkCheck : Bookmark;
  const color = labeled ? "text-amber-500" : "text-muted-foreground";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon" className={`h-8 w-8 ${color}`} title="Mark as gold label for eval" />}>
        <Icon className="h-4 w-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={4}>
        <DropdownMenuLabel>
          {labeled ? "Gold label: " + (categories.find((c) => c.id === goldId)?.name || goldId) : "Mark as gold label"}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup value={goldId || ""} onValueChange={setLabel}>
          {categories.map((c) => (
            <DropdownMenuRadioItem key={c.id} value={c.id} disabled={saving}>
              {c.name}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {labeled && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={removeLabel} disabled={saving} className="text-destructive">
              Remove from eval set
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
