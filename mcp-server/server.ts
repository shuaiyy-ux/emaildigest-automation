#!/usr/bin/env node
/**
 * EmailDigest MCP Server — exposes 3 read-only tools against the local SQLite.
 *
 *   search_emails     — chunk-level semantic search via /api/internal/rag-search
 *   read_full_email   — fetch a single email by id
 *   get_application   — fetch a job application's aggregate state + history
 *
 * The web app mounts it for Ask AI through a generated --mcp-config (see
 * web/lib/claude-cli.ts); `.mcp.json` is only for running the CLI by hand
 * from the repo root.
 *
 * SECURITY: only narrow tools. No generic list/query — Claude cannot bypass
 * the RAG precomputation by scanning the DB agentically. search_emails
 * routes through retrieveRelevant() which enforces cosine threshold + cap.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import Database from "better-sqlite3";
import * as path from "path";

const EMAILDIGEST_DIR =
  process.env.EMAILDIGEST_DIR || path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DB_PATH = path.join(EMAILDIGEST_DIR, "data.db");

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
db.pragma("journal_mode = WAL");

// URL of the Next.js app's internal RAG-search endpoint (same machine, loopback).
// Middleware bypasses auth for /api/internal/* when Host is 127.0.0.1 / localhost.
// The web app passes this (with its own PORT) in the MCP config it generates.
const INTERNAL_URL = process.env.EMAILDIGEST_INTERNAL_URL || "http://127.0.0.1:3000";

const server = new Server(
  { name: "emaildigest-db", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

const TOOLS = [
  {
    name: "search_emails",
    description:
      "Chunk-level semantic search over the user's local email database. Each email body is split into ~400-char chunks (paragraph/sentence boundaries) and embedded independently with all-MiniLM-L6-v2 (English, 384-d). The query embedding is scored against every chunk, then results are deduped per email keeping the best-matching chunk as that email's representative. This means long emails where key info (dates, events, deadlines) sits deep in the body can still be found — unlike whole-email embedding which would dilute those signals.\n\nReturned `body` field = the best-matching chunk (~300 chars), NOT the first 300 chars of the email. If the chunk lacks surrounding context, call `read_full_email(id)`.\n\nCall whenever the user's question requires inbox context (deadlines, senders, jobs, events, past content). Skip for pure conversational turns (greetings, clarifications).\n\nQUERY LANGUAGE: inbox is ~99% English, embedder is English-only. ALWAYS pass `query` in English. If user writes Chinese, translate to English nouns + 1–3 synonyms. Example: '毕业礼服' → 'graduation gown regalia'. Keep proper nouns (professor names, platforms like Gradescope) as-is.\n\nQUERY FORM: prefer short, focused queries (2–6 key terms). Long natural-language sentences work worse — chunks are compact, so queries should be too. If first search returns < 3 hits, retry with different English synonyms.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Short English search string — nouns + synonyms. Proper nouns as-is. Example: 'graduation gown regalia' or 'robotics demo night May'.",
        },
        max_results: {
          type: "number",
          description: "Cap on returned emails after per-email dedup (default 20, max 100). Increase to 50 only if first search at default is too sparse.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "read_full_email",
    description:
      "Fetch the complete body and metadata of a single email from the local database by its ID. Use when the snippet/excerpt provided in the conversation context is not enough to answer a user's question (e.g., the user asks about details deep inside an email body).",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description:
            "The email ID (hex string, from citations like [#19d9c0df]). Exact match required.",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "get_application",
    description:
      "Fetch an aggregated job application: company, role, current stage, all emails in this application's history (subject + stage + date), deadline, salary, location. Use when the user asks about a specific job application's status, timeline, or next steps.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description:
            "Either a full application ID (like app_xxxxxxxx) or the company name to fuzzy-match (first match wins). Exact ID is preferred.",
        },
      },
      required: ["id"],
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === "search_emails") {
      const q = String((args as { query?: string })?.query || "").trim();
      if (!q) return err("missing query");
      const max = Number((args as { max_results?: number })?.max_results) || 20;
      const res = await fetch(`${INTERNAL_URL}/api/internal/rag-search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: q, max_results: max }),
      });
      if (!res.ok) return err(`rag-search http ${res.status}`);
      const data = (await res.json()) as Record<string, unknown>;
      return ok(data);
    }

    if (name === "read_full_email") {
      const id = String((args as { id?: string })?.id || "").trim();
      if (!id) return err("missing id");
      const row = db
        .prepare(
          `SELECT id, from_name, from_email, subject, date, received_at,
                  body, body_html, category_id, thread_id, is_unread
           FROM emails WHERE id = ?`
        )
        .get(id) as
        | {
            id: string;
            from_name: string;
            from_email: string;
            subject: string;
            date: string;
            received_at: number;
            body: string;
            body_html: string;
            category_id: string | null;
            thread_id: string;
            is_unread: number;
          }
        | undefined;
      if (!row) return err(`email ${id} not found`);
      return ok({
        id: row.id,
        subject: row.subject,
        from: row.from_name,
        from_email: row.from_email,
        date: row.date,
        body: row.body,
        body_html_present: !!row.body_html,
        category: (row.category_id || "unknown").replace(/^cat_/, ""),
        thread_id: row.thread_id,
        unread: !!row.is_unread,
      });
    }

    if (name === "get_application") {
      const id = String((args as { id?: string })?.id || "").trim();
      if (!id) return err("missing id");

      let app = db
        .prepare("SELECT * FROM applications WHERE id = ?")
        .get(id) as Record<string, unknown> | undefined;

      if (!app) {
        app = db
          .prepare(
            `SELECT * FROM applications
             WHERE lower(company) LIKE lower(?) OR lower(company_display) LIKE lower(?)
             ORDER BY latest_email_at DESC LIMIT 1`
          )
          .get(`%${id}%`, `%${id}%`) as Record<string, unknown> | undefined;
      }

      if (!app) return err(`application matching "${id}" not found`);

      const emails = db
        .prepare(
          `SELECT je.email_id, je.stage, je.needs_action, je.action_type, je.deadline,
                  je.summary, e.subject, e.from_name, e.date, e.received_at
           FROM job_emails je
           JOIN emails e ON e.id = je.email_id
           WHERE je.application_id = ?
           ORDER BY e.received_at ASC`
        )
        .all(app.id) as Array<Record<string, unknown>>;

      return ok({
        id: app.id,
        company: app.company_display || app.company,
        role: app.role_display || app.role,
        current_stage: app.current_stage,
        current_priority: app.current_priority,
        current_summary: app.current_summary,
        current_deadline: app.current_deadline
          ? new Date((app.current_deadline as number) * 1000).toISOString().slice(0, 10)
          : null,
        needs_action: !!app.needs_action,
        action_type: app.action_type,
        salary: app.salary,
        location: app.location,
        remote_mode: app.remote_mode,
        visa_note: app.visa_note,
        first_email_at: app.first_email_at
          ? new Date((app.first_email_at as number) * 1000).toISOString().slice(0, 10)
          : null,
        latest_email_at: app.latest_email_at
          ? new Date((app.latest_email_at as number) * 1000).toISOString().slice(0, 10)
          : null,
        email_count: emails.length,
        emails: emails.map((e) => ({
          id: e.email_id,
          date: e.date,
          from: e.from_name,
          subject: e.subject,
          stage: e.stage,
          needs_action: !!e.needs_action,
          action_type: e.action_type,
          deadline: e.deadline
            ? new Date((e.deadline as number) * 1000).toISOString().slice(0, 10)
            : null,
          summary: e.summary,
        })),
      });
    }

    return err(`unknown tool: ${name}`);
  } catch (e) {
    return err(`tool error: ${(e as Error).message}`);
  }
});

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function err(msg: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify({ error: msg }) }],
  };
}

const transport = new StdioServerTransport();
await server.connect(transport);
