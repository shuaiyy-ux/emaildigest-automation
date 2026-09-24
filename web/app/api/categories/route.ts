import {
  listCategories,
  getCategoryById,
  getCategoryByName,
  upsertCategory,
  deleteCategory,
} from "@/lib/db";
import { slugify } from "@/lib/category-helpers";

export async function GET() {
  try {
    const cats = listCategories().map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      color: c.color,
      icon: c.icon,
      isDefault: c.is_default === 1,
      sortOrder: c.sort_order,
      exampleCount: 0,
    }));
    return Response.json({ categories: cats });
  } catch (e) {
    console.error("[categories GET] error:", e);
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }

  try {
    if (body.action === "create") {
      const name = ((body.name as string) || "").trim();
      if (!name) return Response.json({ error: "Name required" }, { status: 400 });
      const existing = getCategoryByName(name);
      if (existing) return Response.json({ error: `Category "${name}" already exists` }, { status: 409 });
      const id = "cat_" + slugify(name);
      const cat = upsertCategory({
        id,
        name,
        description: (body.description as string) || "",
        color: (body.color as string) || "",
        icon: (body.icon as string) || "Tag",
        is_default: false,
        sort_order: typeof body.sortOrder === "number" ? body.sortOrder : 100,
      });
      return Response.json({ category: cat });
    }

    if (body.action === "update" && body.id) {
      const id = body.id as string;
      const cur = getCategoryById(id);
      if (!cur) return Response.json({ error: "Category not found" }, { status: 404 });
      const updated = upsertCategory({
        id,
        name: (body.name as string) ?? cur.name,
        description: (body.description as string) ?? cur.description,
        color: (body.color as string) ?? cur.color,
        icon: (body.icon as string) ?? cur.icon,
        is_default: cur.is_default === 1,
        sort_order: typeof body.sortOrder === "number" ? body.sortOrder : cur.sort_order,
      });
      return Response.json({ category: updated });
    }

    if (body.action === "delete" && body.id) {
      const id = body.id as string;
      const cur = getCategoryById(id);
      if (!cur) return Response.json({ error: "Category not found" }, { status: 404 });
      if (cur.is_default === 1) return Response.json({ error: "Cannot delete default category" }, { status: 400 });
      deleteCategory(id);
      return Response.json({ deleted: true });
    }

    return Response.json({ error: "Unknown action" }, { status: 400 });
  } catch (e) {
    console.error("[categories POST] error:", e);
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
