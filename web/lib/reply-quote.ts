/**
 * Strip inline quoted-reply history from an email body.
 *
 * Why this exists: `simpleParser(msg.source).text` only unwraps the outermost
 * MIME envelope. It does NOT remove the quoted previous-turn content that
 * email clients inline into a reply. For a 5-email back-and-forth, the body
 * of reply #5 typically looks like:
 *
 *     Thanks, looks good.
 *
 *     From: <prof>
 *     Sent: Monday...
 *     Subject: RE: ...
 *
 *     Please find attached...
 *     ________________________________
 *     From: <student>
 *     Sent: ...
 *     > On Apr 18, ... wrote:
 *     > original question
 *
 * Only the first line ("Thanks, looks good.") is genuinely new content —
 * the rest is history the sender's client appended. Any LLM reading the full
 * body gets ~96% noise and will happily paraphrase old content as if it were
 * new. This function cuts everything from the first quote-marker onward.
 *
 * Patterns handled (validated on /tmp/reply-strip-validate.js over real DB
 * corpus: 67.5% average byte reduction on 19 multi-turn thread emails, 0/20
 * over-strips on solo emails):
 *
 *   P1. "On <date>, <name> wrote:"  or  "在 <日期>, <人> 写道："
 *       — Gmail / Apple Mail / many mobile clients. Cut from marker to EOF.
 *       Cap 200 chars between "On" and "wrote:" because name + email +
 *       mailto URL easily exceeds 100 chars.
 *
 *   P2. A line of 10+ underscores by itself — Outlook web/desktop separator
 *       before the quoted block. Cut from the separator to EOF.
 *
 *   P3. Inline "From: ... \n Sent|Date: ..." header block (some Outlook
 *       rewrites drop the underscore line). Require From: followed within
 *       5 lines by Sent: or Date: to avoid eating a genuine "From: John"
 *       in the real body text. Cut from From: line to EOF.
 *
 *   P4. A late-appearing "Subject: " line (after line 3) — occurs when the
 *       client stripped From/Sent but left a bare Subject marker. Cut from
 *       that line to EOF. Skip the first three lines so a first-line
 *       "Subject-like" greeting isn't nuked.
 *
 *   P5. Plaintext `>` / `>>` quote block (Gmail plaintext mode, Apple Mail
 *       quote style). Cut from first line of the block to EOF. Require at
 *       least 2 consecutive quoted lines so a one-off `>` character in prose
 *       doesn't trigger.
 *
 * Safety valve: if the strip kills >90% of bytes AND leaves <40 chars, the
 * original body is returned. The 20-sample solo-email test had 0 hits on
 * this valve; it exists to survive a future parser that produces unexpected
 * output rather than silently emit a near-empty body.
 *
 * Not in scope: HTML cleanup (`sanitizeHTML`), AI-generated prefix/suffix
 * cleanup (`stripLLMContamination`). These are separate concerns and can
 * be composed: `stripLLMContamination(stripQuotedReply(body))`.
 *
 * Designed for reuse. Currently wired into daily-digest; event-extractor /
 * jobs-pipeline / embedder / chunker / work-corpus labeling all suffer from
 * the same contamination and can import this function when those paths are
 * tackled.
 */
export function stripQuotedReply(body: string): string {
  if (!body) return body;
  const original = body;
  let s = body;

  // P1. "On <date>, <name> wrote:" / "在 <日期>, <人> 写道：" — cut to EOF
  const onWrote = s.search(
    /\n\s*On\s+[\s\S]{3,200}?\s+wrote:\s*(\n|$)|\n\s*在\s+[\s\S]{3,200}?写道：\s*(\n|$)/,
  );
  if (onWrote >= 0) s = s.slice(0, onWrote);

  // P2. `_{10,}` separator line (Outlook)
  const sep = s.match(/\n\s*_{10,}\s*\n/);
  if (sep) s = s.slice(0, sep.index);

  // P3. Inline From: ... \n (Sent|Date): ... header block
  const inlineHeader = s.match(
    /\n\s*From:\s+[^\n]{1,200}\n(?:\s*(Sent|Date):[^\n]+\n|[^\n]{0,200}\n){0,4}\s*(Sent|Date):\s+[^\n]+/i,
  );
  if (inlineHeader) s = s.slice(0, inlineHeader.index);

  // P4. Late-appearing `Subject:` line (after line 3)
  const lines = s.split("\n");
  for (let i = 3; i < lines.length; i++) {
    if (/^Subject:\s+/i.test(lines[i].trim())) {
      s = lines.slice(0, i).join("\n");
      break;
    }
  }

  // P5. 2+ consecutive `>` quoted lines
  const quoted = s.search(/\n\s*>\s.{0,500}\n(\s*>\s.{0,500}\n?)+/);
  if (quoted >= 0) s = s.slice(0, quoted);

  s = s.trim();

  // Safety valve: reject catastrophic over-strip
  if (s.length < 40 && s.length < original.length * 0.1) {
    return original;
  }

  return s;
}
