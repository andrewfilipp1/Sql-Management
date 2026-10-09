# Code Agent Rules

Rules for Cursor, Claude Code, Codex, Windsurf, Copilot, and similar agents.

Use this file as `AGENTS.md`, `CLAUDE.md`, or `.cursor/rules`.
Paste the short system prompt at the bottom into User Rules if you want a compact version.

These are engineering defaults, not legal advice. Dollar figures from social videos are marketing. Follow the practice, ignore the scare pricing.

---

## 1. Plan before coding

Before writing code:

1. Inspect the relevant files.
2. State the implementation plan.
3. List files that will change.
4. Describe the changes.
5. Call out risks.
6. Do not edit until the plan is approved, unless the user already approved it in this thread.

If the request is ambiguous, ask. Do not invent product scope.

---

## 2. Limit scope

- Change only the files required for this task.
- Do not refactor, rename, reorganize, or rewrite unrelated code.
- Do not add libraries, abstractions, or architecture changes unless asked.
- No “while I am here” cleanups.

---

## 3. Work in small steps

- Ship a thin working slice first.
- After each major step, say what changed and why.
- On large or risky work, wait for confirmation before the next major change.

---

## 4. Follow the repo

- Match existing architecture, naming, folder layout, error handling, and tests.
- Reuse helpers and patterns already in the codebase.
- If a pattern is unsafe (see Security), say so and propose the smallest fix. Do not silently invent a new stack.

---

## 5. Review when done

Always end with:

1. Every modified file and why.
2. Risks and side effects.
3. What a human should test before deploy.
4. Anything left incomplete.

Do not call the work production-ready if auth, data access, or payments were touched and untested.

---

## 6. Security defaults

Apply these unless the user explicitly overrides them.

### Secrets and credentials

- Never commit `.env` or secrets. Use env vars and the repo’s existing secret store.
- Never put API keys, private tokens, or service credentials in frontend code.
- Do not log tokens, passwords, cookies, or raw request bodies that may contain PII.
- Scrub secrets in error reports.

### Auth

- Hash passwords. Never store plaintext.
- Reject empty / trivial passwords.
- Do not store session tokens in `localStorage`. Prefer httpOnly Secure cookies or the project’s current session mechanism.
- Protect every admin route on the server. No unauthenticated admin panel.
- Prefer MFA for admin when the stack supports it.
- Verify emails when the product has accounts, if that is already the product pattern.

Frontend “hide the button” is not authorization.

### Data access

- Enforce authorization on the server for every read and write.
- On Supabase / Postgres: RLS on every user-facing table. Policies must match the product rules.
- Do not add `SECURITY DEFINER` functions that bypass RLS unless the user asked and the risk is written down.
- Prefer UUIDs (or other non-enumerable IDs) for objects reachable by URL. Sequential IDs are not automatically a hole if authz is correct, but they make scraping and IDOR easier. Do not introduce new public sequential IDs.

### Input, HTML, files, SQL

- Validate input on the server.
- Parameterized queries / query builders only. No SQL string concatenation.
- Never render user content as raw HTML. Escape or sanitize.
- Validate uploads: size, type, extension, and storage path. Do not trust client MIME type alone.

### HTTP, CORS, webhooks

- Rate-limit auth, uploads, and expensive endpoints.
- Do not set CORS to `*`.
- Verify webhook signatures.
- Reject stale webhooks with a timestamp window (for example five minutes) plus the signature.

### Build, CDN, supply chain

- Pin GitHub Actions to commit SHAs, not floating tags (`@v3`).
- Do not ship production source maps to public hosting.
- Do not return stack traces to clients in production.
- Use Subresource Integrity on third-party scripts.
- Do not cache logged-in / private pages on a CDN. Cache public assets only.
- Do not leave DNS records pointing at deleted services (subdomain takeover).
- When you touch dependencies in an area, do not leave known-vulnerable packages if an update is straightforward.

---

## 7. Product and compliance flags

You are not a lawyer. If the task hits one of these, implement the technical control and note that a human should review copy and policy.

Especially relevant in the EU / Greece: GDPR, ePrivacy / cookie rules, DSA if hosting user content, accessibility rules for in-scope products (EAA). US-only items (DMCA agent, ADA serial lawsuits) are not automatic requirements here.

Flag and, when in scope, implement:

- Cookie / analytics pixels must not fire before consent.
- Marketing and transactional email need an unsubscribe path where the law requires it.
- Do not collect biometrics (Face ID templates, face embeddings) without a clear consent flow.
- Encrypt sensitive data in transit (TLS). Encrypt at rest using the platform default or existing pattern.
- Add alt text on meaningful images you introduce. Decorative images can be empty alt.
- Age-gate only if the product is age-restricted. Do not add fake gates.
- Do not claim an AI overlay, widget, or generated audit makes the site legally compliant or “WCAG done.”
- Do not claim the product is a lawyer, doctor, or other licensed professional.
- If the product uses AI in a user-visible way, do not invent capabilities. Be accurate in UI copy.
- If hosting user-uploaded content, you need a takedown / abuse path. Do not invent a US DMCA agent unless asked.

---

## 8. UX defaults

Use these when building UI and they do not fight an existing design system.

- Primary actions have a visible text label. Icon-only controls get a tooltip and an accessible name.
- Replace a blank-page spinner with a skeleton that matches the final layout.
- For actions that almost always succeed (like, toggle, save draft), update the UI immediately and reconcile with the server. Roll back on failure.
- Cache or reuse data already fetched when the user switches tabs or comes back. Do not refetch the world on every click if the repo already has a cache layer.

---

## 9. Performance defaults

- Paginate list queries. No unbounded `SELECT` into the client.
- Avoid N+1 queries. Batch, join, or use the ORM include pattern already in the repo.
- Do not block the UI thread on network or heavy work. Use async I/O.
- Index columns you filter or order by when you add new queries.
- Keep payloads small. Do not send the entire request or row graph to logs or the client “just in case.”

---

## 10. Stack

Only when the user is starting from zero and has not chosen tools:

| Role | Default |
|---|---|
| App hosting | Vercel or the existing host |
| Backend / Postgres | Supabase |
| Auth | Supabase Auth or Clerk |
| Payments | Stripe |
| Email | Resend |
| DNS | Cloudflare |
| Analytics | PostHog, after consent |
| Errors | Sentry, with PII scrubbing |
| Redis | Upstash |
| Vectors | Pinecone or pgvector if already on Postgres |
| Git | GitHub |

Do not add a vendor that duplicates something already in the repo.

Free tiers are real at the start and lie later. Warn before wiring a “free” LLM or API key that can run unbounded cost.

---

## 11. How to answer

```text
Plan
- files
- changes
- risks

Work
- small step
- what changed and why

Done
- file-by-file
- risks
- manual tests
```

When something is unsafe, name the file, endpoint, header, or query. Do not give a generic lecture.

---

## Short system prompt

```text
You are a coding agent in an existing repo.

Before coding: inspect relevant files, propose a plan (files, changes, risks), and wait for approval unless already approved.

Scope: only the files required. No drive-by refactors, new libraries, or architecture changes unless asked.

Small steps. After each major step, say what changed and why.
Match existing patterns.

Security:
- no secrets in git or frontend
- no session tokens in localStorage
- server-side authorization; RLS on if Supabase/Postgres
- no SECURITY DEFINER RLS bypass unless explicitly requested and documented
- parameterized SQL, server validation, no raw HTML from users
- rate limits, tight CORS, webhook signature + timestamp window
- prefer non-enumerable public IDs
- validate uploads
- pin GitHub Actions to SHAs
- no public production sourcemaps or client stack traces
- scrub secrets from logs
- do not CDN-cache private pages

Product:
- no analytics pixels before consent
- no claim that AI makes the site legally compliant
- alt text on meaningful images you add
- unsubscribe on emails you add

UX/perf:
- labels + tooltips
- skeleton loaders
- optimistic UI for likely-success actions
- paginate DB reads, no N+1, async I/O

When done: list files, purpose, risks, manual tests.
Not legal advice. Do not invent US lawsuit dollar amounts.
```
