# Memory

Saved memory belongs to Postgres. `packages/memory` owns scope checks, revisions, transactions, search and background jobs. Web actions and the worker use the same service. The normal deployment needs no additional service.

## Use it

- Open a teammate's Memory tab for its facts, notes, preferences and lessons.
- Open Settings → About you for facts every teammate can use.
- Add or edit a memory, pin important facts, optionally assign a topic key or expiry, inspect its source and history, restore an earlier revision, or export Markdown.
- Inferred memories appear as suggestions. Confirm them to make them available to bots, or dismiss them.
- Ask a bot to remember a fact, recall it, correct it or forget it. Bot tools receive their scope from the running session, never from an arbitrary caller-supplied bot ID.

A correction uses an expected revision. An editor with stale content receives a conflict and keeps its unsaved text. Restore creates a new revision and restores saved content and metadata. Undo after a save uses the same revision check.

Forget removes content from current memory, all saved revisions and search vectors, and cancels pending item indexing. It leaves a content-free tombstone and hashes for duplicate suppression. When source message IDs are known, automatic extraction from those messages is suppressed too. Forgetting a saved memory does not erase its original conversation, earlier model outputs, provider logs or backups. Imported legacy notes may not have message-level provenance. Bot-scoped retrieval is a logical boundary; the existing shared computer is not a separate security boundary for each bot.

## Upgrade and legacy data

Run `pnpm install` and `pnpm db:migrate` before restarting the web app and worker. The database must support the `vector` extension; the migration enables it. The existing development image already includes pgvector.

The shared profile and old feedback lessons are imported idempotently. Existing `MEMORY.md` files are imported on the bot's first successful workspace preparation. Their text is preserved as a pinned note; it is not silently interpreted as individual facts. If a file cannot be read, preparation fails without overwriting it. Import markers survive forgetting, so restarting cannot resurrect old notes.

After import, the computer's `MEMORY.md` contains only a generated pointer to the memory tools. Saved memory bodies are supplied directly to each task, and a Markdown export is available in the UI. File edits are never imported again. This avoids storing another copy of forgotten facts on the shared computer. `settings.aboutMe` (an 8,000-character preview) and the legacy `lessons` table are compatibility projections, maintained by the memory service; do not write them directly. The preview limit does not cap canonical shared memory.

Teammate duplication copies confirmed bot memories only when “Copy their memory” is selected. Shareable teammate exports retain their existing format: private notes and conversation history are not exported with a teammate. Use the separate Memory export for private backup or inspection.

## Task context and continuity

Before a turn starts, the worker retrieves active shared memories and that bot's own memories. Pinned entries come first, followed by relevant entries. The injected packet is bounded to 6,000 characters and 12 entries. This is a conservative character budget, not an exact token estimate. Original conversations remain searchable through `search_history`.

Keyword search uses Postgres full-text search with English stemming and OR-matched request terms, with literal substring matching in the memory UI. Optional semantic recall uses exact pgvector cosine-distance search. Semantic matches use a configurable cosine-distance cutoff (`MEMORY_SEMANTIC_MAX_DISTANCE`, initially 0.4); calibrate this against your embedding model. Lexical and semantic rankings are combined with reciprocal rank fusion. Approximate indexes are deliberately deferred until dataset size and measured latency warrant them.

Each run records the IDs and revisions supplied in `memory_contexts`, without duplicating memory bodies. “Memory context” under a reply shows the current unchanged facts or indicates that an entry changed or was forgotten. It does not claim the model relied on every retrieved fact.

Each scope has a generation counter. Active memory changes mark affected running turns for interruption. A thread with an older memory generation is replaced with a fresh Codex thread, never forked with stale facts. Expiry also changes the generation used for thread selection. The current request and newly retrieved context start the replacement thread; previous model replies are not replayed. The bot may explicitly search original history when continuity requires it, and the original history has not been erased. Memory operations performed by a bot update its current view; a forget also interrupts that turn. New threads may lose conversational detail that existed only in the prior model context.

## Optional embeddings and extraction

All memory AI is off by default. Configure the worker through `.env`:

```dotenv
MEMORY_EMBEDDING_URL=http://127.0.0.1:8000/v1/embeddings
MEMORY_EMBEDDING_MODEL=your-embedding-model
MEMORY_EMBEDDING_DIMENSIONS=768
MEMORY_EXTRACTION_URL=http://127.0.0.1:8000/v1/chat/completions
MEMORY_EXTRACTION_MODEL=your-extraction-model
MEMORY_AI_API_KEY=
MEMORY_AI_DAILY_REQUEST_LIMIT=100
```

The embedding endpoint accepts `{model,input}` and returns `{data:[{embedding:[...]}]}`. Dimensions must match the configured value (1–4096); vectors must be finite and nonzero. Index identity includes the model and dimensions. Restarting with a new model seeds jobs for active memories that have no matching embedding. Old and edited vectors never participate in recall.

The extraction endpoint accepts chat-completions-shaped JSON with `model`, `messages`, `temperature`, `max_tokens` and `response_format`. It must return a JSON string in `choices[0].message.content` with `memories: [{content,kind,evidence}]`. The worker validates at most five candidates and requires each evidence quotation to appear in the actual user message. Candidates remain unconfirmed and bot-scoped; unsupported quotes are dropped. Extraction processes completed user-started runs, not webhooks, emails, bot handoffs, or the bot's final answer. It is optional and never prevents a reply from completing.

The configured bearer token is separate from the ChatGPT plan and fallback API key. Configuring an endpoint explicitly authorizes sending memory text (for embedding) or the current user message (for extraction) there. Query embeddings also consume requests. Inputs, outputs and timeouts are bounded. The shared request limit is reserved atomically before sending; it is a request cap, not a monetary cost guarantee. Set it to 0 to disable all memory AI. Budget-exhausted background work waits until the next database day; other failures retry with backoff, up to five attempts. Keyword recall remains available when semantic search fails.

Jobs are durable rows in Postgres, claimed with leases and `SKIP LOCKED`. A vector writer locks and rechecks the item's current revision and deletion state before committing. An in-flight result cannot recreate a forgotten entry. Logs use fixed messages rather than endpoint response bodies or memory contents. To retry exhausted jobs after correcting a provider configuration:

```sql
UPDATE memory_jobs SET attempts = 0, available_at = now(), locked_until = NULL
WHERE completed_at IS NULL AND attempts >= 5;
```

## Verification

```sh
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
pnpm test:memory -- --e2e
```

The last command creates an isolated pgvector container, applies all migrations, runs database and HTTP-provider tests, smoke-tests the compiled worker, starts a dedicated web server, and exercises the browser UI at desktop and phone widths. It removes only its own container afterwards and never connects to the normal app database. Docker and the Playwright Chromium browser are required. Use `pnpm exec playwright install chromium` if Chromium is missing.

Coverage includes concurrent writes, revision conflicts, restore, scope isolation, candidate confirmation, expiry, migration, lexical and semantic recall, request budgets, late indexing after forgetting, source suppression, thread replacement, Markdown import failure, CRUD through authenticated server actions, export, mobile layout and anonymous API rejection. Provider behavior is tested with a deterministic local HTTP server. Tests do not consume a paid model or assert that every model will follow its memory instructions.
