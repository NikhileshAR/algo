let timerInterval = null;
let manualStartTime = null;

// ─── Boot ─────────────────────────────────────────────────────────────────────

async function boot() {
  const settings = await getSettings();
  if (!settings.apiUrl) {
    show("no-config");
    document.getElementById("open-options").addEventListener("click", () => chrome.runtime.openOptionsPage());
    document.getElementById("options-link").addEventListener("click", () => chrome.runtime.openOptionsPage());
    return;
  }

  show("main");
  document.getElementById("options-link").addEventListener("click", () => chrome.runtime.openOptionsPage());

  await Promise.all([loadSchedule(settings), loadState(), loadRecentLogs()]);
}

// ─── Data fetching ────────────────────────────────────────────────────────────

async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(["apiUrl", "domainMappings"], (r) => {
      resolve({ apiUrl: r.apiUrl || "", domainMappings: r.domainMappings || [] });
    });
  });
}

async function loadSchedule(settings) {
  const list = document.getElementById("schedule-list");
  try {
    const res = await fetch(`${settings.apiUrl}/api/schedule/today`);
    if (!res.ok) throw new Error("API error");
    const data = await res.json();
    renderSchedule(data.blocks || []);
  } catch {
    list.innerHTML = `<div class="no-blocks">Could not load schedule. Check your API URL in settings.</div>`;
  }
}

async function loadState() {
  const state = await chrome.runtime.sendMessage({ type: "GET_STATE" });

  if (state.manualSession) {
    manualStartTime = state.manualSession.startedAt;
    showManualBanner(state.manualSession.topicName, state.manualSession.sessionType);
    startTimerUI();
  }

  if (state.tracking) {
    document.getElementById("tracking-topic-name").textContent = state.tracking.topicName;
    document.getElementById("auto-tracking-banner").style.display = "flex";
  }
}

async function loadRecentLogs() {
  const logs = await chrome.runtime.sendMessage({ type: "GET_RECENT_LOGS" });
  if (!logs || logs.length === 0) return;

  const section = document.getElementById("recent-logs-section");
  const listEl = document.getElementById("recent-logs-list");
  section.style.display = "block";

  listEl.innerHTML = logs.slice(0, 3).map((l) => {
    const ago = timeSince(l.loggedAt);
    return `<div class="log-item"><span class="log-name">${esc(l.topicName)}</span><span class="log-meta">${l.durationMinutes}m · ${ago}</span></div>`;
  }).join("");
}

// ─── Rendering ────────────────────────────────────────────────────────────────

function renderSchedule(blocks) {
  const list = document.getElementById("schedule-list");
  if (blocks.length === 0) {
    list.innerHTML = `<div class="no-blocks">No blocks scheduled today. Open StudyFlow and hit Recalculate.</div>`;
    return;
  }

  list.innerHTML = blocks.map((b, i) => `
    <div class="block-card" data-idx="${i}" data-topic-id="${b.topicId}" data-topic-name="${esc(b.topicName)}" data-session-type="${b.sessionType}">
      <div class="block-header">
        <div>
          <div class="block-name">${esc(b.topicName)}</div>
          <div class="block-meta">
            <span class="badge">${esc(b.subject)}</span>
            <span class="badge badge-primary">${b.sessionType}</span>
            <span class="badge">${b.durationMinutes}m</span>
          </div>
        </div>
      </div>
      <div class="block-mastery">
        <div class="mastery-bar-bg"><div class="mastery-bar" style="width:${Math.round(b.masteryScore * 100)}%"></div></div>
      </div>
      <div class="block-actions">
        <button class="btn btn-primary btn-sm start-btn">▶ Start</button>
      </div>
    </div>
  `).join("");

  list.querySelectorAll(".start-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const card = e.target.closest(".block-card");
      const topicId = parseInt(card.dataset.topicId);
      const topicName = card.dataset.topicName;
      const sessionType = card.dataset.sessionType;

      await chrome.runtime.sendMessage({ type: "START_MANUAL_SESSION", topicId, topicName, sessionType });
      manualStartTime = Date.now();
      showManualBanner(topicName, sessionType);
      startTimerUI();
    });
  });
}

// ─── Timer UI ─────────────────────────────────────────────────────────────────

function showManualBanner(topicName, sessionType) {
  document.getElementById("banner-topic-name").textContent = topicName;
  document.getElementById("banner-session-type").textContent = sessionType + " session";
  document.getElementById("manual-session-banner").style.display = "flex";

  const stopBtn = document.createElement("button");
  stopBtn.className = "btn btn-stop btn-sm";
  stopBtn.textContent = "⏹ Stop & Log";
  stopBtn.style.marginLeft = "auto";
  stopBtn.addEventListener("click", stopSession);

  const banner = document.getElementById("manual-session-banner");
  if (!banner.querySelector(".btn-stop")) banner.appendChild(stopBtn);
}

function startTimerUI() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - (manualStartTime || Date.now())) / 1000);
    const m = Math.floor(elapsed / 60).toString().padStart(2, "0");
    const s = (elapsed % 60).toString().padStart(2, "0");
    document.getElementById("banner-timer").textContent = `${m}:${s}`;
  }, 1000);
}

async function stopSession() {
  clearInterval(timerInterval);
  timerInterval = null;
  manualStartTime = null;

  const result = await chrome.runtime.sendMessage({ type: "STOP_MANUAL_SESSION" });
  document.getElementById("manual-session-banner").style.display = "none";

  if (result.ok) {
    showToast(`✓ Logged ${result.durationMinutes}m · ${result.topicName}`);
    await loadRecentLogs();
  } else {
    showToast("Session cancelled (too short to log)");
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function show(id) {
  ["no-config", "main"].forEach((i) => {
    document.getElementById(i).style.display = i === id ? "block" : "none";
  });
}

function esc(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function timeSince(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function showToast(msg) {
  const t = document.createElement("div");
  t.style.cssText = "position:fixed;bottom:12px;left:50%;transform:translateX(-50%);background:#1b6b7a;color:white;padding:8px 14px;border-radius:8px;font-size:12px;font-weight:500;z-index:999;white-space:nowrap";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

// ─── Init ─────────────────────────────────────────────────────────────────────

boot();
