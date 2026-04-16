# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Artifacts

### StudyFlow (react-vite, `/`)

An adaptive exam preparation web app implementing the algorithms from the research paper "An Algorithmic Approach to Stochastic Human Discipline" by Nikhilesh A.

**Key algorithms implemented:**
- Student state vector S = (M, C, K, D, A): Mastery, Confidence, Capacity, Discipline, Active Practice Ratio
- **Ebbinghaus forgetting curve**: `R = e^(-t/S)` where `S = 3 + mastery*18`. Priority = urgency × knowledgeGap × difficultyWeight × disciplineFactor × recencyBoost. Topics dormant >7 days get a recency boost.
- **Confidence score**: grows with practice attempts. `confidence = testsCount / (testsCount + 10)` — separate from mastery, tracks exam readiness
- Topic priority function with dependency graph (prerequisites must reach 60% mastery)
- Geometric capacity recovery model: K(t+1) = 0.8·K(t) + 0.2·H(t)
- Mastery update: m ← m + α·(s/smax − m) where α = 1/n_t
- Discipline score = actual / scheduled hours

**Pages:**
- `/` — Dashboard: stats, narrative system insights (velocity + time-of-day), learning velocity by subject, weekly chart, priority topics, system state vector
- `/onboarding` — First-time setup (redirected from dashboard if no profile)
- `/schedule` — Today's study blocks with ▶ Start / ⏹ Stop & Log timer, context hints, log sessions
- `/topics` — Topic manager with mastery + confidence scores, prerequisite blocking visibility, expandable session history, CSV import, curriculum forecast
- `/sessions` — Study history log
- `/review` — Weekly review: study by day, time by subject, neglected topics, actionable recommendations
- `/settings` — Profile editor + state vector display

**Analytics endpoints (computed on demand):**
- `GET /api/analytics/velocity` — per-subject mastery velocity (gain per practice session)
- `GET /api/analytics/study-patterns` — hour-of-day study distribution + peak hour
- `GET /api/analytics/weekly-review` — full weekly summary for the Review page

### API Server (express, `/api`)

**Routes:**
- `GET/POST/PATCH /api/student/profile` — student profile management
- `GET/POST/PATCH/DELETE /api/topics/:id` — topic CRUD + mastery + confidence update
- `GET/POST /api/schedule/today` — today's schedule, recalculation trigger
- `GET /api/sessions?topicId=X&limit=N` — study session logging, filterable by topic
- `GET /api/dashboard/summary` — dashboard aggregates
- `GET /api/dashboard/weekly-progress` — 7-day progress chart data
- `GET /api/analytics/*` — velocity, study-patterns, weekly-review
- `GET /api/healthz` — health check

### Chrome Extension (`artifacts/chrome-extension/`)

Chrome MV3 extension for passive study tracking. Not a Replit web artifact — load as unpacked extension from `chrome://extensions`.

**Features:**
- **Passive tracking** — watches active tab, matches domains against user-configured mappings, auto-logs sessions ≥2min to the API
- **Manual sessions** — Start/Stop from popup with live elapsed timer
- **Schedule popup** — today's blocks with ▶ Start buttons, recent auto-log history
- **Push notifications** — Chrome notifications 15min before each scheduled block
- **Options page** — API URL config + domain→topic mapping, connection test, CSV format reference

**Key files:**
- `background.js` — service worker: tab tracking, auto-log, notifications, manual session messages
- `popup.html/js/css` — extension popup UI
- `options.html/js/css` — settings page

## Design Tokens

- Primary: `hsl(193 72% 21%)` — deep teal `#1b6b7a`
- Background: `hsl(40 33% 98%)` — warm cream
- Font: Outfit

## CSV Import Format

```csv
name,subject,difficulty,estimatedHours,mastery
Differential Equations,Mathematics,4,20,0.1
Organic Chemistry,Chemistry,4,25,0
```
