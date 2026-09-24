"""
Evaluate trained SetFit 4-way classifier — focus on the right metric:
"how many emails would CONFIDENTLY pass MiniLM-replacement gate at θ?"

Held-out eval: emails that exist in DB but were NOT in the training set
(category_examples table). For PROD-grade signal we'd retrain with K-fold,
but for a smoke test we just see how the model looks on near-OOD samples
plus the training set.

We also report the confidence margin distribution because that's the key
input to threshold tuning. If most predictions land at P_top1 > 0.95 with
big margins, we can push the gate aggressively and skip LLM 90%+ of arrivals.
"""
from __future__ import annotations
import json
import sqlite3
from pathlib import Path

import numpy as np
from sentence_transformers import SentenceTransformer

ROOT = Path(__file__).resolve().parents[2]
DB_PATH = ROOT / "data.db"
OUT_DIR = Path(__file__).parent / "out"
ENC_DIR = OUT_DIR / "sentence-transformer"
MAX_BODY_CHARS = 1500

LABEL_TO_ID = {"cat_primary": 0, "cat_track": 1, "cat_news": 2, "cat_junk": 3}
ID_TO_LABEL = {v: k for k, v in LABEL_TO_ID.items()}
SHORT = {0: "primary", 1: "track", 2: "news", 3: "junk"}


def softmax(z):
    z = z - z.max(axis=1, keepdims=True)
    ez = np.exp(z)
    return ez / ez.sum(axis=1, keepdims=True)


def main():
    head = json.loads((OUT_DIR / "head.json").read_text())
    coef = np.array(head["coef"], dtype=np.float32)              # (n_classes, dim)
    intercept = np.array(head["intercept"], dtype=np.float32)    # (n_classes,)
    classes = head["classes"]
    print(f"Head: coef={coef.shape}  classes={classes}")

    print(f"Loading encoder from {ENC_DIR}...")
    encoder = SentenceTransformer(str(ENC_DIR))

    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    train_ids = {r[0] for r in con.execute(
        "SELECT email_id FROM category_examples WHERE email_id IS NOT NULL"
    )}
    rows = con.execute("""
        SELECT e.id, e.from_name, e.from_email, e.subject,
               COALESCE(e.body, e.snippet, '') AS body, e.category_id
        FROM emails e
        WHERE COALESCE(e.body, e.snippet, '') != ''
          AND e.category_id IN ('cat_primary','cat_track','cat_news','cat_junk')
    """).fetchall()
    con.close()

    in_train = [r for r in rows if r["id"] in train_ids]
    held_out = [r for r in rows if r["id"] not in train_ids]

    print(f"Training set rows: {len(in_train)}")
    print(f"Held-out rows:     {len(held_out)}\n")

    def evaluate(label, group):
        if not group:
            print(f"=== {label}: empty ===\n")
            return
        texts = [(r["subject"] or "")[:200] + "\n" + (r["body"] or "")[:MAX_BODY_CHARS] for r in group]
        embs = encoder.encode(texts, batch_size=32, show_progress_bar=False, convert_to_numpy=True)
        z = embs @ coef.T + intercept                  # (N, n_classes)
        probs = softmax(z)
        preds = probs.argmax(axis=1)
        top1 = probs.max(axis=1)
        # margin = top1 - top2
        sorted_p = np.sort(probs, axis=1)
        margin = sorted_p[:, -1] - sorted_p[:, -2]

        # accuracy
        correct = sum(1 for r, p in zip(group, preds) if LABEL_TO_ID[r["category_id"]] == p)
        print(f"=== {label} (n={len(group)}) ===")
        print(f"Accuracy (vs LLM-labeled category_id): {correct}/{len(group)} = {100*correct/len(group):.1f}%")

        # gate threshold sweep — what fraction would skip LLM?
        print("\nGate threshold sweep (skip-LLM rate at each top1):")
        for th in [0.50, 0.60, 0.70, 0.80, 0.90, 0.95]:
            mask = top1 >= th
            confident_correct = sum(
                1 for i, r in enumerate(group)
                if mask[i] and LABEL_TO_ID[r["category_id"]] == preds[i]
            )
            confident_n = mask.sum()
            err_rate = (confident_n - confident_correct) / max(1, confident_n)
            print(f"  θ={th:.2f}  pass={confident_n}/{len(group)} ({100*confident_n/len(group):.0f}%)  "
                  f"err-on-confident={100*err_rate:.1f}%")

        # margin sweep
        print("\nMargin (top1-top2) percentiles:")
        for q in [10, 25, 50, 75, 90]:
            print(f"  p{q}: {np.percentile(margin, q):.3f}")

        # Per-class confusion (held-out only — training set is biased)
        print("\nConfusion (rows=true, cols=pred):")
        confusion = np.zeros((4, 4), dtype=int)
        for r, p in zip(group, preds):
            confusion[LABEL_TO_ID[r["category_id"]], p] += 1
        print("           " + "  ".join(f"{SHORT[i]:>8s}" for i in range(4)))
        for tr in range(4):
            row = "  ".join(f"{confusion[tr, pr]:>8d}" for pr in range(4))
            print(f"  {SHORT[tr]:8s}   {row}")

        # Show top 8 disagreements
        print("\nTop 8 disagreements (model says X, label says Y):")
        diff = [(i, top1[i]) for i, r in enumerate(group)
                if LABEL_TO_ID[r["category_id"]] != preds[i]]
        diff.sort(key=lambda x: -x[1])
        for i, p in diff[:8]:
            r = group[i]
            print(f"  P={p:.3f}  pred={SHORT[preds[i]]:7s}  true={SHORT[LABEL_TO_ID[r['category_id']]]:7s}  "
                  f"{(r['from_email'] or '')[:30]:30s}  {(r['subject'] or '')[:55]}")
        print()

    evaluate("Held-out (NOT in training set)", held_out)
    evaluate("Training set (overfit-prone)", in_train)


if __name__ == "__main__":
    main()
