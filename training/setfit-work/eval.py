"""
Evaluate trained SetFit model on full corpus (held-out + train).
Compares against the same gates we tested earlier (regex / domain / kNN).
"""
from __future__ import annotations
import re
import sqlite3
from pathlib import Path

from setfit import SetFitModel

ROOT = Path(__file__).resolve().parents[2]
DB_PATH = ROOT / "data.db"
MODEL_DIR = Path(__file__).parent / "out" / "sentence-transformer"
MAX_BODY_CHARS = 1500

ANCHOR_RE = re.compile(
    r"\b(thank you for (applying|your application)"
    r"|we['' ]?ve? received your application"
    r"|application (received|confirmed|submitted|complete)"
    r"|you['' ]?ve? (successfully )?applied to"
    r"|your .{1,40} application"
    r"|verify your email"
    r"|application for .{1,80} (at|to|with))\b",
    re.IGNORECASE,
)


def load_corpus():
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    rows = con.execute("""
        SELECT e.id, e.from_name, e.from_email, e.subject,
               COALESCE(e.body, e.snippet, '') AS body,
               e.category_id,
               EXISTS(SELECT 1 FROM job_emails je WHERE je.email_id = e.id) AS in_jobs,
               EXISTS(SELECT 1 FROM work_labels wl WHERE wl.email_id = e.id AND wl.label = 1) AS lbl_pos,
               EXISTS(SELECT 1 FROM work_labels wl WHERE wl.email_id = e.id AND wl.label = 0) AS lbl_neg
        FROM emails e
        WHERE e.embedding IS NOT NULL AND COALESCE(e.body, e.snippet, '') != ''
    """).fetchall()
    con.close()
    return rows


def build_text(r):
    return (r["subject"] or "")[:200] + "\n" + (r["body"] or "")[:MAX_BODY_CHARS]


def main():
    print(f"Loading encoder from {MODEL_DIR}...")
    import json
    head_data = json.loads((MODEL_DIR.parent / "head.json").read_text())
    from sentence_transformers import SentenceTransformer
    encoder = SentenceTransformer(str(MODEL_DIR))

    import numpy as np
    coef = np.array(head_data["coef"], dtype=np.float32)        # shape (1, dim) for binary
    intercept = np.array(head_data["intercept"], dtype=np.float32)
    classes = head_data["classes"]
    print(f"Encoder loaded. Head: coef.shape={coef.shape}, classes={classes}")

    rows = load_corpus()
    print(f"Total emails to score: {len(rows)}\n")

    # Encode in batches
    texts = [build_text(r) for r in rows]
    print("Encoding...")
    embs = encoder.encode(texts, batch_size=32, show_progress_bar=False, convert_to_numpy=True)
    print(f"Embeddings shape: {embs.shape}")

    # Apply LR head: P(class=1) = sigmoid(emb @ coef^T + intercept)
    # For binary, sklearn LR has coef shape (1, dim) and intercept shape (1,)
    z = embs @ coef.T + intercept     # shape (N, 1)
    p = 1.0 / (1.0 + np.exp(-z.flatten()))

    # Build pos/neg sets
    pos_ids = set(r["id"] for r in rows if r["in_jobs"] or r["lbl_pos"])
    neg_ids = set(r["id"] for r in rows
                  if (r["category_id"] in ("cat_junk", "cat_news") or r["lbl_neg"])
                  and r["id"] not in pos_ids)

    print(f"Positive set: {len(pos_ids)}")
    print(f"Negative set: {len(neg_ids)}\n")

    # Confusion matrix at threshold 0.5
    print("=== SetFit @ θ=0.5 ===")
    tp = fp = fn = tn = 0
    for r, prob in zip(rows, p):
        flag = prob >= 0.5
        if r["id"] in pos_ids:
            if flag: tp += 1
            else: fn += 1
        elif r["id"] in neg_ids:
            if flag: fp += 1
            else: tn += 1
    P = tp + fn
    N = fp + tn
    print(f"TPR={100*tp/P:.1f}% ({tp}/{P})  FPR={100*fp/N:.1f}% ({fp}/{N})  prec={100*tp/(tp+fp):.1f}%")

    # Also test against the in-database P from old work-classifier
    print("\n=== threshold sweep ===")
    for th in [0.30, 0.40, 0.50, 0.60, 0.70, 0.80, 0.90]:
        tp = fp = 0
        for r, prob in zip(rows, p):
            flag = prob >= th
            if r["id"] in pos_ids and flag: tp += 1
            elif r["id"] in neg_ids and flag: fp += 1
        print(f"θ={th:.2f}  TP={tp}/{P}  FP={fp}/{N}")

    # Show top FPs (negatives ranked highest by SetFit)
    print("\n=== TOP 10 FALSE POSITIVES (negatives with highest P) ===")
    fp_sorted = sorted(
        [(p[i], rows[i]) for i in range(len(rows)) if rows[i]["id"] in neg_ids],
        key=lambda x: -x[0]
    )[:10]
    for prob, r in fp_sorted:
        print(f"  P={prob:.3f}  {r['from_name'][:30]:32s}  {(r['subject'] or '')[:60]}")

    # Show top FNs (positives with lowest P)
    print("\n=== TOP 10 FALSE NEGATIVES (positives with lowest P) ===")
    fn_sorted = sorted(
        [(p[i], rows[i]) for i in range(len(rows)) if rows[i]["id"] in pos_ids],
        key=lambda x: x[0]
    )[:10]
    for prob, r in fn_sorted:
        print(f"  P={prob:.3f}  {r['from_name'][:30]:32s}  {(r['subject'] or '')[:60]}")


if __name__ == "__main__":
    main()
