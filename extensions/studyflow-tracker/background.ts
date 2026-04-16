import { classifyPage, classifyYouTubePage } from "./classifier";

interface SessionState {
  tabId: number;
  url: string;
  title: string;
  startTime: number;
  lastActiveTime: number;
  focusedMs: number;
  idleMs: number;
  switches: number;
  interactionCount: number;
  videoWatchedMs: number;
  videoTotalMs: number;
  videoChannelName: string;
  isIdle: boolean;
}

interface TelemetryEvent {
  id: string;
  timestamp: string;
  url: string;
  title: string;
  topic: string | null;
  isStudy: boolean;
  focusedMs: number;
  idleMs: number;
  tabSwitches: number;
  interactionCount: number;
  videoWatchedMs: number;
  videoTotalMs: number;
  source: "auto";
  weight: 1;
}

const EMIT_INTERVAL_MS = 10_000;
const IDLE_THRESHOLD_SECONDS = 60;

let currentSession: SessionState | null = null;

function now(): number {
  return Date.now();
}

function createSession(tab: chrome.tabs.Tab, switches: number): SessionState | null {
  if (!tab.id || !tab.url) {
    return null;
  }

  return {
    tabId: tab.id,
    url: tab.url,
    title: tab.title ?? "",
    startTime: now(),
    lastActiveTime: now(),
    focusedMs: 0,
    idleMs: 0,
    switches,
    interactionCount: 0,
    videoWatchedMs: 0,
    videoTotalMs: 0,
    videoChannelName: "",
    isIdle: false,
  };
}

function flushElapsed(): void {
  if (!currentSession) {
    return;
  }

  const current = now();
  const delta = Math.max(0, current - currentSession.lastActiveTime);
  if (currentSession.isIdle) {
    currentSession.idleMs += delta;
  } else {
    currentSession.focusedMs += delta;
  }
  currentSession.lastActiveTime = current;
}

async function emitTelemetry(): Promise<void> {
  flushElapsed();

  if (!currentSession) {
    return;
  }

  if (currentSession.focusedMs <= 0) {
    return;
  }

  const pageClassification = classifyPage(currentSession.url, currentSession.title);
  const isYouTube = currentSession.url.includes("youtube.com") || currentSession.url.includes("youtu.be");

  const classification = isYouTube
    ? classifyYouTubePage({ title: currentSession.title, channelName: currentSession.videoChannelName })
    : pageClassification;

  const event: TelemetryEvent = {
    id: `${currentSession.tabId}-${Date.now()}`,
    timestamp: new Date().toISOString(),
    url: currentSession.url,
    title: currentSession.title,
    topic: classification.topic,
    isStudy: classification.isStudy,
    focusedMs: currentSession.focusedMs,
    idleMs: currentSession.idleMs,
    tabSwitches: currentSession.switches,
    interactionCount: currentSession.interactionCount,
    videoWatchedMs: currentSession.videoWatchedMs,
    videoTotalMs: currentSession.videoTotalMs,
    source: "auto",
    weight: 1,
  };

  const key = `studyflow.telemetry.${event.id}`;
  await chrome.storage.local.set({ [key]: event });

  currentSession.focusedMs = 0;
  currentSession.idleMs = 0;
  currentSession.switches = 0;
  currentSession.interactionCount = 0;
  currentSession.videoWatchedMs = 0;
  currentSession.videoTotalMs = 0;
}

function activateTab(tabId: number): void {
  flushElapsed();

  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError || !tab.active) {
      return;
    }

    const switches = (currentSession?.switches ?? 0) + (currentSession ? 1 : 0);
    currentSession = createSession(tab, switches);
  });
}

chrome.idle.setDetectionInterval(IDLE_THRESHOLD_SECONDS);

chrome.tabs.onActivated.addListener(({ tabId }) => {
  activateTab(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!currentSession || currentSession.tabId !== tabId) {
    return;
  }
  if (changeInfo.url) {
    currentSession.url = changeInfo.url;
  }
  if (changeInfo.title) {
    currentSession.title = changeInfo.title;
  } else if (tab.title) {
    currentSession.title = tab.title;
  }
});

chrome.idle.onStateChanged.addListener((state) => {
  flushElapsed();
  if (!currentSession) {
    return;
  }
  currentSession.isIdle = state !== "active";
});

chrome.runtime.onMessage.addListener((message) => {
  if (!currentSession || typeof message !== "object" || message === null) {
    return;
  }

  if (message.type === "STUDYFLOW_INTERACTION") {
    const count = typeof message.interactionCount === "number" ? message.interactionCount : 0;
    currentSession.interactionCount = count;

    if (typeof message.pageTitle === "string" && message.pageTitle.length > 0) {
      currentSession.title = message.pageTitle;
    }
    if (typeof message.videoTitle === "string" && message.videoTitle.length > 0) {
      currentSession.title = message.videoTitle;
    }
    if (typeof message.channelName === "string" && message.channelName.length > 0) {
      currentSession.videoChannelName = message.channelName;
    }
    if (typeof message.url === "string" && message.url.length > 0) {
      currentSession.url = message.url;
    }

    if (typeof message.watchedMs === "number") {
      currentSession.videoWatchedMs = Math.max(0, message.watchedMs);
    }
    if (typeof message.totalMs === "number") {
      currentSession.videoTotalMs = Math.max(0, message.totalMs);
    }
  }
});

setInterval(() => {
  void emitTelemetry();
}, EMIT_INTERVAL_MS);
