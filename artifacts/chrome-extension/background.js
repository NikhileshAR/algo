/**
 * StudyFlow Tracker — Background Service Worker
 *
 * Tracks which study-site is active, how long, and auto-posts sessions
 * to the StudyFlow API when the threshold (MIN_SESSION_MINUTES) is met.
 *
 * Distraction-aware: switching to a non-study tab PAUSES the study timer
 * (accumulates distraction time) rather than ending the session. The timer
 * resumes when the user returns to the study tab. Only focused active-study
 * time is posted to the API (#3, #11).
 */

const MIN_SESSION_MINUTES = 2;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(["apiUrl", "domainMappings"], (result) => {
      resolve({
        apiUrl: result.apiUrl || "",
        domainMappings: result.domainMappings || [],
      });
    });
  });
}

async function getSessionState() {
  return new Promise((resolve) => {
    chrome.storage.session.get(["tracking", "manualSession"], (result) => {
      resolve({
        tracking: result.tracking || null,
        manualSession: result.manualSession || null,
      });
    });
  });
}

async function setSessionState(updates) {
  return new Promise((resolve) => chrome.storage.session.set(updates, resolve));
}

function findMapping(domain, mappings) {
  for (const m of mappings) {
    if (domain === m.domain || domain.endsWith("." + m.domain)) return m;
  }
  return null;
}

async function postSession(apiUrl, topicId, activeStudyMinutes, distractionMinutes, sessionType = "lecture") {
  if (!apiUrl || !topicId || activeStudyMinutes < 1) return false;
  try {
    const res = await fetch(`${apiUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        topicId,
        sessionType,
        durationMinutes: activeStudyMinutes,
        distractionMinutes,
        source: "extension",
      }),
    });
    return res.ok;
  } catch (e) {
    console.error("[StudyFlow] Session POST failed:", e);
    return false;
  }
}

// ─── Tracking state shape ─────────────────────────────────────────────────────
//
// tracking = {
//   tabId, url, domain, topicId, topicName,
//   startedAt,            // overall wall-clock start
//   activeStudyMs,        // accumulated focused-study milliseconds (before current segment)
//   distractionMs,        // accumulated distraction milliseconds (before current pause)
//   lastResumedAt,        // when the current study segment started (null if paused)
//   distractionStart,     // when the current distraction segment started (null if studying)
//   isPaused,             // true while user is on a non-study tab
//   settings,
// }

// ─── Core tracking logic ──────────────────────────────────────────────────────

function computeTotals(tracking) {
  const now = Date.now();
  let totalActiveMs = tracking.activeStudyMs;
  let totalDistractionMs = tracking.distractionMs;

  if (!tracking.isPaused && tracking.lastResumedAt) {
    totalActiveMs += now - tracking.lastResumedAt;
  }
  if (tracking.isPaused && tracking.distractionStart) {
    totalDistractionMs += now - tracking.distractionStart;
  }

  return {
    activeStudyMinutes: Math.floor(totalActiveMs / 60000),
    distractionMinutes: Math.floor(totalDistractionMs / 60000),
  };
}

async function finaliseTracking(tracking) {
  if (!tracking) return;

  const { activeStudyMinutes, distractionMinutes } = computeTotals(tracking);

  if (activeStudyMinutes < MIN_SESSION_MINUTES) return;

  const ok = await postSession(
    tracking.settings.apiUrl,
    tracking.topicId,
    activeStudyMinutes,
    distractionMinutes,
  );

  if (ok) {
    const distractionPct = activeStudyMinutes + distractionMinutes > 0
      ? Math.round((distractionMinutes / (activeStudyMinutes + distractionMinutes)) * 100)
      : 0;
    const summary = distractionMinutes > 0
      ? `${activeStudyMinutes}m focused, ${distractionMinutes}m distracted (${distractionPct}%)`
      : `${activeStudyMinutes}m focused`;
    console.log(`[StudyFlow] Auto-logged ${summary} on ${tracking.topicName}`);
    chrome.storage.local.get(["recentAutoLogs"], (r) => {
      const logs = r.recentAutoLogs || [];
      logs.unshift({
        topicName: tracking.topicName,
        durationMinutes: activeStudyMinutes,
        distractionMinutes,
        loggedAt: Date.now(),
      });
      chrome.storage.local.set({ recentAutoLogs: logs.slice(0, 10) });
    });
  }
}

/**
 * Called whenever the active tab changes.
 *
 * If the new tab is a study-mapped site:
 *   - If there's an existing paused session for the SAME topic → resume it
 *   - If there's a session for a DIFFERENT topic → finalise old, start fresh
 *   - If no existing session → start fresh
 *
 * If the new tab is NOT a study-mapped site:
 *   - If there's an active (non-paused) study session → pause it (distraction starts)
 *   - Otherwise → no-op
 */
async function handleTabChange(tabId, url) {
  const settings = await getSettings();
  if (!settings.apiUrl || settings.domainMappings.length === 0) return;

  const domain = extractDomain(url);
  if (!domain) return;

  const mapping = findMapping(domain, settings.domainMappings);
  const { tracking } = await getSessionState();
  const now = Date.now();

  if (!mapping) {
    // Non-study tab activated → pause any active study session
    if (tracking && !tracking.isPaused) {
      const updatedTracking = {
        ...tracking,
        activeStudyMs: tracking.activeStudyMs + (now - tracking.lastResumedAt),
        lastResumedAt: null,
        distractionStart: now,
        isPaused: true,
      };
      await setSessionState({ tracking: updatedTracking });
      console.log(`[StudyFlow] Paused: distraction started on ${domain} (studying ${tracking.topicName})`);
    }
    return;
  }

  // Study tab activated
  if (tracking) {
    if (tracking.topicId === mapping.topicId && tracking.isPaused) {
      // Same study tab → resume
      const distractionSegmentMs = tracking.distractionStart ? now - tracking.distractionStart : 0;
      const updatedTracking = {
        ...tracking,
        distractionMs: tracking.distractionMs + distractionSegmentMs,
        distractionStart: null,
        lastResumedAt: now,
        isPaused: false,
      };
      await setSessionState({ tracking: updatedTracking });
      console.log(`[StudyFlow] Resumed: ${tracking.topicName} (distraction was ${Math.floor(distractionSegmentMs / 60000)}m)`);
      return;
    }

    // Different topic (or same but not paused somehow) → finalise old, start fresh
    await finaliseTracking(tracking);
  }

  // Start a fresh session
  const newTracking = {
    tabId,
    url,
    domain,
    topicId: mapping.topicId,
    topicName: mapping.topicName,
    startedAt: now,
    activeStudyMs: 0,
    distractionMs: 0,
    lastResumedAt: now,
    distractionStart: null,
    isPaused: false,
    settings,
  };
  await setSessionState({ tracking: newTracking });
  console.log(`[StudyFlow] Started tracking: ${mapping.topicName} (${domain})`);
}

async function stopTracking() {
  const { tracking } = await getSessionState();
  if (tracking) {
    await finaliseTracking(tracking);
    await setSessionState({ tracking: null });
  }
}

// ─── Tab event listeners ──────────────────────────────────────────────────────

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.url) await handleTabChange(tabId, tab.url);
  } catch {}
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !tab.url) return;
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (activeTab?.id === tabId) await handleTabChange(tabId, tab.url);
});

chrome.tabs.onRemoved.addListener(async () => {
  await stopTracking();
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    // Window lost focus → treat as distraction (could be another app)
    const { tracking } = await getSessionState();
    if (tracking && !tracking.isPaused) {
      const now = Date.now();
      const updatedTracking = {
        ...tracking,
        activeStudyMs: tracking.activeStudyMs + (now - tracking.lastResumedAt),
        lastResumedAt: null,
        distractionStart: now,
        isPaused: true,
      };
      await setSessionState({ tracking: updatedTracking });
      console.log("[StudyFlow] Window lost focus — pausing study timer");
    }
  } else {
    try {
      const [activeTab] = await chrome.tabs.query({ active: true, windowId });
      if (activeTab?.url) await handleTabChange(activeTab.id, activeTab.url);
    } catch {}
  }
});

chrome.idle.onStateChanged.addListener(async (state) => {
  if (state === "idle" || state === "locked") {
    await stopTracking();
  }
});

// ─── Manual session messages from popup ──────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "START_MANUAL_SESSION") {
    setSessionState({
      manualSession: {
        topicId: msg.topicId,
        topicName: msg.topicName,
        sessionType: msg.sessionType,
        startedAt: Date.now(),
      },
    }).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === "STOP_MANUAL_SESSION") {
    getSessionState().then(async ({ manualSession }) => {
      if (!manualSession) { sendResponse({ ok: false }); return; }
      const settings = await getSettings();
      const elapsedMs = Date.now() - manualSession.startedAt;
      const durationMinutes = Math.max(1, Math.round(elapsedMs / 60000));
      const ok = await postSession(
        settings.apiUrl,
        manualSession.topicId,
        durationMinutes,
        0,
        manualSession.sessionType,
      );
      await setSessionState({ manualSession: null });
      sendResponse({ ok, durationMinutes, topicName: manualSession.topicName });
    });
    return true;
  }

  if (msg.type === "GET_STATE") {
    getSessionState().then((state) => {
      // Enrich with live computed totals so popup can show distraction time
      if (state.tracking) {
        state.tracking = { ...state.tracking, ...computeTotals(state.tracking) };
      }
      sendResponse(state);
    });
    return true;
  }

  if (msg.type === "GET_RECENT_LOGS") {
    chrome.storage.local.get(["recentAutoLogs"], (r) => {
      sendResponse(r.recentAutoLogs || []);
    });
    return true;
  }
});

// ─── Schedule reminder notifications (#17) ────────────────────────────────────

async function scheduleStudyReminders() {
  const settings = await getSettings();
  if (!settings.apiUrl) return;

  try {
    const res = await fetch(`${settings.apiUrl}/api/schedule/today`);
    if (!res.ok) return;
    const data = await res.json();
    const blocks = data.blocks || [];

    const existing = await new Promise((r) => chrome.alarms.getAll(r));
    for (const a of existing) {
      if (a.name.startsWith("reminder_")) chrome.alarms.clear(a.name);
    }

    const now = new Date();
    let cursor = new Date(now);
    cursor.setHours(8, 0, 0, 0);
    if (cursor < now) cursor = new Date(now.getTime() + 15 * 60 * 1000);

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      const reminderTime = new Date(cursor.getTime() - 15 * 60 * 1000);
      if (reminderTime > now) {
        chrome.alarms.create(`reminder_${i}`, { when: reminderTime.getTime() });
        chrome.storage.session.set({ [`reminder_block_${i}`]: block });
      }
      cursor = new Date(cursor.getTime() + block.durationMinutes * 60 * 1000 + 10 * 60 * 1000);
    }
  } catch (e) {
    console.error("[StudyFlow] Could not schedule reminders:", e);
  }
}

function showNotification(title, message) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNjQiIGhlaWdodD0iNjQiIHZpZXdCb3g9IjAgMCA2NCA2NCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iNjQiIGhlaWdodD0iNjQiIHJ4PSIxMiIgZmlsbD0iIzFiNmI3YSIvPjx0ZXh0IHg9IjMyIiB5PSI0NCIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZm9udC1mYW1pbHk9InNhbnMtc2VyaWYiIGZvbnQtd2VpZ2h0PSI3MDAiIGZvbnQtc2l6ZT0iMzYiIGZpbGw9IndoaXRlIj5TPC90ZXh0Pjwvc3ZnPg==",
    title,
    message,
  });
}

// ─── Alarms ───────────────────────────────────────────────────────────────────

chrome.alarms.create("heartbeat", { periodInMinutes: 30 });
chrome.alarms.create("daily-schedule", { when: Date.now() + 5000, periodInMinutes: 60 * 8 });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "heartbeat") {
    const { tracking } = await getSessionState();
    if (tracking) {
      const idleState = await new Promise((r) => chrome.idle.queryState(60, r));
      if (idleState !== "active") await stopTracking();
    }
  }

  if (alarm.name === "daily-schedule") {
    await scheduleStudyReminders();
  }

  if (alarm.name.startsWith("reminder_")) {
    const idx = parseInt(alarm.name.replace("reminder_", ""));
    const key = `reminder_block_${idx}`;
    const data = await new Promise((r) => chrome.storage.session.get([key], r));
    const block = data[key];
    if (block) {
      showNotification(
        `Study time: ${block.topicName}`,
        `${block.durationMinutes}min ${block.sessionType} session starting in 15 minutes — ${Math.round(block.masteryScore * 100)}% current mastery.`,
      );
    }
  }
});

chrome.runtime.onInstalled.addListener(() => scheduleStudyReminders());
chrome.runtime.onStartup.addListener(() => scheduleStudyReminders());
