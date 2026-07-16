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
