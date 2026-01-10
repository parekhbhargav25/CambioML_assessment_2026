Author: Bhargav Parekh

# AI SDK Computer Use Agent Dashboard

A production-ready AI agent dashboard built on the AI SDK computer use demo. It provides a two-panel workspace with chat, event tracing, and a live VNC desktop for tool-driven automation.

## Demo

https://youtu.be/bfgjvrEK25g

## Highlights

- Two-panel dashboard with resizable splits
- Left panel: chat with inline tool call visualizations + collapsible debug event store
- Right panel: live VNC desktop + expanded tool call details
- Typed event pipeline (tool calls + results with timestamps, durations, status)
- Multi-session chat history with localStorage persistence (create, switch, delete)
- VNC viewer is memoized to avoid re-renders on chat updates
- Mobile-friendly layout (toggle between Chat/Desktop)

## Tech Stack

- Next.js App Router (React)
- AI SDK (`@ai-sdk/react` + `ai`)
- Anthropic Claude via `@ai-sdk/anthropic`
- e2b desktop for secure VNC sandbox
- Tailwind CSS + shadcn/ui

## Architecture Overview

### UI Layout
- `app/page.tsx` composes the dashboard using resizable panels.
- Left panel: chat, sessions, and debug event store.
- Right panel: VNC viewer with a resizable tool call detail pane.

### Event Pipeline
- `lib/agent-events.ts` defines a typed event model:
  - Tool payloads (computer/bash)
  - Results (image/text/aborted)
  - Status and duration
- `app/page.tsx` scans tool invocation parts and dispatches call/result events into a reducer-backed store.

### Session Management
- Sessions are persisted to `localStorage` under `computer-use:sessions`.
- Each session stores messages, timestamps, and a derived title.
- Users can create, switch, and delete sessions from the UI.

### VNC Stability
- `components/vnc-viewer.tsx` is memoized to prevent re-renders when chat updates.

## Local Development

### Prerequisites
- Node.js 18+
- pnpm (recommended)

### Install

```bash
pnpm install
```

### Environment Variables
Create `.env.local` and provide:

```
ANTHROPIC_API_KEY=...
E2B_API_KEY=...
```

### Run

```bash
pnpm dev
```

Open http://localhost:3000

## Scripts

- `pnpm dev` - start the development server
- `pnpm build` - create a production build
- `pnpm start` - start the production server
- `pnpm lint` - run lint checks

