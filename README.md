# Chez Chrystelle Ops Bot

Internal chatbot for Chez Chrystelle delivery and store-operations questions.

## What it does

- React + Vite frontend
- Node + Express backend
- Simple retrieval over store-specific operating data
- Answers grounded only in the ops manual data
- Shows which store entries were used as sources

## Monorepo structure

```txt
apps/
  server/
  web/
```

## Setup

1. Copy the env template:

```bash
cp .env.example .env
```

2. Add your OpenAI API key to `.env`.

3. Install dependencies from the repo root:

```bash
npm install
```

4. Start both apps:

```bash
npm run dev
```

- Frontend: `http://localhost:5173`
- Backend: `http://localhost:3001`

## Notes

- The API key stays on the server only.
- The frontend talks only to your backend.
- Retrieval is currently local JSON retrieval. This is the easiest MVP.
- Later, you can swap retrieval for embeddings or an OpenAI vector store.

## Updating the ops data

Edit:

```txt
apps/server/data/ops-manual.json
```

Each entry is a store or policy chunk with aliases, topics, and grounded content.

## Current limitations

- Only answers from the stored operations data
- Some stores still have placeholder or partial info
- No authentication yet
- No conversation persistence yet

## Good next steps

- Add auth if this will live on the public internet
- Add an admin page for editing store notes
- Add embeddings once the manual gets larger
- Add a store-by-store returns policy section
