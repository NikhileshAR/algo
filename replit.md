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

**Key concepts implemented:**
- Student state vector S = (M, C, K, D, A): Mastery, Confidence, Capacity, Discipline, Active Practice Ratio
- Topic priority function with dependency graph (prerequisites must reach 60% mastery)
- Geometric capacity recovery model: K(t+1) = 0.8·K(t) + 0.2·H(t)
- Mastery update: m ← m + α·(s/smax − m) where α = 1/n_t
- Discipline score = actual / scheduled hours
- Nightly recalculation loop via POST /api/schedule/today
- Psychological reset (backlog clearing) when schedule falls too far behind

**Pages:**
- `/` — Dashboard with stats, weekly chart, priority topics, system state vector
- `/onboarding` — First-time setup (redirected from dashboard if no profile)
- `/schedule` — Today's study blocks, log sessions, trigger recalculation
- `/topics` — Topic manager with mastery bars, prerequisites, dependency info
- `/sessions` — Study history log
- `/settings` — Profile editor + state vector display

### API Server (express, `/api`)

**Routes:**
- `GET/POST/PATCH /api/student/profile` — student profile management
- `GET/POST/PATCH/DELETE /api/topics/:id` — topic CRUD + mastery update
- `GET/POST /api/schedule/today` — today's schedule, recalculation trigger
- `GET/POST /api/sessions/:id` — study session logging
- `GET /api/dashboard/summary` — dashboard aggregates
- `GET /api/dashboard/weekly-progress` — 7-day progress chart data
- `GET /api/dashboard/priority-topics` — top 5 priority topics

**Key scheduling logic:** `artifacts/api-server/src/lib/scheduler.ts`

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
