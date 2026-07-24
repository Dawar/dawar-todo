# Dawar Todo

A fast, focused personal task list hosted with ChatGPT Sites.

## What it does

- captures a new task in one step
- marks tasks done with one click
- searches across titles, notes, projects, and contexts
- filters by view, project, and priority
- sorts by smart order, priority, due date, date created, or title
- saves tasks durably in D1
- starts with the current structured tasks and open inbox captures imported from `~/projects/gtd-os`

## Local development

```bash
npm install
npm run dev
npm run build
```

Generate a migration after changing `db/schema.ts`:

```bash
npm run db:generate
```

Copy `.env.example` to your local runtime configuration when testing integrations. Talk uses
`OPENAI_API_KEY`, defaults to `gpt-realtime-2.1-mini` with the `marin` voice, and reads
`SERPER_API_KEY` and `JINA_AI_READER` only in server-side search and reading requests. Talk
prefers Serper for fast search results, then uses Jina when a page or PDF must be read in
depth. Keep all provider keys secret; browser clients receive only a short-lived OpenAI
Realtime client secret.
