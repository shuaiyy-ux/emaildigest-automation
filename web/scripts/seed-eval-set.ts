/**
 * Seed eval_set with gold labels.
 *
 *   tsx scripts/seed-eval-set.ts --from-corrections
 *     Import every row from `corrections` as a gold label
 *     (user_category mapped to cat_<short>).
 *
 *   tsx scripts/seed-eval-set.ts --sample N
 *     Print a stratified-by-category markdown checklist of N emails
 *     for manual review via the GoldLabelPicker UI (NEXT_PUBLIC_DEV_TOOLS=1).
 */
import db, { addEvalLabel, listCategories, listEvalSet } from "../lib/db";

type CorrectionRow = {
  email_id: string;
  user_category: string;
  from_email: string;
  subject: string;
};

function mapUserCategoryToId(userCategory: string, validIds: Set<string>): string | null {
  const raw = userCategory.toLowerCase().trim();
  const candidate = raw.startsWith("cat_") ? raw : `cat_${raw}`;
  return validIds.has(candidate) ? candidate : null;
}

function fromCorrections() {
  const cats = listCategories();
  const validIds = new Set(cats.map((c) => c.id));
  const rows = db.prepare(
    "SELECT email_id, user_category, from_email, subject FROM corrections"
  ).all() as CorrectionRow[];

  let added = 0, skipped = 0;
  for (const r of rows) {
    const id = mapUserCategoryToId(r.user_category, validIds);
    if (!id) {
      console.warn(`skip: ${r.email_id} user_category="${r.user_category}" has no matching category`);
      skipped++;
      continue;
    }
    addEvalLabel(r.email_id, id);
    added++;
  }
  console.log(`Imported ${added} corrections into eval_set; skipped ${skipped}`);
  console.log(`eval_set total now: ${listEvalSet().length}`);
}

function sampleStratified(n: number) {
  const cats = listCategories();
  const perCat = Math.max(1, Math.ceil(n / cats.length));
  const existing = new Set(listEvalSet().map((r) => r.email_id));

  console.log(`# Gold-label review checklist\n`);
  console.log(`Open each email in the app (NEXT_PUBLIC_DEV_TOOLS=1) and use GoldLabelPicker.\n`);

  for (const c of cats) {
    const rows = db.prepare(
      `SELECT id, from_email, subject, category_id
       FROM emails
       WHERE category_id = ? AND id NOT IN (SELECT email_id FROM eval_set)
       ORDER BY received_at DESC
       LIMIT ?`
    ).all(c.id, perCat) as { id: string; from_email: string; subject: string; category_id: string }[];

    console.log(`## ${c.name} (${c.id}) — predicted, need confirmation\n`);
    if (rows.length === 0) {
      console.log("_no eligible emails_\n");
      continue;
    }
    console.log("| email_id | from | subject |");
    console.log("|---|---|---|");
    for (const r of rows) {
      const subj = r.subject.replace(/\|/g, "\\|").slice(0, 80);
      console.log(`| ${r.id} | ${r.from_email} | ${subj} |`);
    }
    console.log("");
  }
  console.log(`(${existing.size} emails already in eval_set, excluded)`);
}

const args = process.argv.slice(2);
if (args.includes("--from-corrections")) {
  fromCorrections();
} else if (args.includes("--sample")) {
  const idx = args.indexOf("--sample");
  const n = parseInt(args[idx + 1] || "20", 10);
  sampleStratified(n);
} else {
  console.error("Usage: tsx scripts/seed-eval-set.ts (--from-corrections | --sample N)");
  process.exit(1);
}
