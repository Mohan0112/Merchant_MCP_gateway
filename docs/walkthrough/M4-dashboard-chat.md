# Walkthrough M4: Dashboard and chat agent (Tasks 13–16)

## Big picture

The dashboard is a React 19 single-page app, built by Vite and served as static files by nginx-unprivileged on the same host as the gateway: the Ingress sends `/api` and `/mcp` to the gateway and everything else to the dashboard, so the browser makes same-origin calls with an httpOnly session cookie. Every screen reads and writes through the gateway's REST API with TanStack Query; the UI hides what a role can't do, and the gateway refuses it anyway. The chat agent is a module inside the gateway: `POST /api/chat` runs an LLM tool loop whose tools come from the gateway's own `/mcp`, called over loopback with a short-lived token tied to the user's session. So the chat sees the same tools, passes the same checks and leaves the same audit rows as the user's own MCP client, with channel `chat_agent` ([M3](M3-gateway.md) covers that path).

## File map (dashboard, then the gateway's chat module)

| File | What it does |
|---|---|
| [`main.tsx`](../../apps/dashboard/src/main.tsx), [`auth.tsx`](../../apps/dashboard/src/auth.tsx), [`pages/AuthPages.tsx`](../../apps/dashboard/src/pages/AuthPages.tsx) | Routes and the query client (a 401 anywhere means signed out); `RequireUser` puts a forced password change first, `RequireAdmin` guards Members; sign-in, invitation and password pages; the chat page loads lazily |
| [`lib/api.ts`](../../apps/dashboard/src/lib/api.ts) | Typed same-origin client using types from `@urumi/contracts`: `X-Requested-With` on writes; problem+json becomes an `ApiError` whose field errors appear under form inputs |
| [`components/Layout.tsx`](../../apps/dashboard/src/components/Layout.tsx), [`components/ui.tsx`](../../apps/dashboard/src/components/ui.tsx) | Shell with a role-aware sidebar; a small kit (modal, badges, switch, copyable code block) on plain CSS that follows the OS light or dark theme |
| [`pages/ServersPage.tsx`](../../apps/dashboard/src/pages/ServersPage.tsx) | Cards with status and reason, polled every 5 s; tool list; add and edit with "Test connection"; enable switch; remove |
| [`pages/MembersPage.tsx`](../../apps/dashboard/src/pages/MembersPage.tsx), [`pages/KeysPage.tsx`](../../apps/dashboard/src/pages/KeysPage.tsx), [`lib/snippets.ts`](../../apps/dashboard/src/lib/snippets.ts) | Admins: invitation links, roles, disable, a member's keys. Everyone: the gateway URL, a new key shown once with snippets for Claude Code, Cursor, VS Code and MCP Inspector, revoke |
| [`pages/AuditPage.tsx`](../../apps/dashboard/src/pages/AuditPage.tsx) | Filters (user for admins, server, tool, outcome, channel), "Load older entries" paging, refresh every 10 s |
| [`pages/ChatPage.tsx`](../../apps/dashboard/src/pages/ChatPage.tsx), [`lib/sse.ts`](../../apps/dashboard/src/lib/sse.ts) | Chat: a POST whose streamed response is parsed into events, a card per tool call, Markdown answer, Stop, New chat |
| [`docker/dashboard/`](../../docker/dashboard/), [`dashboard.yaml`](../../charts/urumi/charts/platform/templates/dashboard.yaml), [`ingress.yaml`](../../charts/urumi/charts/platform/templates/ingress.yaml) | nginx config (SPA fallback, cache headers, CSP and other security headers); Deployment as uid 101 with a read-only root filesystem; `/api` and `/mcp` to the gateway, the rest to the dashboard |
| [`chat/routes.ts`](../../apps/gateway/src/modules/chat/routes.ts) | `POST /api/chat`: SSE headers, a chat token for the signed-in user, run the agent, abort on disconnect, revoke the token |
| [`chat/agent.ts`](../../apps/gateway/src/modules/chat/agent.ts) | The tool loop: MCP client of `/mcp`, system prompt, at most 8 rounds and no new round after 120 s, a round's tool calls in parallel, results capped at 16,000 characters |
| [`chat/llm.ts`](../../apps/gateway/src/modules/chat/llm.ts), [`chat/tokens.ts`](../../apps/gateway/src/modules/chat/tokens.ts) | One OpenAI-compatible adapter (Groq, Gemini) behind `FallbackProvider`, plus `ScriptedProvider` for tests; `uchat_` tokens kept in memory, as SHA-256 hashes, for 5 minutes |
| [`mcp/endpoint.ts`](../../apps/gateway/src/mcp/endpoint.ts) | `authenticate()` accepts a chat token only while its user is active and its dashboard session still exists |
| [`chat.test.ts`](../../apps/gateway/src/modules/chat/chat.test.ts), [`lib.test.ts`](../../apps/dashboard/src/lib/lib.test.ts) | A scripted model drives the real loop over real HTTP and the audit row is checked; SSE parser, formatting, client snippets |

## Four flows through the code

1. **A user asks "What is today's order total in US dollars?":**

```text
ChatPage.send  last 20 messages + the question → POST /api/chat with cookie and X-Requested-With
routes.ts      requireUser → ChatRequestSchema → text/event-stream → uchat_ token for this user and session
agent.ts       MCP client → http://127.0.0.1:8080/mcp with the token → tools/list (fresh every turn)
endpoint.ts      token unexpired, user active, session still in the DB → principal, channel chat_agent
agent.ts       tools become function schemas → provider.complete(): Groq, or Gemini if Groq fails
               model asks for woo__list_orders {period: "today"} → tool.started → callTool via /mcp
invoke.ts        same path as an API key: catalog, server timeout, audit row (user A, chat_agent)
agent.ts       tool.completed (ok, ms, 400-character preview); result (≤ 16,000 chars) back to the model
               next round: fx__convert_currency; then a round without tool calls → message → done
ChatPage       each event updates the turn: tool cards, Markdown answer, "groq · 2 tool calls"
```

2. **Stop, or the user leaves the page.** The browser aborts the fetch. The gateway notices through the response's `close` event and aborts the model request; a tool call already running finishes and is audited, but no new round starts, and `finally` revokes the token. Listening on the request's `close` was a real bug: Node fires it as soon as the body has been read, which emptied the chat behind Traefik, so a test now streams over real HTTP.
3. **A member creates a key and connects Claude Code.** `POST /api/api-keys` stores only the HMAC and returns the plaintext once, with `Cache-Control: no-store`. `NewKeyModal` shows it with snippets built from `window.location.origin + '/mcp'`, such as `claude mcp add --transport http urumi <url> --header "Authorization: Bearer <key>"`; nothing about the upstreams goes into the client.
4. **Sign-in and route guards.** `POST /api/auth/login` sets the httpOnly cookie, and `useMe()` reads `GET /api/auth/me`. `RequireUser` sends a user who must change their password to `/change-password`, and the gateway answers 403 `password_change_required` on every other route anyway. A 401 from any call clears `me`, and the router returns the user to `/login`.

## Design decisions, one line each

- **One host, path routing:** same-origin calls, so the httpOnly `SameSite=Lax` cookie just works, there is no CORS, and no API URL is baked into the image.
- **Static files on nginx-unprivileged:** uid 101, read-only root filesystem, a CSP that allows only same-origin scripts; hashed bundles are cached for a year and `index.html` is revalidated, so a new deployment shows up on the next load.
- **The chat is an MCP client of its own gateway** (plan ADR-005): the same authentication, routing and audit as Claude Code, and the chat code never touches upstream credentials; the trade-off is that the LLM key shares a pod with them.
- **SSE over `fetch`, not `EventSource`:** `EventSource` can only send a GET, so it can't carry the conversation or the CSRF header.
- **Live steps, answer in one piece:** each round calls the model without streaming, so tool cards appear as they happen and the text arrives as one `message` event, the same on every provider.
- **No chat state on the server:** the browser sends the recent history each turn and keeps it only in page state, so leaving the page or "New chat" starts over.

## Likely questions and short answers

**How does the chat agent act as the logged-in user?**
`POST /api/chat` needs the session cookie. The gateway issues a random `uchat_` token mapped to that user and session, kept only in memory for at most 5 minutes and revoked when the turn ends, and the agent calls `http://127.0.0.1:8080/mcp` with it. `/mcp` accepts it only while the user is active and the session exists, so every call goes through `invokeTool()` and is audited under that user with channel `chat_agent` (the chat test checks the row). If the user signs out mid-answer, the next tool call gets 401.

**Why go through `/mcp` instead of calling `invokeTool()` or the upstreams directly?**
One path means one set of checks: the chat sees exactly what the user's own MCP client sees, Phase 2 tool permissions will apply to it with no extra code, and the brief says nothing but the gateway talks to upstreams. The cost is a loopback HTTP hop and an MCP handshake per turn.

**What stops a looping, slow or unavailable model?**
A turn stops after 8 rounds (`iteration_limit`), and no new round starts after 120 s (`budget_exceeded`); a test drives a model that never stops calling tools. Each model request times out after 60 s and the OpenAI SDK retries it twice with backoff, then `FallbackProvider` tries Gemini. If every provider fails, the user gets a plain message (`llm_rate_limited` for a 429); with no LLM key at all the gateway still runs and the chat says it isn't configured.

**How do you handle prompt injection in tool results or descriptions?**
It can't be ruled out, so it's contained. The system prompt says tool output is data, never instructions, and not to change order status or delete things unless the user asked; `/mcp` gives every client the same advice in its `instructions`. Descriptions carry their server's name and are capped at 2000 characters, results at 16,000, and every call is audited under the user. Per-role tool permissions and pinned tool definitions are Phase 2 (Tasks 22–23).

**An admin disables `fx`. How does the chat lose its tools?**
The agent lists tools at the start of every turn, so the next turn has no `fx__*` tools. A turn that started before the change can still ask for one; `/mcp` then answers "disabled by an admin" and audits `rejected_disabled`. `task dod` checks this with a currency question.

**Is the dashboard protected against XSS and CSRF?**
React escapes text, and react-markdown shows raw HTML in an answer as plain text and drops unsafe link protocols; links open with `rel="noreferrer"`. The CSP allows scripts only from the same origin and forbids framing. Writes need `X-Requested-With`, which a cross-site page can't send without a CORS preflight that the gateway never grants, and the cookie is `SameSite=Lax`.

**What can a member not do, and where is that enforced?**
A member can't manage servers or people, see server URLs or credentials, touch other people's keys, or read other users' audit rows. The UI hides those parts, but the gateway enforces each rule (`requireAdmin`, ownership checks in the key service, `queryAudit()` ignoring a member's user filter), and tests call admin routes as a member and get 403. Members do share the upstream credentials: anyone can act on the store through the tools (for example, change an order's status), and the audit log shows who did; per-role tool limits are Phase 2 (Task 23).
