import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmpBase = path.join(os.tmpdir(), `emaildigest-attachment-delete-${Date.now()}`);
process.env.EMAILDIGEST_DIR = tmpBase;

async function safeUnlink(file: string) {
  await fs.unlink(file).catch(() => {});
}

async function fileExists(file: string) {
  await fs.access(file);
}

async function main() {
  await fs.mkdir(tmpBase, { recursive: true });
  const [route, db] = await Promise.all([
    import("../app/api/drafts/[id]/attachments/route"),
    import("../lib/db"),
  ]);

  const { DELETE } = route;
  const { createDraft, addAttachment, getAttachmentById } = db;

  const draftA = createDraft({
    id: "draftA",
    type: "reply",
    to: "a@example.com",
    subject: "draft A",
    body: "body A",
    user: "owner",
  });

  const draftB = createDraft({
    id: "draftB",
    type: "reply",
    to: "b@example.com",
    subject: "draft B",
    body: "body B",
    user: "owner",
  });

  await fs.mkdir(path.join(tmpBase, "attachments"), { recursive: true });
  const attachmentForB = addAttachment(
    draftB.id,
    "victim.txt",
    path.join(tmpBase, "attachments", "victim.txt"),
    4,
    "text/plain",
  );
  await fs.writeFile(attachmentForB.path, "ok!!", "utf8");

  try {
    const urlWrongDraft = new Request(
      `https://test.local/api/drafts/${draftA.id}/attachments?attachmentId=${attachmentForB.id}`,
      { method: "DELETE" },
    );
    const wrongDraftResult = await DELETE(urlWrongDraft, {
      params: Promise.resolve({ id: draftA.id }),
    });
    assert.equal(wrongDraftResult.status, 403);

    const wrongDraftBody = await wrongDraftResult.json() as { error: string };
    assert.equal(wrongDraftBody.error, "Attachment does not belong to this draft");
    await fileExists(attachmentForB.path);
    assert.equal(
      Boolean(getAttachmentById(attachmentForB.id)),
      true,
      "attachment row should remain when deleting from wrong draft",
    );

    const urlMissing = new Request(
      `https://test.local/api/drafts/${draftA.id}/attachments?attachmentId=999999`,
      { method: "DELETE" },
    );
    const missingResult = await DELETE(urlMissing, {
      params: Promise.resolve({ id: draftA.id }),
    });
    assert.equal(missingResult.status, 404);
    const missingBody = await missingResult.json() as { error: string };
    assert.equal(missingBody.error, "Attachment not found");

    const urlRightDraft = new Request(
      `https://test.local/api/drafts/${draftB.id}/attachments?attachmentId=${attachmentForB.id}`,
      { method: "DELETE" },
    );
    const rightDraftResult = await DELETE(urlRightDraft, {
      params: Promise.resolve({ id: draftB.id }),
    });
    assert.equal(rightDraftResult.status, 200);
    const rightDraftBody = await rightDraftResult.json() as { deleted: boolean };
    assert.equal(rightDraftBody.deleted, true);
    assert.equal(getAttachmentById(attachmentForB.id), undefined);
    await assert.rejects(() => fileExists(attachmentForB.path));
  } finally {
    await safeUnlink(attachmentForB.path);
    await fs.rm(tmpBase, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
