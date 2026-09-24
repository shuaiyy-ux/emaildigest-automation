"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Hint } from "@/components/ui/hint";
import { changeCategory, type EmailCategory } from "@/lib/types";
import { getBadgeVariant } from "@/lib/utils";
import { useCategories } from "./use-mail";

interface CategoryPickerProps {
  emailId: string;
  currentCategory: EmailCategory;
  fromEmail?: string;
  subject?: string;
  onChanged: (category: EmailCategory) => void;
}

export function CategoryPicker({ emailId, currentCategory, fromEmail, subject, onChanged }: CategoryPickerProps) {
  const { categories } = useCategories();
  const [saving, setSaving] = useState(false);

  async function handleSelect(value: string) {
    const newCategory = value as EmailCategory;
    if (newCategory === currentCategory) return;
    setSaving(true);
    try {
      await changeCategory(emailId, newCategory, currentCategory, fromEmail, subject);
      onChanged(newCategory);
    } catch (e) {
      console.error("[category-picker] save error:", e);
    }
    setSaving(false);
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger nativeButton={false} render={
        <Badge
          variant={getBadgeVariant(currentCategory)}
          className="mt-1 text-[10px] cursor-pointer hover:opacity-80 transition-opacity focus:outline-none inline-flex items-center gap-1"
        />
      }>
        {saving ? (
          <Hint label="Saving correction…">
            <span className="inline-flex items-center gap-1">
              <Loader2 className="h-2.5 w-2.5 animate-spin" />
              <span>Saving</span>
            </span>
          </Hint>
        ) : (categories.find((c) => c.id === `cat_${currentCategory}`)?.name ?? currentCategory)}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={4}>
        <DropdownMenuLabel>Change category</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup value={currentCategory} onValueChange={handleSelect}>
          {categories.map((cat) => {
            const legacy = cat.id.startsWith("cat_") ? cat.id.slice(4) : cat.name.toLowerCase();
            return (
              <DropdownMenuRadioItem key={cat.id} value={legacy}>
                {cat.name}
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
