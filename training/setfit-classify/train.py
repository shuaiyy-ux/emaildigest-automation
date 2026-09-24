"""
Train a SetFit 4-way Inbox classifier from category_examples in data.db.

Categories: cat_primary (0), cat_track (1), cat_news (2), cat_junk (3)

Output: ./out/sentence-transformer/ (HF format, ONNX export next)

Usage:
    cd training/setfit-classify
    source ../setfit-work/.venv/bin/activate    # reuse the same venv
    python train.py
"""
from __future__ import annotations
import sqlite3
from pathlib import Path

from datasets import Dataset
from setfit import SetFitModel, Trainer, TrainingArguments

ROOT = Path(__file__).resolve().parents[2]
DB_PATH = ROOT / "data.db"
OUT_DIR = Path(__file__).parent / "out" / "sentence-transformer"
BASE_MODEL = "sentence-transformers/all-MiniLM-L6-v2"
MAX_BODY_CHARS = 1500

LABEL_TO_ID = {
    "cat_primary": 0,
    "cat_track":   1,
    "cat_news":    2,
    "cat_junk":    3,
}
ID_TO_LABEL = {v: k for k, v in LABEL_TO_ID.items()}


def load_labeled_emails() -> list[tuple[str, int]]:
    """
    Returns list of (text, label_id).

    Source filtering: prefer user_correction (highest signal) and llm_high_conf
    (Sonnet's classifier output, ~412 samples). Skip spam_corpus (40 cat_junk
    samples without bodies — they're public dataset rows that don't have the
    same noise profile as real UCI mail).
    """
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    rows = con.execute("""
        SELECT e.subject, COALESCE(e.body, e.snippet, '') AS body, ce.category_id
        FROM category_examples ce
        JOIN emails e ON e.id = ce.email_id
        WHERE COALESCE(e.body, e.snippet, '') != ''
          AND ce.source IN ('user_correction', 'llm_high_conf')
          AND ce.category_id IN ('cat_primary', 'cat_track', 'cat_news', 'cat_junk')
    """).fetchall()
    con.close()
    samples = []
    for r in rows:
        text = (r["subject"] or "")[:200] + "\n" + (r["body"] or "")[:MAX_BODY_CHARS]
        samples.append((text, LABEL_TO_ID[r["category_id"]]))
    return samples


def main():
    samples = load_labeled_emails()
    print(f"Loaded {len(samples)} samples from {DB_PATH}")
    counts = {ID_TO_LABEL[i]: 0 for i in range(4)}
    for _, lbl in samples:
        counts[ID_TO_LABEL[lbl]] += 1
    for cat, n in counts.items():
        print(f"  {cat}: {n}")
    if min(counts.values()) < 8:
        raise SystemExit("Need at least 8 samples per class for stable contrastive training.")

    ds = Dataset.from_dict({
        "text":  [t for t, _ in samples],
        "label": [l for _, l in samples],
    })
    train_ds = ds.shuffle(seed=42)

    model = SetFitModel.from_pretrained(BASE_MODEL)

    # Multi-class: more iterations than binary (4 classes need more pair sampling
    # to cover all class combinations — for 4 classes there are C(4,2)=6 distinct
    # negative pair shapes vs. 1 for binary).
    args = TrainingArguments(
        batch_size=16,
        num_epochs=1,
        num_iterations=40,
        body_learning_rate=2e-5,
        head_learning_rate=1e-2,
        end_to_end=False,
        seed=42,
        eval_strategy="no",
    )
    trainer = Trainer(model=model, args=args, train_dataset=train_ds)
    print("Training (contrastive fine-tune for 4-way classify)...")
    trainer.train()

    # Train accuracy, plus per-class precision/recall (multi-class)
    from collections import Counter
    correct = 0
    confusion: dict[tuple[int, int], int] = Counter()
    for text, lbl in samples:
        pred = int(model.predict([text])[0])
        confusion[(lbl, pred)] += 1
        if pred == lbl:
            correct += 1
    print(f"\nTrain acc: {correct}/{len(samples)} = {100*correct/len(samples):.1f}%")
    print("Confusion (rows=true, cols=pred):")
    print("           " + "  ".join(f"{ID_TO_LABEL[i][4:]:>8s}" for i in range(4)))
    for tr in range(4):
        row = "  ".join(f"{confusion.get((tr, pr), 0):>8d}" for pr in range(4))
        print(f"  {ID_TO_LABEL[tr]:10s} {row}")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    model.model_body.save(str(OUT_DIR))
    head_path = OUT_DIR.parent / "head.json"
    import json
    head_path.write_text(json.dumps({
        "coef":      model.model_head.coef_.tolist(),
        "intercept": model.model_head.intercept_.tolist(),
        "classes":   model.model_head.classes_.tolist(),
        "label_map": ID_TO_LABEL,
    }))
    print(f"\nSaved encoder → {OUT_DIR}")
    print(f"Saved head    → {head_path}")


if __name__ == "__main__":
    main()
