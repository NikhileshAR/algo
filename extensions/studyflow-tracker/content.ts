interface YouTubeTelemetry {
  videoTitle: string;
  channelName: string;
  watchedMs: number;
  totalMs: number;
}

let interactionCount = 0;
let lastVideoTime = 0;
let watchedMs = 0;
let totalMs = 0;
let lastEmitAt = Date.now();

function postToBackground(payload: Record<string, unknown>): void {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
    return;
  }
  chrome.runtime.sendMessage(payload, () => {
    void chrome.runtime.lastError;
  });
}

function postToWindow(payload: Record<string, unknown>): void {
  window.postMessage({ source: "studyflow-tracker", ...payload }, window.location.origin);
}

function detectYouTubeMeta(): YouTubeTelemetry | null {
  if (!location.hostname.includes("youtube.com")) {
    return null;
  }

  const title = (document.querySelector("h1.ytd-watch-metadata yt-formatted-string") as HTMLElement | null)?.innerText
    ?? document.title
    ?? "";
  const channel = (document.querySelector("#owner #channel-name a") as HTMLElement | null)?.innerText
    ?? (document.querySelector("ytd-channel-name a") as HTMLElement | null)?.innerText
    ?? "";

  const video = document.querySelector("video") as HTMLVideoElement | null;
  if (video) {
    totalMs = Number.isFinite(video.duration) && video.duration > 0 ? Math.floor(video.duration * 1000) : 0;
    const currentMs = Math.floor(video.currentTime * 1000);
    if (currentMs > lastVideoTime) {
      watchedMs += currentMs - lastVideoTime;
    }
    lastVideoTime = currentMs;
  }

  return {
    videoTitle: title,
    channelName: channel,
    watchedMs,
    totalMs,
  };
}

function emitInteraction(): void {
  const yt = detectYouTubeMeta();
  const now = Date.now();
  const delta = Math.max(0, now - lastEmitAt);
  lastEmitAt = now;
  const focusedMs = document.visibilityState === "visible" ? delta : 0;

  const payload = {
    type: "STUDYFLOW_INTERACTION",
    interactionCount,
    pageTitle: document.title,
    url: location.href,
    ...yt,
  };
  const telemetryPayload = {
    type: "STUDYFLOW_TELEMETRY_EVENT",
    timestamp: new Date().toISOString(),
    url: location.href,
    title: document.title,
    topic: null,
    isStudy: false,
    focusedMs,
    idleMs: 0,
    tabSwitches: 0,
    interactionCount,
    videoWatchedMs: yt?.watchedMs ?? 0,
    videoTotalMs: yt?.totalMs ?? 0,
    source: "auto",
    weight: 1,
  };
  postToBackground(payload);
  postToBackground(telemetryPayload);
  postToWindow(payload);
  postToWindow(telemetryPayload);
}

function setupInteractionTracking(): void {
  const bump = (): void => {
    interactionCount += 1;
  };

  ["click", "keydown", "scroll", "mousemove"].forEach((eventName) => {
    window.addEventListener(eventName, bump, { passive: true });
  });

  setInterval(() => {
    emitInteraction();
  }, 10000);
}

setupInteractionTracking();
