/**
 * Parse a plain-text email body into structured sections for rich rendering:
 *   - Main paragraphs (URL-defense unwrapped, CIDs stripped, URLs linkified)
 *   - Extracted calls-to-action (booking links, meeting joins)
 *   - Collapsible signature block
 *   - Collapsible legal/confidentiality disclaimer
 *
 * Conservative heuristics: when something can't be confidently identified it stays
 * in the main body.
 */

// Proofpoint URL defense:
//   https://urldefense.com/v3/__<REAL_URL>__;<BASE64>!<RAND>$
const URL_DEFENSE_RE = /https?:\/\/urldefense\.(?:com|us|proofpoint\.com)\/v\d+\/__([\s\S]+?)__;[^\s$]*\$/g;

// Inline HTML image refs that leaked into plain text (e.g. "[cid:xxx]" from Outlook).
const CID_RE = /\[cid:[^\]]+\]/g;

// Image/link URL placeholders that mailparser injects when converting HTML → text.
// e.g. "[https://example.com/image.png]" becomes orphan noise in plain text.
const BRACKETED_URL_RE = /\s?\[https?:\/\/[^\]\s]+\]\s?/g;

// Mailchimp merge tags that weren't expanded (appear as raw "*|TAG|*" in plaintext fallback).
const MAILCHIMP_MERGE_RE = /\*\|[A-Z_:|]+\|\*/g;

// "[QR Code Image]", "[Logo]", "[Image: product photo]" etc. — mailparser emits these
// when an HTML <img> tag is inlined without a URL (data: URIs, CID refs that already
// got stripped, etc). Keeping them adds nothing for the reader.
const IMG_ALT_RE = /\s?\[(?:image|img|logo|icon|photo|picture|qr\s*code(?:\s*image)?|banner|barcode)(?:\s*[:-]?\s*[^\]]{0,80})?\]\s?/gi;

// "[Link Text] followed by raw URL" — common when HTML text with href was stripped.
// Replace "[Facebook]https://..." with just "[Facebook]".
const LINK_LABEL_URL_RE = /(\[[^\]]{1,40}\])(?:https?|mailto):[^\s\]]+/g;

// "<mailto:foo@bar>" — unwrap to just "foo@bar"
const ANGLE_MAILTO_RE = /<mailto:([^>\s]+)>/g;

// "foo@bar.com<mailto:foo@bar.com>" — common mailparser output for HTML mailto anchors
// where link text equals the address. Keep only one copy.
const DUPLICATE_MAILTO_RE = /\b([\w.+-]+@[\w.-]+\.\w{2,})<mailto:\1>/g;

// Email clients often wrap URLs in < >. Strip those for cleaner linkify.
const ANGLE_URL_RE = /<(https?:\/\/[^>\s]+)>/g;

// Canvas / many SaaS systems wrap bare-domain URLs in angle brackets without a scheme,
// e.g. "<canvas.eee.uci.edu/profile/communication>". Stripping these naively causes
// concatenation with the preceding label ("settings<canvas…>" → "settingscanvas…"),
// so the replacement pads with a leading space.
const ANGLE_BARE_URL_RE = /<([a-z0-9][a-z0-9.-]*\.[a-z]{2,}(?:\/[^>\s]*)?)>/gi;

// Detect "ALL CAPS HEADING" runs (≥ 2 words, ≥ 4 chars each, mostly uppercase).
// Used to insert paragraph breaks when plaintext has lost its newlines.
const HEADING_RE = /\s{2,}([A-Z][A-Z0-9'’\s,&-]{6,80}[A-Z0-9'’])(?=\s)/g;

// Plain URLs (used in linkify).
const URL_RE = /(https?:\/\/[^\s<>"']+)/g;

// Signature delimiters (RFC 3676-ish plus common mobile sigs).
const SIG_DELIMITERS: RegExp[] = [
  /^\s*--\s*$/,
  /^\s*—\s*$/,
  /^Sent from my (iPhone|iPad|Android|Samsung|Galaxy|device)/i,
  /^Get Outlook for (iOS|Android)/i,
  /^Sent via (Superhuman|Spark|Front|Hey)/i,
];

// Disclaimer openers we can detect with high precision.
const DISCLAIMER_MARKERS: RegExp[] = [
  /This (?:message|e-?mail|communication|transmission)(?:\s+\(including any attachments?\))?\s+(?:is|may be|contains|and any attachments)/i,
  /If you (?:are not|have received|are not the) the intended recipient/i,
  /\bCONFIDENTIAL(?:ITY)?\s+NOTICE\b/i,
  /This (?:email|e-mail|message) (?:is|and any)\s*(?:confidential|privileged)/i,
  /^Disclaimer:\s/im,
  /strictly prohibited.{0,200}(intended recipient|confidential)/i,
];

// Recognised CTA / meeting-link platforms.
const CTA_PLATFORMS: Array<{ label: string; urlRe: RegExp }> = [
  { label: "Book a meeting",         urlRe: /https?:\/\/outlook\.office(?:365)?\.com\/bookwithme\/[^\s)>"']+/g },
  { label: "Schedule on Calendly",   urlRe: /https?:\/\/calendly\.com\/[^\s)>"']+/g },
  { label: "Join Zoom meeting",      urlRe: /https?:\/\/(?:[\w-]+\.)?zoom\.us\/j\/[^\s)>"']+/g },
  { label: "Join Google Meet",       urlRe: /https?:\/\/meet\.google\.com\/[a-z0-9-]+(?:[^\s)>"']*)/g },
  { label: "Join Microsoft Teams",   urlRe: /https?:\/\/teams\.microsoft\.com\/l\/meetup-join[^\s)>"']+/g },
  { label: "Open Notion page",       urlRe: /https?:\/\/(?:www\.)?notion\.so\/[^\s)>"']+/g },
];

export interface InlineText { type: "text"; content: string; }
export interface InlineLink { type: "link"; href: string; label: string; }
export type InlinePart = InlineText | InlineLink;

export interface Paragraph { parts: InlinePart[]; }

export interface CallToAction {
  label: string;
  url: string;
}

export interface ParsedEmailBody {
  paragraphs: Paragraph[];
  ctas: CallToAction[];
  signature: string | null;
  disclaimer: string | null;
}

/**
 * Cleanup for short text snippets shown in the email list.
 * Runs the same URL-defense unwrap / CID strip / bracketed-URL / mailchimp merge-tag
 * cleanup as parseEmailBody's first pass, but returns a single-line string.
 *
 * The stored `snippet` comes from mailparser's text conversion, which often contains
 * `[https://host/img.png]` placeholders, `*|MERGE|*` tags, `<mailto:foo>` wraps, etc.
 * Cleaning in the DB would require reprocessing all rows; doing it at render is cheap
 * and safe (snippets are short).
 */
export function cleanSnippet(raw: string): string {
  if (!raw) return "";
  let s = raw;
  s = s.replace(URL_DEFENSE_RE, (_m, real) => real);
  s = s.replace(MAILCHIMP_MERGE_RE, "");
  s = s.replace(LINK_LABEL_URL_RE, "$1");
  s = s.replace(BRACKETED_URL_RE, " ");
  s = s.replace(IMG_ALT_RE, " ");
  s = s.replace(CID_RE, "");
  s = s.replace(DUPLICATE_MAILTO_RE, "$1");
  s = s.replace(ANGLE_MAILTO_RE, " $1 ");
  s = s.replace(ANGLE_URL_RE, (_m, url) => ` ${url} `);
  s = s.replace(ANGLE_BARE_URL_RE, " $1 ");
  // Snippets are often truncated mid-URL — e.g. "[https://foo.com/abcd-ef" with no
  // closing ]. The closed-bracket regex above won't catch it, so strip any trailing
  // open-bracket-URL fragment too. Same for angle-bracket variants.
  s = s.replace(/\s?[\[<]https?:\/?\/?\S*$/, "");
  s = s.replace(/\s?<[a-z0-9][a-z0-9.-]*\.[a-z]{2,}\S*$/i, "");
  // Also any trailing raw URL fragment (after stripping the bracket) that ends the string.
  s = s.replace(/\bhttps?:\/\/\S+$/, "");
  // Collapse all whitespace (including newlines) into single spaces for list display.
  s = s.replace(/\s+/g, " ").trim();
  // Drop leading punctuation/asterisks left over from stripped markdown bullets.
  s = s.replace(/^[\s*•·\-–—>]+/, "").trim();
  return s;
}

export function parseEmailBody(raw: string): ParsedEmailBody {
  // 1. Unwrap URL defense / strip CIDs / strip HTML-→-text image placeholders /
  //    unwrap <URL> brackets. Order matters: URL-defense first so stripped URLs
  //    don't leave half-brackets; bracketed-URL next to remove noise; angle
  //    brackets last.
  let body = raw;
  body = body.replace(URL_DEFENSE_RE, (_m, real) => real);
  body = body.replace(MAILCHIMP_MERGE_RE, "");            // strip *|MERGE|*
  body = body.replace(LINK_LABEL_URL_RE, "$1");          // drop raw URL after [Label]
  body = body.replace(BRACKETED_URL_RE, " ");            // drop [https://…] placeholders
  body = body.replace(IMG_ALT_RE, " ");                  // drop [QR Code Image], [Logo], etc.
  body = body.replace(CID_RE, "");
  body = body.replace(DUPLICATE_MAILTO_RE, "$1");        // "foo@bar<mailto:foo@bar>" → "foo@bar"
  body = body.replace(ANGLE_MAILTO_RE, " $1 ");          // unwrap <mailto:...> with padding
  // "View Profile<https://...>" — mailparser outputs label+link directly adjacent.
  // Unwrap with space padding so label doesn't concat with URL in the rendered output.
  body = body.replace(ANGLE_URL_RE, (_m, url) => ` ${url} `);
  // "settings<canvas.eee.uci.edu/...>" — same issue for bare-domain angle URLs.
  body = body.replace(ANGLE_BARE_URL_RE, " $1 ");

  // Collapse the whitespace damage the above replacements cause.
  body = body.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n");

  // If the text has no newlines (common after HTML→text stripping), infer
  // paragraph breaks from ALL-CAPS heading runs. Non-destructive: we only insert
  // "\n\n" before and after the heading, leaving content intact.
  const hasNewlines = /\n/.test(body);
  if (!hasNewlines) {
    body = body.replace(HEADING_RE, (_m, heading) => `\n\n${heading}\n\n`);
    // Also split on sentence-terminal + capital-start heuristic for very long runs
    if (body.length > 400 && !/\n\n/.test(body)) {
      body = body.replace(/([.!?])\s+(?=[A-Z])/g, "$1\n\n");
    }
  }

  // 2. Slice off disclaimer (from first marker to end). Round back to paragraph boundary.
  let disclaimer: string | null = null;
  let disclaimerStart = -1;
  for (const marker of DISCLAIMER_MARKERS) {
    const match = body.match(marker);
    if (match && match.index != null) {
      if (disclaimerStart < 0 || match.index < disclaimerStart) disclaimerStart = match.index;
    }
  }
  if (disclaimerStart > 0) {
    const prevBreak = body.lastIndexOf("\n\n", disclaimerStart);
    const cut = prevBreak > 0 ? prevBreak : disclaimerStart;
    disclaimer = body.slice(cut).trim();
    body = body.slice(0, cut).trim();
  }

  // 3. Slice off signature. Try delimiter first, then heuristic.
  let signature: string | null = null;
  const lines = body.split("\n");

  let sigStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (SIG_DELIMITERS.some((re) => re.test(lines[i]))) { sigStart = i; break; }
  }

  if (sigStart < 0 && lines.length > 6) {
    // Heuristic: search the last 20 lines for a block with (phone OR email) + short lines
    const searchFrom = Math.max(0, lines.length - 20);
    for (let i = searchFrom; i < lines.length - 1; i++) {
      const block = lines.slice(i, Math.min(i + 10, lines.length)).join("\n");
      const hasPhone = /\b(?:\+?\d{1,2}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/.test(block);
      const hasEmail = /\b[\w.+-]+@[\w.-]+\.\w{2,}\b/.test(block);
      const shortLines = lines
        .slice(i, Math.min(i + 10, lines.length))
        .every((l) => l.length === 0 || l.length <= 80);
      if ((hasPhone || hasEmail) && shortLines) {
        // Look for a blank line just above i as a cleaner cut point
        let cut = i;
        for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
          if (lines[j].trim() === "") { cut = j + 1; break; }
        }
        sigStart = cut;
        break;
      }
    }
  }

  if (sigStart >= 0) {
    signature = lines.slice(sigStart).join("\n").trim();
    body = lines.slice(0, sigStart).join("\n").trim();
  }

  // 4. Extract CTAs from remaining body
  const ctas: CallToAction[] = [];
  const seen = new Set<string>();
  for (const platform of CTA_PLATFORMS) {
    const matches = body.matchAll(platform.urlRe);
    for (const m of matches) {
      const url = m[0].replace(/[.,!?)]+$/, "");
      if (seen.has(url)) continue;
      seen.add(url);
      ctas.push({ label: platform.label, url });
    }
  }

  // 5. Split paragraphs and linkify
  const paragraphs = splitParagraphs(body);

  return { paragraphs, ctas, signature, disclaimer };
}

function splitParagraphs(text: string): Paragraph[] {
  if (!text.trim()) return [];
  const chunks = text
    .split(/\n\s*\n+/)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
  return chunks.map((c) => ({ parts: linkify(c) }));
}

function linkify(text: string): InlinePart[] {
  const parts: InlinePart[] = [];
  let lastIndex = 0;
  URL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = URL_RE.exec(text)) !== null) {
    const start = match.index;
    if (start > lastIndex) parts.push({ type: "text", content: text.slice(lastIndex, start) });
    const url = match[0].replace(/[.,!?)]+$/, "");
    let label = url;
    try {
      const u = new URL(url);
      label = u.hostname.replace(/^www\./, "") + (u.pathname !== "/" ? u.pathname.slice(0, 30) : "");
    } catch { /* keep full URL */ }
    parts.push({ type: "link", href: url, label });
    lastIndex = start + url.length;
  }
  if (lastIndex < text.length) parts.push({ type: "text", content: text.slice(lastIndex) });
  return parts.length ? parts : [{ type: "text", content: text }];
}
