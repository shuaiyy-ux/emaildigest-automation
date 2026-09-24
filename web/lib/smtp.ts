import nodemailer from "nodemailer";
import { randomBytes } from "crypto";
import { isDemoMode } from "./demo";
import { log } from "./logger";

const FROM_ADDRESS = process.env.GMAIL_FROM_ADDRESS || process.env.GMAIL_USER || "";
const APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const SIGNATURE = process.env.GMAIL_SIGNATURE || "";

/** DEMO_MODE counts as configured: sends are simulated (see sendEmail). */
export function isSmtpConfigured(): boolean {
  return isDemoMode() || (!!APP_PASSWORD && !!FROM_ADDRESS);
}

export function getSignature(): string {
  return SIGNATURE;
}

let transporterCache: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter {
  if (!APP_PASSWORD) {
    throw new Error("GMAIL_APP_PASSWORD not set. Generate at https://myaccount.google.com/apppasswords and add to .env.local");
  }
  if (transporterCache) return transporterCache;
  transporterCache = nodemailer.createTransport({
    service: "gmail",
    auth: { user: FROM_ADDRESS, pass: APP_PASSWORD },
  });
  return transporterCache;
}

export interface Attachment {
  filename: string;
  path: string;
}

export interface SendResult {
  messageId: string;
  accepted: string[];
  rejected: string[];
}

export async function sendEmail(opts: {
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body: string;
  attachments?: Attachment[];
  inReplyTo?: string;
  includeSignature?: boolean;
}): Promise<SendResult> {
  // DEMO_MODE: nothing leaves the machine. Return a fake message id so the
  // draft is marked sent as usual; the content goes to the app log.
  if (isDemoMode()) {
    const messageId = `<demo-${randomBytes(8).toString("hex")}@example.com>`;
    log.info("demo", "simulated send", {
      messageId, to: opts.to, cc: opts.cc || "", bcc: opts.bcc || "", subject: opts.subject,
      body: opts.body.slice(0, 2000), attachments: (opts.attachments || []).map((a) => a.filename),
    });
    const accepted = [opts.to, opts.cc, opts.bcc]
      .filter((v): v is string => !!v)
      .flatMap((v) => v.split(",").map((x) => x.trim()).filter(Boolean));
    return { messageId, accepted, rejected: [] };
  }
  const transporter = getTransporter();
  const bodyWithSig = opts.includeSignature && SIGNATURE
    ? `${opts.body}\n\n--\n${SIGNATURE}`
    : opts.body;
  const subject = opts.subject;
  const info = await transporter.sendMail({
    from: FROM_ADDRESS,
    to: opts.to,
    cc: opts.cc || undefined,
    bcc: opts.bcc || undefined,
    subject,
    text: bodyWithSig,
    attachments: opts.attachments,
    inReplyTo: opts.inReplyTo,
    references: opts.inReplyTo,
  });
  return {
    messageId: info.messageId,
    accepted: (info.accepted as string[]) || [],
    rejected: (info.rejected as string[]) || [],
  };
}
