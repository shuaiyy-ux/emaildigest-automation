"use client";

import { useEffect, useState } from "react";
import { Plus, Trash2, Edit3, X, Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { ICON_NAMES, getCategoryIcon } from "@/lib/category-icons";
import type { DynamicCategory, Email } from "@/lib/types";

function Switch({ checked, onCheckedChange }: { checked: boolean; onCheckedChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onCheckedChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
        checked ? "bg-foreground" : "bg-muted"
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-background transition-transform ${
          checked ? "translate-x-4" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

function renderIcon(name: string, className = "h-4 w-4") {
  const Icon = getCategoryIcon(name);
  return <Icon className={className} />;
}

interface CategoryFormState {
  id?: string;
  name: string;
  description: string;
  icon: string;
  exampleEmailIds: string[];
}

const EMPTY_FORM: CategoryFormState = {
  name: "", description: "", icon: "Tag", exampleEmailIds: [],
};

export function CategoryManager() {
  const [categories, setCategories] = useState<DynamicCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState<CategoryFormState>(EMPTY_FORM);
  const [editing, setEditing] = useState<DynamicCategory | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    const res = await fetch("/api/categories");
    const data = await res.json();
    setCategories(data.categories || []);
    setLoading(false);
  };

  useEffect(() => { refresh(); }, []);

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setError(null);
    setModalOpen(true);
  };

  const openEdit = (cat: DynamicCategory) => {
    setEditing(cat);
    setForm({
      id: cat.id,
      name: cat.name,
      description: cat.description,
      icon: cat.icon || "Tag",
      exampleEmailIds: [],
    });
    setError(null);
    setModalOpen(true);
  };

  const closeModal = () => {
    setModalOpen(false);
    setForm(EMPTY_FORM);
    setEditing(null);
    setError(null);
  };

  const submitCreate = async () => {
    setSaving(true);
    setError(null);
    const res = await fetch("/api/categories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "create",
        name: form.name,
        description: form.description,
        icon: form.icon,
        exampleEmailIds: form.exampleEmailIds,
      }),
    });
    const data = await res.json();
    setSaving(false);
    if (!res.ok || data.error) { setError(data.error || "Create failed"); return; }
    await refresh();
    closeModal();
  };

  const submitEdit = async () => {
    if (!editing) return;
    setSaving(true);
    setError(null);
    // Update metadata
    const res = await fetch("/api/categories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "update",
        id: editing.id,
        name: form.name,
        description: form.description,
        icon: form.icon,
      }),
    });
    if (!res.ok) { setError((await res.json()).error || "Update failed"); setSaving(false); return; }
    // Add newly selected examples
    if (form.exampleEmailIds.length > 0) {
      await fetch(`/api/categories/${editing.id}/examples`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "addBulk", emailIds: form.exampleEmailIds, source: "user_correction" }),
      });
    }
    setSaving(false);
    await refresh();
    closeModal();
  };

  const submitDelete = async (cat: DynamicCategory) => {
    if (!confirm(`Delete category "${cat.name}"? Emails in it will be unclassified.`)) return;
    const res = await fetch("/api/categories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete", id: cat.id }),
    });
    if (res.ok) refresh();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">
          {loading ? "Loading…" : `${categories.length} categories`}
        </div>
        <Button size="sm" onClick={openCreate} className="gap-1.5">
          <Plus className="h-3.5 w-3.5" /> Add category
        </Button>
      </div>

      <div className="rounded-lg border border-border divide-y divide-border">
        {categories.map((cat) => (
          <div key={cat.id} className="flex items-center gap-3 px-4 py-3">
            <div className="h-8 w-8 rounded-md bg-muted flex items-center justify-center shrink-0">
              {renderIcon(cat.icon)}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-medium text-sm">{cat.name}</span>
                {cat.isDefault && <Badge variant="secondary" className="text-[9px]">Default</Badge>}
                {cat.exampleCount > 0 ? (
                  <Badge variant="outline" className="text-[9px]">{cat.exampleCount} examples</Badge>
                ) : (
                  <Badge variant="outline" className="text-[9px] text-muted-foreground">No examples</Badge>
                )}
              </div>
              {cat.description && (
                <div className="text-xs text-muted-foreground truncate mt-0.5">{cat.description}</div>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(cat)} title="Edit">
                <Edit3 className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => submitDelete(cat)}
                disabled={cat.isDefault}
                title={cat.isDefault ? "Default categories cannot be deleted" : "Delete"}
              >
                <Trash2 className="h-3.5 w-3.5 text-destructive/70" />
              </Button>
            </div>
          </div>
        ))}
      </div>

      {modalOpen && (
        <CategoryEditModal
          title={editing ? `Edit ${editing.name}` : "Add category"}
          form={form}
          setForm={setForm}
          onClose={closeModal}
          onSubmit={editing ? submitEdit : submitCreate}
          saving={saving}
          error={error}
          showExisting={!!editing}
        />
      )}
    </div>
  );
}

function CategoryEditModal({
  title, form, setForm, onClose, onSubmit, saving, error, showExisting,
}: {
  title: string;
  form: CategoryFormState;
  setForm: (f: CategoryFormState) => void;
  onClose: () => void;
  onSubmit: () => void;
  saving: boolean;
  error: string | null;
  showExisting: boolean;
}) {
  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
        <div className="w-full max-w-2xl rounded-xl border border-border bg-card shadow-2xl p-5 space-y-4 max-h-[90vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-between">
            <h3 className="text-base font-semibold">{title}</h3>
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose}><X className="h-4 w-4" /></Button>
          </div>

          <div className="space-y-3">
            <div>
              <label className="text-xs text-muted-foreground">Name</label>
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Shopping"
                className="h-9 text-sm mt-1"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Description</label>
              <Textarea
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="Order confirmations, shipping notices, receipts from online stores"
                className="text-sm mt-1 min-h-[60px]"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Icon</label>
              <div className="flex flex-wrap gap-1 mt-1">
                {ICON_NAMES.map((name) => (
                  <button
                    key={name}
                    type="button"
                    onClick={() => setForm({ ...form, icon: name })}
                    className={`h-8 w-8 rounded-md flex items-center justify-center transition-colors ${
                      form.icon === name ? "bg-foreground text-background" : "bg-muted text-muted-foreground hover:text-foreground"
                    }`}
                    title={name}
                  >
                    {renderIcon(name)}
                  </button>
                ))}
              </div>
            </div>
            {showExisting && form.id && (
              <ExistingExamples categoryId={form.id} />
            )}

            <EmailPicker
              selected={form.exampleEmailIds}
              onChange={(ids) => setForm({ ...form, exampleEmailIds: ids })}
              label={showExisting ? "Add more example emails" : "Select 5–10 example emails"}
            />
          </div>

          {error && (
            <div className="text-xs text-destructive">{error}</div>
          )}

          <div className="flex gap-2 justify-end">
            <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
            <Button size="sm" onClick={onSubmit} disabled={saving || !form.name.trim()} className="gap-1.5">
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              {showExisting ? "Save" : "Create"}
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}

function EmailPicker({ selected, onChange, label }: { selected: string[]; onChange: (ids: string[]) => void; label: string }) {
  const [emails, setEmails] = useState<Email[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    fetch("/api/emails")
      .then((r) => r.json())
      .then((d) => setEmails((d.emails || []).slice(0, 200)))
      .finally(() => setLoading(false));
  }, []);

  const visible = emails.filter((e) => {
    if (!filter) return true;
    const q = filter.toLowerCase();
    return e.from.toLowerCase().includes(q) || e.subject.toLowerCase().includes(q);
  });

  const toggle = (id: string) => {
    onChange(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);
  };

  return (
    <div>
      <div className="flex items-center justify-between">
        <label className="text-xs text-muted-foreground">{label}</label>
        <span className="text-[10px] text-muted-foreground">{selected.length} selected</span>
      </div>
      <Input
        placeholder="Filter by sender or subject"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        className="h-8 text-xs mt-1"
      />
      <div className="mt-2 max-h-48 overflow-y-auto rounded-md border border-border divide-y divide-border">
        {loading ? (
          <div className="flex items-center justify-center py-4 text-xs text-muted-foreground gap-1.5">
            <Loader2 className="h-3 w-3 animate-spin" /> Loading…
          </div>
        ) : visible.length === 0 ? (
          <div className="py-4 text-center text-xs text-muted-foreground">No emails match</div>
        ) : visible.slice(0, 100).map((e) => (
          <label key={e.id} className="flex items-center gap-2 px-2 py-1.5 hover:bg-accent/50 cursor-pointer text-xs">
            <input
              type="checkbox"
              checked={selected.includes(e.id)}
              onChange={() => toggle(e.id)}
              className="shrink-0"
            />
            <span className="font-medium truncate flex-1">{e.from}</span>
            <span className="text-muted-foreground truncate flex-[2]">{e.subject}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

interface ExistingExample {
  id: number;
  emailId: string | null;
  source: string;
  subjectPreview: string;
  createdAt: number;
}

function ExistingExamples({ categoryId }: { categoryId: string }) {
  const [examples, setExamples] = useState<ExistingExample[]>([]);
  const [loading, setLoading] = useState(true);
  const [removing, setRemoving] = useState<number | null>(null);
  const [hidePublic, setHidePublic] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // A non-JSON or non-2xx reply used to leave this list on "Loading…" forever;
  // show the failure with its status instead.
  const refresh = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch(`/api/categories/${categoryId}/examples`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setExamples(data.examples || []);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); }, [categoryId]);

  const removeOne = async (id: number) => {
    setRemoving(id);
    await fetch(`/api/categories/${categoryId}/examples`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "remove", exampleId: id }),
    });
    setRemoving(null);
    refresh();
  };

  const visible = hidePublic ? examples.filter((e) => e.source !== "public_dataset") : examples;
  const publicCount = examples.filter((e) => e.source === "public_dataset").length;

  return (
    <div>
      <div className="flex items-center justify-between">
        <div className="flex gap-3 text-xs text-muted-foreground">
          <label>Current examples</label>
          {!loading && !loadError && <span className="tabular-nums">{examples.length} total</span>}
          {publicCount > 0 && <span className="tabular-nums">{publicCount} from public dataset</span>}
        </div>
        {publicCount > 0 && (
          <button
            type="button"
            onClick={() => setHidePublic(!hidePublic)}
            className="text-[10px] text-muted-foreground hover:text-foreground"
          >
            {hidePublic ? "Show public" : "Hide public"}
          </button>
        )}
      </div>
      <div className="mt-2 max-h-48 overflow-y-auto rounded-md border border-border divide-y divide-border">
        {loading ? (
          <div className="flex items-center justify-center py-4 text-xs text-muted-foreground gap-1.5">
            <Loader2 className="h-3 w-3 animate-spin" /> Loading…
          </div>
        ) : loadError ? (
          <div className="py-4 text-center text-xs text-destructive">
            Loading examples failed. {loadError}
          </div>
        ) : visible.length === 0 ? (
          <div className="py-4 text-center text-xs text-muted-foreground">
            {hidePublic && publicCount > 0 ? "No examples besides the hidden public dataset" : "No examples"}
          </div>
        ) : visible.slice(0, 200).map((ex) => (
          <div key={ex.id} className="flex items-center gap-2 px-2 py-1.5 text-xs">
            <span className="shrink-0 text-[10px] text-muted-foreground/70">
              {ex.source === "public_dataset" ? "Public" : ex.source === "user_correction" ? "User" : "Seed"}
            </span>
            <span className="truncate flex-1">{ex.subjectPreview || "No preview"}</span>
            <button
              type="button"
              onClick={() => removeOne(ex.id)}
              disabled={removing === ex.id}
              className="shrink-0 h-5 w-5 rounded flex items-center justify-center text-muted-foreground hover:text-destructive hover:bg-destructive/10 disabled:opacity-40"
              title="Remove example"
            >
              {removing === ex.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
