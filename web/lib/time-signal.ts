/**
 * event_extractor gate: "is there enough signal to make an LLM extraction call worth it?"
 *
 * Called before spawning the event-extractor LLM subprocess. Returning false
 * means the email is unlikely to contain a real scheduled event — the LLM
 * call would burn tokens for an empty `[]` reply.
 *
 * Design: require at least 2 of {date, time, event-keyword}, and reject
 * subjects that match a high-precision FP blacklist (Canvas grading
 * notifications, payment receipts, etc).
 *
 * History note: an earlier version was `hasDate OR hasTime` only — a single
 * date/time pattern anywhere passed the gate. Local validation (84-email
 * dev set) showed 49% filter rate, but PROD reality showed ~100% pass rate
 * with ~100% empty LLM replies. Marketing emails, billing statements,
 * Canvas notifications, and forwarded reply quotes all contain dates but
 * never schedule a future event. The 2-of-3 rule + subject blacklist
 * brings local pass rate from 47.5% → 32.5% with 17/17 recall preserved.
 *
 * Earlier comment said "Do NOT add semantic keywords as fallback" — that
 * referred to keyword as OR (extra admittance path). Here keywords are an
 * AND constraint (additional required signal), the inverse operation.
 */
import {
  TIME_RE,
  EXPLICIT_DATE_RE,
  MONTH_DAY_RE,
  CHINESE_DATE_RE,
} from "./time-patterns";

export interface TimeSignalCtx {
  subject: string;
  body: string;
}

// Words that strongly co-occur with real scheduled events. Bare "due" / "by"
// / "ends" are intentionally NOT here — they re-introduce false positives
// from receipts and marketing. Multi-word patterns (`due 4/29`, `apply by`)
// are precise enough to admit.
const EVENT_CONTEXT_RE =
  /\b(meeting|interview|appointment|conference|lecture|seminar|workshop|exam|quiz|midterm|finals?|office\s+hours?|class\s+(meets|moved|cancel)|RSVP|register\s+(by|for)|deadline|reminder|invitation|invited|invites?\s+you|scheduled\s+(for|on|at|to)|appointment\s+(with|on|at)|expires?\s+(today|tomorrow|at|by|on)|due\s+(date|by|on|tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d)|submit\s+by|apply\s+by|demo|demos|demonstration|presentation|panel|info\s+session|info\s+talk|orientation|onboarding\s+session|intro\s+session|brown\s+bag|happy\s+hour|career\s+fair|hackathon|talk\s+by|guest\s+lecture|webinar|town\s+hall)\b|(面试|会议|讲座|预约|截止|考试|答辩|面谈|提交|报名|演示|发布会|路演)/i;

// Subject patterns that are 100% past-tense receipts or notification batches.
// Conservative on purpose: false rejection is the hard constraint. Keep
// "Statement for X" OUT of this list — bills sometimes carry a "payment due
// on" date in body that LLM legitimately extracts.
const SUBJECT_FP_BLACKLIST_RE =
  /^(Submission Posted|Assignment Graded|Recent .*Notifications?|Bill Tracker (Update)?|Apple Services:|Order Confirmation|Shipping Confirmation|Tracking (Number|Information)|Your receipt|Payment (received|confirmation|posted))/i;

export function hasTimeSignal(email: TimeSignalCtx): boolean {
  const subj = email.subject || "";
  if (SUBJECT_FP_BLACKLIST_RE.test(subj)) return false;

  const text = subj + "\n" + (email.body || "").slice(0, 2000);
  const hasTime = TIME_RE.test(text);
  const hasDate =
    EXPLICIT_DATE_RE.test(text) ||
    MONTH_DAY_RE.test(text) ||
    CHINESE_DATE_RE.test(text);
  const hasKeyword = EVENT_CONTEXT_RE.test(text);
  // Need at least 2 of 3 signals.
  const score = (hasTime ? 1 : 0) + (hasDate ? 1 : 0) + (hasKeyword ? 1 : 0);
  return score >= 2;
}
