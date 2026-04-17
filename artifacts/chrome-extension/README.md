# StudyFlow Tracker — Chrome Extension

Passive study tracking for StudyFlow. The extension watches which websites you visit, automatically detects study sessions, and logs them directly to your StudyFlow account — no manual input required.

## Features

- **Passive tracking** — visits to study-related domains (Khan Academy, YouTube lectures, Coursera, etc.) are automatically timed and logged
- **Auto-logging** — sessions longer than 2 minutes are posted to the StudyFlow API on tab switch or browser close
- **Manual sessions** — click ▶ Start on any schedule block in the popup to begin a timed session; Stop & Log pre-fills the duration automatically
- **Schedule popup** — see today's blocks without opening the full web app

## Installation

1. Download or clone this folder (`chrome-extension/`)
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** (top right toggle)
4. Click **Load unpacked** and select the `chrome-extension/` folder
5. The StudyFlow icon will appear in your toolbar

## Setup

1. Click the extension icon → Settings (⚙)
2. Enter your **StudyFlow API URL** (e.g. `http://localhost:8080`)
3. Click **Test connection** — it should show "✓ Connected"
4. Under **Domain → Topic Mapping**, add the study sites you use:
   - Domain: `khanacademy.org`
   - Topic: select from your curriculum (e.g. "Differential Equations")
5. Save settings

## How auto-tracking works

When you switch to a mapped domain, the background service worker starts a timer. When you switch away (or the browser loses focus / you go idle), it:
1. Calculates the elapsed time
2. If ≥ 2 minutes: POSTs a lecture session to `/api/sessions`
3. Shows the auto-log in the "Recently auto-logged" section of the popup

The discipline score and capacity model in StudyFlow then update from real browsing data, not self-reported numbers.

## CSV quick import

Add many topics at once from the StudyFlow web app. Go to **Topics → Import CSV** with this format:

```csv
name,subject,difficulty,estimatedHours,mastery
Differential Equations,Mathematics,4,20,0.1
Organic Chemistry,Chemistry,4,25,0
Thermodynamics,Physics,3,16,0.2
```

## Permissions used

| Permission | Why |
|---|---|
| `tabs` | Read the active tab URL to detect study sites |
| `storage` | Save your API URL and domain mappings |
| `alarms` | Periodic heartbeat to handle long idle sessions |
| `idle` | Detect when you step away from the computer |
| `host_permissions: <all_urls>` | Make API calls to your StudyFlow server |
