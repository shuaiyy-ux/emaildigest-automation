"""
Train a SetFit work-classifier from work_labels in data.db.

Output: ./out/sentence-transformer/   (HF format, then converted to ONNX next step)

Usage:
    cd training/setfit-work
    source .venv/bin/activate
    python train.py
"""
from __future__ import annotations
import os
import sqlite3
from pathlib import Path

from datasets import Dataset
from setfit import SetFitModel, Trainer, TrainingArguments

ROOT = Path(__file__).resolve().parents[2]
DB_PATH = ROOT / "data.db"
OUT_DIR = Path(__file__).parent / "out" / "sentence-transformer"
BASE_MODEL = "sentence-transformers/all-MiniLM-L6-v2"
MAX_BODY_CHARS = 1500


def load_labeled_emails() -> list[tuple[str, int]]:
    """Returns list of (text, label) where text = subject + body excerpt."""
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    rows = con.execute("""
        SELECT e.subject, COALESCE(e.body, e.snippet, '') AS body, wl.label
        FROM work_labels wl JOIN emails e ON e.id = wl.email_id
        WHERE COALESCE(e.body, e.snippet, '') != ''
    """).fetchall()
    con.close()
    samples = []
    for r in rows:
        text = (r["subject"] or "")[:200] + "\n" + (r["body"] or "")[:MAX_BODY_CHARS]
        samples.append((text, int(r["label"])))
    return samples


def main():
    samples = load_labeled_emails()
    pos = sum(1 for _, lbl in samples if lbl == 1)
    neg = len(samples) - pos
    print(f"Loaded {len(samples)} samples ({pos} pos / {neg} neg) from {DB_PATH}")

    if pos < 4 or neg < 4:
        raise SystemExit("Need at least 4 pos and 4 neg to train SetFit pairs.")

    ds = Dataset.from_dict({
        "text":  [t for t, _ in samples],
        "label": [l for _, l in samples],
    })
    # SetFit will sample contrastive pairs internally — just give it the full set.
    train_ds = ds.shuffle(seed=42)

    model = SetFitModel.from_pretrained(BASE_MODEL)

    args = TrainingArguments(
        batch_size=16,
        num_epochs=1,
        num_iterations=20,    # contrastive pair sampling per epoch
        body_learning_rate=2e-5,
        head_learning_rate=1e-2,
        end_to_end=False,     # only fine-tune body; head is LR
        seed=42,
        eval_strategy="no",
    )

    trainer = Trainer(
        model=model,
        args=args,
        train_dataset=train_ds,
    )
    print("Training (contrastive fine-tune of MiniLM body)...")
    trainer.train()

    # Quick sanity eval on training set
    correct = 0
    for text, lbl in samples:
        pred = model.predict([text])[0]
        if int(pred) == lbl:
            correct += 1
    print(f"Train acc: {correct}/{len(samples)} = {100*correct/len(samples):.1f}%")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    # Save the underlying sentence-transformer body (the encoder)
    model.model_body.save(str(OUT_DIR))
    # Also dump the head separately so JS can load LR weights
    head_path = OUT_DIR.parent / "head.json"
    import json
    coef = model.model_head.coef_.tolist()
    intercept = model.model_head.intercept_.tolist()
    head_path.write_text(json.dumps({
        "coef": coef,
        "intercept": intercept,
        "classes": model.model_head.classes_.tolist(),
    }))
    print(f"Saved encoder → {OUT_DIR}")
    print(f"Saved head → {head_path}")


if __name__ == "__main__":
    main()
