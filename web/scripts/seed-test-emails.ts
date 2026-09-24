/**
 * Seed 32 test emails into the emails table for end-to-end Job pipeline validation.
 *
 *   tsx scripts/seed-test-emails.ts          # insert/update test emails
 *   tsx scripts/seed-test-emails.ts --clean  # remove all test_* rows
 *
 * Test ids are deterministic (test_p_NN for positives, test_n_NN for negatives) so
 * re-running is idempotent. Each fixture also carries an `expected` annotation
 * read by scripts/test-job-pipeline.ts.
 */
import db, { upsertEmails } from "../lib/db";

interface Fixture {
  id: string;
  from: string;
  fromEmail: string;
  subject: string;
  body: string;
  daysAgo: number;
  threadId?: string; // for multi-email applications
  expected: {
    isJob: boolean;
    stage?: string;          // when isJob=true
    needsAction?: boolean;
    company?: string;        // normalized form (for application aggregation check)
    role?: string;
  };
}

// Helper: convert "X days ago" to epoch + a display date string
function dateFor(daysAgo: number): { receivedAt: number; date: string } {
  const epoch = Math.floor(Date.now() / 1000) - daysAgo * 86400;
  const d = new Date(epoch * 1000);
  return {
    receivedAt: epoch,
    date: d.toLocaleString("en-US", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }),
  };
}

const POSITIVES: Fixture[] = [
  // 1. ATS confirmation - Greenhouse
  {
    id: "test_p_01",
    from: "Greenhouse",
    fromEmail: "no-reply@greenhouse-mail.io",
    subject: "Northwind — Application Received: Senior Data Analyst",
    body: `Hi Shuaiyu,\n\nThank you for applying to Northwind! We've received your application for the Senior Data Analyst role and our team will review it shortly.\n\nYou'll hear back within 2 weeks regardless of the outcome.\n\nBest,\nThe Northwind Recruiting Team`,
    daysAgo: 21,
    threadId: "thread_northwind_da",
    expected: { isJob: true, stage: "applied", company: "northwind", role: "data analyst" },
  },
  // 2. ATS confirmation - Lever
  {
    id: "test_p_02",
    from: "Contoso Recruiting",
    fromEmail: "no-reply@hire.lever.co",
    subject: "Your application to Contoso — ML Engineer",
    body: `Hello,\n\nThank you for your interest in the ML Engineer position at Contoso. We've received your application and will be in touch.`,
    daysAgo: 18,
    threadId: "thread_contoso_ml",
    expected: { isJob: true, stage: "applied", company: "contoso", role: "ml engineer" },
  },
  // 3. Personal HR ack (multi-email Northwind DA: 2/3)
  {
    id: "test_p_03",
    from: "Sarah Chen",
    fromEmail: "sarah.chen@northwind.example",
    subject: "Re: Application Received: Senior Data Analyst",
    body: `Hi Shuaiyu,\n\nWanted to personally let you know I got your application. Your background looks like a great match — I'll be in touch this week to set up an initial chat.\n\nThanks,\nSarah\nRecruiter, Northwind Data team`,
    daysAgo: 19,
    threadId: "thread_northwind_da",
    expected: { isJob: true, stage: "received", company: "northwind", role: "data analyst" },
  },
  // 4. HR forwarding
  {
    id: "test_p_04",
    from: "Mike Patel",
    fromEmail: "mike.patel@fabrikam.example",
    subject: "Handing off to Jess on the analytics team",
    body: `Hi Shuaiyu,\n\nThanks again for chatting last week. I'm passing your application along to Jess Kim who manages analytics hiring — she'll be your point of contact going forward. You can expect to hear from her within a few days.\n\nBest of luck!\nMike`,
    daysAgo: 12,
    expected: { isJob: true, stage: "forwarded", company: "fabrikam", role: "" },
  },
  // 5. Interview invite - Globex
  {
    id: "test_p_05",
    from: "Dana Reyes",
    fromEmail: "dana.reyes@globex.example",
    subject: "Globex Capital America — 30-min phone screen",
    body: `Hi Shuaiyu,\n\nWe'd like to invite you to a 30-minute phone screen for the Data Analyst role. Please reply with your availability over the next week.\n\nDana Reyes\nHR, Globex Capital America`,
    daysAgo: 1,
    expected: { isJob: true, stage: "interview_scheduled", needsAction: true, company: "globex", role: "data analyst" },
  },
  // 6. Interview invite - Initech
  {
    id: "test_p_06",
    from: "Initech People",
    fromEmail: "people@initech.example",
    subject: "Interview invite: Initech ML Engineer",
    body: `Hi,\n\nWe'd love to schedule a 45-min technical chat for the ML Engineer role. Are you available next Tue or Wed afternoon PT?\n\nInitech People team`,
    daysAgo: 5,
    threadId: "thread_initech_ml",
    expected: { isJob: true, stage: "interview_scheduled", needsAction: true, company: "initech", role: "ml engineer" },
  },
  // 7. Calendar invite confirm (Northwind DA 3/3)
  {
    id: "test_p_07",
    from: "Northwind Scheduling",
    fromEmail: "scheduling@greenhouse.io",
    subject: "Confirmed: Northwind Data Analyst Interview Tue 3:00 PM PT",
    body: `Your interview is confirmed for Tuesday at 3:00 PM PT (45 minutes, Zoom). Calendar invite attached.\n\nInterviewer: Sarah Chen\nRole: Senior Data Analyst`,
    daysAgo: 7,
    threadId: "thread_northwind_da",
    expected: { isJob: true, stage: "interview_scheduled", company: "northwind", role: "data analyst" },
  },
  // 8. Coding challenge with deadline
  {
    id: "test_p_08",
    from: "HackerRank",
    fromEmail: "noreply@hackerrank.com",
    subject: "Contoso — Your coding assessment is ready",
    body: `Contoso has invited you to complete a coding assessment for the ML Engineer role. The link expires on Friday at 11:59 PM PT.\n\nEstimated time: 90 minutes.`,
    daysAgo: 3,
    threadId: "thread_contoso_ml",
    expected: { isJob: true, stage: "interview_scheduled", needsAction: true, company: "contoso", role: "ml engineer" },
  },
  // 9. Take-home project
  {
    id: "test_p_09",
    from: "Initech Engineering",
    fromEmail: "engineering@initech.example",
    subject: "Take-home assignment: Initech ML Engineer",
    body: `Hi,\n\nPlease find your take-home assignment attached. It should take 4-6 hours. Submit by end of day this Friday.\n\nInitech Engineering`,
    daysAgo: 4,
    threadId: "thread_initech_ml",
    expected: { isJob: true, stage: "interview_scheduled", needsAction: true, company: "initech", role: "ml engineer" },
  },
  // 10. Post-interview thank-you
  {
    id: "test_p_10",
    from: "Sarah Chen",
    fromEmail: "sarah.chen@northwind.example",
    subject: "Re: Northwind Data Analyst Interview — thanks for chatting",
    body: `Hi Shuaiyu,\n\nThanks again for chatting today. I really enjoyed learning about your work on supply chain forecasting. Next steps: we'll discuss internally and follow up by end of next week.`,
    daysAgo: 6,
    threadId: "thread_northwind_da",
    expected: { isJob: true, stage: "interviewed", company: "northwind", role: "data analyst" },
  },
  // 11. Reference request
  {
    id: "test_p_11",
    from: "Contoso People Ops",
    fromEmail: "people-ops@contoso.example",
    subject: "Could you send 3 professional references?",
    body: `Hi Shuaiyu,\n\nWe're moving forward in your candidacy. Could you send 3 professional references (name, email, relationship) by end of week?\n\nThanks!\nContoso People Ops`,
    daysAgo: 2,
    threadId: "thread_contoso_ml",
    expected: { isJob: true, stage: "interviewed", needsAction: true, company: "contoso", role: "ml engineer" },
  },
  // 12. Final round invite
  {
    id: "test_p_12",
    from: "Sarah Chen",
    fromEmail: "sarah.chen@northwind.example",
    subject: "Re: Final round — Northwind Data Analyst",
    body: `Great news! We'd like to invite you to a final onsite round next week. It will be 4 sessions over 4 hours, including lunch with the team.\n\nWhich day works best?`,
    daysAgo: 4,
    threadId: "thread_northwind_da",
    expected: { isJob: true, stage: "interview_scheduled", needsAction: true, company: "northwind", role: "data analyst" },
  },
  // 13. Onsite logistics
  {
    id: "test_p_13",
    from: "Northwind Recruiting",
    fromEmail: "recruiting@northwind.example",
    subject: "Your Northwind onsite agenda — Thursday Apr 24",
    body: `Hi Shuaiyu,\n\nLooking forward to hosting you Thursday. Agenda:\n9:30 AM — Welcome\n10:00 — Tech screen w/ Sarah\n11:00 — Case study w/ panel\n12:00 — Lunch w/ data team\n1:30 — Behavioral w/ hiring manager\n\nBased in our SF office (510 Townsend St). Let us know if you have questions.`,
    daysAgo: 3,
    threadId: "thread_northwind_da",
    expected: { isJob: true, stage: "interview_scheduled", company: "northwind", role: "data analyst" },
  },
  // 14. Offer letter
  {
    id: "test_p_14",
    from: "Initech People",
    fromEmail: "people@initech.example",
    subject: "Offer: Initech ML Engineer — $185k base + equity",
    body: `Hi Shuaiyu,\n\nWe're thrilled to offer you the ML Engineer role at Initech!\n\nBase salary: $185,000\nEquity: 0.05% over 4 years\nLocation: San Francisco (hybrid, 2 days in-office)\nVisa sponsorship: H-1B available\n\nPlease let us know your decision by April 30.\n\nFull offer letter attached.`,
    daysAgo: 1,
    threadId: "thread_initech_ml",
    expected: { isJob: true, stage: "offer", needsAction: true, company: "initech", role: "ml engineer" },
  },
  // 15. Form rejection
  {
    id: "test_p_15",
    from: "Fabrikam Recruiting",
    fromEmail: "recruiting@fabrikam-hq.example",
    subject: "Update on your Fabrikam application",
    body: `Hi Shuaiyu,\n\nThank you for your interest in Fabrikam. After careful review, we've decided to move forward with other candidates whose backgrounds more closely align with our needs.\n\nWe wish you the best in your search.`,
    daysAgo: 8,
    expected: { isJob: true, stage: "rejected", company: "fabrikam", role: "" },
  },
  // 16. Personal rejection
  {
    id: "test_p_16",
    from: "Maria Lopez",
    fromEmail: "maria.lopez@contoso.example",
    subject: "Following up on your candidacy",
    body: `Hi Shuaiyu,\n\nI really enjoyed our conversations and you have an impressive background. Unfortunately we've decided to go with another candidate who had more direct experience with RLHF infra. Please stay in touch — I'd love to consider you for future openings.\n\nBest,\nMaria`,
    daysAgo: 2,
    threadId: "thread_contoso_ml",
    expected: { isJob: true, stage: "rejected", company: "contoso", role: "ml engineer" },
  },
  // 17. Recruiter cold outreach (real human)
  {
    id: "test_p_17",
    from: "Alex Kim",
    fromEmail: "alex.kim@modernrecruiter.example",
    subject: "Series B FinTech opportunity — would you be open to chatting?",
    body: `Hi Shuaiyu,\n\nSaw your LinkedIn profile and was very impressed. I'm working with a Series B FinTech (corporate-card space) that's looking for a senior data analyst. Comp range $150-180k + equity.\n\nWould you be open to a quick 15-min call this week to learn more?\n\nAlex`,
    daysAgo: 1,
    expected: { isJob: true, stage: "received", company: "modernrecruiter", role: "data analyst" },
  },
  // 18. LinkedIn 1:1 message relay
  {
    id: "test_p_18",
    from: "John Smith via LinkedIn",
    fromEmail: "messaging-digest-noreply@linkedin.com",
    subject: "John Smith sent you a message about a role at Northwind",
    body: `John Smith (Engineering Manager at Northwind) sent you a message:\n\n"Hey Shuaiyu — saw you applied to our DA role. Would love to chat about your background. Are you free for a quick call next week?"\n\nReply on LinkedIn to continue the conversation.`,
    daysAgo: 5,
    threadId: "thread_northwind_da",
    expected: { isJob: true, stage: "received", company: "northwind", role: "" },
  },
  // 19. Handshake direct message
  {
    id: "test_p_19",
    from: "Hooli via Handshake",
    fromEmail: "handshake@notifications.joinhandshake.com",
    subject: "Hooli sent you a new message",
    body: `Hooli Systems Recruiter sent you a new message via Handshake about the Software Engineer position you saved.\n\nLog in to read the message and reply.`,
    daysAgo: 4,
    expected: { isJob: true, stage: "received", company: "hooli", role: "software engineer" },
  },
  // 20. Withdrawal confirmation
  {
    id: "test_p_20",
    from: "Umbrella Careers",
    fromEmail: "careers@umbrella.example",
    subject: "Confirmation: Application withdrawal",
    body: `Hi Shuaiyu,\n\nWe've received your request to withdraw your application for the Quantitative Analyst role. Best of luck with your job search.\n\nUmbrella Careers Team`,
    daysAgo: 14,
    expected: { isJob: true, stage: "withdrawn", company: "umbrella", role: "quantitative analyst" },
  },
  // 21-23: same Northwind DA application is already covered by p_01, p_03, p_07, p_10, p_12, p_13
  //        all share threadId thread_northwind_da AND same company+role → 1 application

  // 21. Different Northwind role — separate application
  {
    id: "test_p_21",
    from: "Northwind Recruiting",
    fromEmail: "recruiting@northwind.example",
    subject: "Application Received: Northwind Machine Learning Engineer",
    body: `Hi Shuaiyu,\n\nWe've received your application for the ML Engineer role and will review it shortly.`,
    daysAgo: 10,
    expected: { isJob: true, stage: "applied", company: "northwind", role: "ml engineer" },
  },
  // 22. Senior variant (test role normalization)
  {
    id: "test_p_22",
    from: "Initech People",
    fromEmail: "people@initech.example",
    subject: "Re: Senior ML Engineer at Initech — interview availability",
    body: `Hi Shuaiyu, following up on your application for Senior ML Engineer. Would you be available for a phone screen next Mon or Tue afternoon?`,
    daysAgo: 6,
    threadId: "thread_initech_ml",
    expected: { isJob: true, stage: "interview_scheduled", needsAction: true, company: "initech", role: "ml engineer" }, // Senior should normalize away → still "ml engineer"
  },
  // 23. Northwind Inc suffix variant (test company normalization)
  {
    id: "test_p_23",
    from: "Northwind, Inc. People",
    fromEmail: "people@northwind.example",
    subject: "Re: Northwind, Inc. — Data Analyst follow-up",
    body: `Just confirming our chat tomorrow at 3pm PT for the Senior Data Analyst position. Let me know if anything changes.`,
    daysAgo: 5,
    threadId: "thread_northwind_da",
    expected: { isJob: true, stage: "interview_scheduled", company: "northwind", role: "data analyst" }, // "Northwind, Inc." should normalize to "northwind"
  },
  // 24. Misc real-feel followup (Globex 2nd email)
  {
    id: "test_p_24",
    from: "Dana Reyes",
    fromEmail: "dana.reyes@globex.example",
    subject: "Re: Globex Capital America — meeting confirmed",
    body: `Hi Shuaiyu, thanks for confirming Friday at 10 AM PT. Calendar invite incoming. The interview will be with myself and our hiring manager David. Total 1 hour.`,
    daysAgo: 0,
    expected: { isJob: true, stage: "interview_scheduled", company: "globex", role: "data analyst" },
  },
];

const NEGATIVES: Fixture[] = [
  // 25. LinkedIn job alert digest
  {
    id: "test_n_01",
    from: "LinkedIn",
    fromEmail: "jobs-noreply@linkedin.com",
    subject: "5 new Senior Data Analyst jobs match your search",
    body: `New jobs matching your search:\n\n1. Senior Data Analyst — Salesforce — San Francisco\n2. Sr. Data Analyst — Box — Redwood City\n3. Data Analyst II — Square — San Francisco\n4. Senior Data Analyst — Twilio — Remote\n5. Sr. Data Analyst — Initech — San Francisco\n\nApply now via LinkedIn.`,
    daysAgo: 2,
    expected: { isJob: false },
  },
  // 26. Indeed weekly digest
  {
    id: "test_n_02",
    from: "Indeed",
    fromEmail: "alerts@indeed.com",
    subject: "Top 10 Data Analyst jobs in Irvine this week",
    body: `Hot jobs this week in Irvine, CA:\n\n• Data Analyst at Acme Corp\n• Sr. Data Analyst at Soylent\n• Data Analyst at Wayne Labs\n[and 7 more]\n\nView all via Indeed.`,
    daysAgo: 4,
    expected: { isJob: false },
  },
  // 27. "We're hiring" mass blast
  {
    id: "test_n_03",
    from: "DataCo Talent",
    fromEmail: "talent@dataco.example",
    subject: "DataCo is hiring — 12 open engineering positions",
    body: `Hi data professional,\n\nDataCo is growing! We have 12 open engineering positions including:\n- 4 ML engineers\n- 3 data engineers\n- 2 platform engineers\n- 3 analytics engineers\n\nPlease share with your network. Apply at dataco.example/careers.`,
    daysAgo: 6,
    expected: { isJob: false },
  },
  // 28. LinkedIn premium upgrade
  {
    id: "test_n_04",
    from: "LinkedIn Premium",
    fromEmail: "premium@linkedin.com",
    subject: "Upgrade to Premium — see who viewed your profile",
    body: `Want to know who's been looking at your profile? Upgrade to LinkedIn Premium for $39.99/month and unlock InMail, profile insights, and more.\n\nStart your free trial today.`,
    daysAgo: 7,
    expected: { isJob: false },
  },
  // 29. Career course promo
  {
    id: "test_n_05",
    from: "Interview Prep School",
    fromEmail: "team@interviewprep.io",
    subject: "Master your data analyst interview in 6 weeks — $99",
    body: `Land your dream data analyst job with our proven 6-week interview prep program.\n\n✓ 50+ practice questions\n✓ 1-on-1 mentorship\n✓ Resume review\n✓ Mock interviews\n\nNormally $299. This week only: $99.\n\nSign up now.`,
    daysAgo: 3,
    expected: { isJob: false },
  },
  // 30. Career fair invite (zotmail-style)
  {
    id: "test_n_06",
    from: "UCI Career Center",
    fromEmail: "careers@example.edu",
    subject: "UCI Spring Tech Career Fair — register by April 19",
    body: `All students,\n\nThe UCI Spring Tech Career Fair is happening April 23 from 11 AM - 3 PM in the Student Center. 60+ companies attending including Google, Apple, and Snowflake.\n\nRegister on the career center site by April 19. Bring 20 copies of your resume.\n\nUCI Career Center`,
    daysAgo: 1,
    expected: { isJob: false },
  },
  // 31. Industry newsletter
  {
    id: "test_n_07",
    from: "Data Science Weekly",
    fromEmail: "newsletter@datascienceweekly.org",
    subject: "Data Science Weekly Issue #480 — 10 articles, 3 papers",
    body: `This week's top reads:\n\n1. The state of LLM agents in 2026\n2. Why your data pipeline keeps breaking\n3. Building reliable ML infra at scale\n[7 more...]\n\nForward to a friend!`,
    daysAgo: 2,
    expected: { isJob: false },
  },
  // 32. Webinar invite
  {
    id: "test_n_08",
    from: "Vandelay Events",
    fromEmail: "events@vandelay.example",
    subject: "Free webinar: ML interviews demystified — sign up now",
    body: `Hi data professional,\n\nJoin our free webinar with Contoso's recruiting lead Sarah Park on April 25 at 11 AM PT. She'll cover:\n\n- What top ML companies look for\n- Common interview formats\n- Negotiation tips\n\nRegister free: vandelay.example/webinar/ml-interviews`,
    daysAgo: 5,
    expected: { isJob: false },
  },
];

const ALL_FIXTURES = [...POSITIVES, ...NEGATIVES];

function clean() {
  const result = db.prepare("DELETE FROM emails WHERE id LIKE 'test\\_%' ESCAPE '\\'").run();
  // Cascade-clean job_emails (FK ON DELETE CASCADE handles this) and applications via job_emails removal
  // Applications won't auto-delete (they're standalone) — clean orphaned applications:
  db.exec(`DELETE FROM applications WHERE id NOT IN (SELECT DISTINCT application_id FROM job_emails WHERE application_id IS NOT NULL)`);
  console.log(`Removed ${result.changes} test emails. Cleaned orphaned applications.`);
}

function seed() {
  const rows = ALL_FIXTURES.map((f) => {
    const { receivedAt, date } = dateFor(f.daysAgo);
    const snippet = f.body.replace(/\s+/g, " ").trim().slice(0, 120);
    return {
      id: f.id,
      from: f.from,
      fromEmail: f.fromEmail,
      subject: f.subject,
      snippet,
      body: f.body,
      bodyHtml: "",
      date,
      receivedAt,
      isUnread: true,
      category: "notification",
    };
  });
  upsertEmails(rows);

  // Set thread_id where specified (mimics Gmail thread grouping)
  const threadStmt = db.prepare("UPDATE emails SET thread_id = ? WHERE id = ?");
  const tx = db.transaction(() => {
    for (const f of ALL_FIXTURES) {
      if (f.threadId) threadStmt.run(f.threadId, f.id);
    }
  });
  tx();

  // Persist expectations as a JSON blob in app_state for the test script.
  const expectations = ALL_FIXTURES.map((f) => ({ id: f.id, ...f.expected }));
  db.prepare(`
    INSERT INTO app_state (key, value, updated_at) VALUES ('test_email_expectations', ?, unixepoch())
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()
  `).run(JSON.stringify(expectations));

  console.log(`Seeded ${ALL_FIXTURES.length} test emails (${POSITIVES.length} positive, ${NEGATIVES.length} negative).`);
  console.log(`Expectations stored in app_state.test_email_expectations.`);
  console.log(`Next: trigger prefetch (IMAP refresh) to run Jobs pipeline over fresh fixtures, then \`npm run test-job-pipeline\`.`);
}

const argv = process.argv.slice(2);
if (argv.includes("--clean")) {
  clean();
} else if (argv.includes("--clean-and-seed")) {
  clean();
  seed();
} else {
  seed();
}
