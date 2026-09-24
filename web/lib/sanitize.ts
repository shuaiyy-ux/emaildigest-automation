/**
 * Sanitize email content before embedding in LLM prompts.
 * Strips potential prompt injection patterns.
 */
export function sanitizeForPrompt(text: string): string {
  return text
    // Remove instruction-like patterns
    .replace(/ignore\s+(all\s+)?(previous\s+)?instructions/gi, "[REDACTED]")
    .replace(/system\s*prompt/gi, "[REDACTED]")
    .replace(/you\s+are\s+(now\s+)?a/gi, "[REDACTED]")
    // Truncate to prevent token abuse
    .slice(0, 200)
    // Remove control characters
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
}

const AI_PREFIXES = [
  /^邮件正文内容如下[：:]\s*/,
  /^以下是邮件正文[：:]\s*/,
  /^邮件正文[：:]\s*/,
  /^正文如下[：:]\s*/,
  /^正文内容[：:]\s*/,
  /^以下是邮件的正文[：:]\s*/,
];

const AI_SUFFIXES = [
  /\n正文为空[——\-\s].*$/s,
  /\n这封邮件.*$/s,
  /\n该邮件.*$/s,
  /\n这是一封.*$/s,
  /\n注[：:].*$/s,
];

const HEADER_KEYS = ["From:", "Sent:", "To:", "Subject:", "Cc:", "Bcc:", "Date:"];

/**
 * Strip LLM contamination from email body text.
 * Removes: markdown code blocks, AI commentary, email headers injected by LLM.
 */
// Invisible chars used as preheader padding by email marketers
// (combining grapheme joiner, soft hyphen, zero-width, BOM)
const INVISIBLE_CHARS_RE = /[\u034f\u00ad\u200b\u200c\u200d\ufeff]/g;

export function stripLLMContamination(raw: string): string {
  let text = raw;

  // 0. Strip invisible preheader padding chars (CGJ, soft hyphen, ZWSP, etc.)
  text = text.replace(INVISIBLE_CHARS_RE, "");
  // Collapse runs of 3+ blank lines or 5+ spaces (caused by stripped padding)
  text = text.replace(/\n{3,}/g, "\n\n").replace(/ {5,}/g, "  ");

  // 1. Strip AI Chinese prefixes (come before code blocks)
  for (const re of AI_PREFIXES) {
    text = text.replace(re, "");
  }
  text = text.trim();

  // 2. Strip AI Chinese suffixes
  for (const re of AI_SUFFIXES) {
    text = text.replace(re, "");
  }
  text = text.trim();

  // 3. Unwrap markdown code blocks (``` or truncated `` at boundaries)
  text = text.replace(/^```[a-z]*\n?/, "").replace(/\n?`{2,3}\s*$/, "");
  text = text.trim();

  // 4. Strip email header block in the first 10 lines
  const lines = text.split("\n");
  let headerStart = -1;
  let headerEnd = -1;

  for (let i = 0; i < Math.min(lines.length, 10); i++) {
    const line = lines[i].trim();
    if (HEADER_KEYS.some((k) => line.startsWith(k))) {
      if (headerStart === -1) headerStart = i;
      headerEnd = i;
    } else if (headerStart !== -1) {
      // Allow one blank line within header block (between Subject: and body)
      if (line === "" && i === headerEnd + 1) continue;
      break;
    }
  }

  // Only strip if we found at least From: + (Sent: or Date:)
  if (headerStart !== -1 && headerEnd >= headerStart) {
    const block = lines.slice(headerStart, headerEnd + 1);
    const hasFrom = block.some((l) => l.trim().startsWith("From:"));
    const hasSentOrDate = block.some(
      (l) => l.trim().startsWith("Sent:") || l.trim().startsWith("Date:")
    );
    if (hasFrom && hasSentOrDate) {
      // Also remove preceding separator line (________________________________)
      if (headerStart > 0 && /^_{10,}$/.test(lines[headerStart - 1].trim())) {
        headerStart--;
      }
      // Remove header block + first blank line after it
      let removeEnd = headerEnd + 1;
      if (removeEnd < lines.length && lines[removeEnd].trim() === "") removeEnd++;
      lines.splice(headerStart, removeEnd - headerStart);
      text = lines.join("\n");
    }
  }

  text = text.trim();
  return text;
}
