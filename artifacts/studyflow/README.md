# How to Download, Install, and Run StudyFlow Locally (Windows)

## 1) Overview

StudyFlow is a local-first study planning and execution app with a Vite frontend and a workspace API server.

By following this guide, you will set up the repo from scratch on Windows, fix common environment issues, run both services, and open the app successfully in your browser.

---

## 2) System Requirements

Use **Windows + PowerShell**.

### Required versions

- **Node.js: 20 LTS (recommended)**
  - Why: newer Node versions (especially bleeding-edge releases like Node 24+) can cause native binary/binding issues in frontend tooling (for example `lightningcss` or `@tailwindcss/oxide`).
- **pnpm: latest stable**
  - Install via Corepack (recommended):

```powershell
corepack enable
corepack prepare pnpm@latest --activate
pnpm -v
```

> Tip: Confirm Node version first:

```powershell
node -v
```

If you are not on Node 20 LTS, switch to Node 20 before continuing.

---

## 3) Clean Setup (Very Important)

Open PowerShell in repo root:

```powershell
cd C:\path\to\algo
```

### A) Remove old installs/lock artifacts

```powershell
Remove-Item -Recurse -Force node_modules
Remove-Item -Force pnpm-lock.yaml
```

If lockfile removal fails because it does not exist, continue.

### B) Clear problematic Node flags in environment

Check current value:

```powershell
$env:NODE_OPTIONS
```

If you see invalid/legacy flags (for example `--no-experimental-fetch`), clear it:

```powershell
setx NODE_OPTIONS ""
```

**Important:** close and reopen PowerShell after `setx` so the updated environment is applied.

---

## 4) Install Dependencies

This repository is a **pnpm workspace (monorepo)**, so install from repo root:

```powershell
pnpm install
```

What to expect:

- Dependencies for multiple workspace packages are installed.
- Warnings about optional native packages may appear on Windows and are often safe.
- Install is successful if command ends without `ELIFECYCLE`/fatal errors.

---

## 5) Fix Native Module Issues (Critical)

On Windows, native package resolution can sometimes mismatch after reinstall or Node version changes.

Run:

```powershell
pnpm rebuild
pnpm add lightningcss-win32-x64-msvc -w
```

Why this helps:

- `lightningcss` and Tailwind oxide rely on platform-specific native binaries.
- Rebuild + explicit Windows binary package resolves “Cannot find native binding” type failures.

---

## 6) Environment Variables Setup

Set these in the same PowerShell session before starting frontend:

```powershell
$env:PORT="5173"
$env:BASE_PATH="/"
```

Why:

- `artifacts/studyflow/vite.config.ts` reads `PORT` and `BASE_PATH` to configure dev server port and base path.
- Explicitly setting them avoids accidental mismatch across shells/tools.

For API server (separate terminal), use port 8080:

```powershell
$env:PORT="8080"
```

---

## 7) Running the App

Use **two PowerShell terminals**.

### A) Start API server (Terminal 1)

From repo root:

```powershell
cd C:\path\to\algo
$env:PORT="8080"
pnpm --filter @workspace/api-server run build
pnpm --filter @workspace/api-server run start
```

Expected output includes server startup logs and port info.

> Note: if you try `pnpm --filter @workspace/api-server run dev` in pure PowerShell, it may fail because that script uses Unix-style `export`.

### B) Start StudyFlow frontend (Terminal 2)

```powershell
cd C:\path\to\algo\artifacts\studyflow
$env:PORT="5173"
$env:BASE_PATH="/"
pnpm run dev
```

Expected output includes:

- `VITE` startup message
- local URL, usually `http://localhost:5173`

---

## 8) Accessing the App

Open browser:

```text
http://localhost:5173
```

You should see the StudyFlow onboarding/initial app screen.

---

## 9) Common Errors and Fixes

### Error 1: `Cannot find native binding`

Fix:

```powershell
pnpm rebuild
pnpm add lightningcss-win32-x64-msvc -w
```

Then restart dev server.

### Error 2: `PORT environment variable is required`

Set it before running the related service:

```powershell
$env:PORT="5173"   # frontend
# or
$env:PORT="8080"   # api-server
```

### Error 3: `BASE_PATH environment variable is required`

Set base path explicitly before frontend start:

```powershell
$env:BASE_PATH="/"
```

### Error 4: UI looks broken / left-aligned

Likely CSS/native build artifact issue. Fix by:

1. Stopping dev server
2. Running rebuild/native fix commands
3. Starting `pnpm run dev` again in `artifacts/studyflow`

### Error 5: `pnpm dev` (or script) not found

Run frontend command in the correct package directory:

```powershell
cd C:\path\to\algo\artifacts\studyflow
pnpm run dev
```

Or from root with filter:

```powershell
pnpm --filter @workspace/studyflow run dev
```

---

## 10) Verification Checklist

Confirm all of the following:

- [ ] App opens at `http://localhost:5173`
- [ ] You can see the **Today's Mission** UI
- [ ] You can click **Focus mode**
- [ ] Execution screen opens successfully

---

## 11) Optional: Clean Restart Script

Use this when your local setup gets stuck:

```powershell
cd C:\path\to\algo
Remove-Item -Recurse -Force node_modules
Remove-Item -Force pnpm-lock.yaml
setx NODE_OPTIONS ""
# Close and reopen terminal here
corepack enable
corepack prepare pnpm@latest --activate
pnpm install
pnpm rebuild
pnpm add lightningcss-win32-x64-msvc -w
```

Then start API + frontend again using Section 7.
