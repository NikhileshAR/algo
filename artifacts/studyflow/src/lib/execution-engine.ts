/**
 * Behavioral Execution Engine — Pure functions and types.
 *
 * This module provides the state-machine types and deterministic helper
 * functions that drive the guided execution flow.  It deliberately has
 * NO side-effects and does NOT import any scheduling or control-loop
 * modules — it is a pure translation layer.
 */

// ---------------------------------------------------------------------------
// Phase state machine
// ---------------------------------------------------------------------------

export type ExecutionPhase =
  | "pre_start"      // Block info visible, single CTA "Start session"
  | "active"         // Timer running, optional notes
  | "interrupted"    // Session was left mid-way — resume or abandon prompt
  | "post_session"   // Completion check + self-rating
  | "on_break"       // Break timer before next block
  | "complete";      // All blocks for today done

export type CompletionStatus = "yes" | "partial" | "no";

/** 1 = very poor, 5 = excellent */
export type UnderstandingRating = 1 | 2 | 3 | 4 | 5;

// ---------------------------------------------------------------------------
// Momentum state (behavioral layer — not the same as discipline)
// ---------------------------------------------------------------------------

export type MomentumState = "none" | "building" | "strong" | "broken" | "recovering";

/** Maximum consecutive sessions before "strong" momentum is reached */
const STRONG_MOMENTUM_THRESHOLD = 3;

export function computeMomentumState(
  consecutiveCompleted: number,
  lastWasInterrupted: boolean,
): MomentumState {
  if (lastWasInterrupted) return "broken";
  if (consecutiveCompleted === 0) return "none";
  if (consecutiveCompleted === 1) return "building";
  if (consecutiveCompleted >= STRONG_MOMENTUM_THRESHOLD) return "strong";
  return "building";
}

export function momentumLabel(state: MomentumState): string {
  switch (state) {
    case "none": return "Ready to start";
    case "building": return "Momentum building";
    case "strong": return "Strong momentum";
    case "broken": return "Momentum broken";
    case "recovering": return "Recovery started";
  }
}

// ---------------------------------------------------------------------------
// Micro-commitment window
// ---------------------------------------------------------------------------

/** Seconds the user must spend before "End early" becomes fully available.
 * 10 minutes is the minimum commitment designed to overcome initial friction
 * and ensure a meaningful study attempt before the user can exit. */
export const COMMITMENT_WINDOW_SECONDS = 10 * 60;

export function isInCommitmentWindow(elapsedSeconds: number): boolean {
  return elapsedSeconds < COMMITMENT_WINDOW_SECONDS;
}

export function commitmentWindowRemainingSeconds(elapsedSeconds: number): number {
  return Math.max(0, COMMITMENT_WINDOW_SECONDS - elapsedSeconds);
}

// ---------------------------------------------------------------------------
// Break duration recommendation
// ---------------------------------------------------------------------------

/**
 * Returns suggested break duration in minutes based on session length and
 * recent fatigue signals (low self-rating = more fatigue).
 */
export function computeBreakMinutes(
  sessionMinutes: number,
  completedSessionsToday: number,
  lastRating: UnderstandingRating | null,
): number {
  let base = 0;

  if (sessionMinutes >= 90) {
    base = 15;
  } else if (sessionMinutes >= 45) {
    base = 10;
  } else if (sessionMinutes >= 25) {
    base = 5;
  }

  // After 3+ sessions add extra rest
  if (completedSessionsToday >= 3) {
    base += 5;
  }

  // Low self-rating signals fatigue
  if (lastRating !== null && lastRating <= 2) {
    base += 5;
  }

  return base;
}

// ---------------------------------------------------------------------------
// Adaptive hint overlay
// ---------------------------------------------------------------------------

/**
 * Returns a temporary overlay message for the NEXT block based on the
 * previous session's self-rating.  This is purely UI text — it does NOT
 * modify any scheduler state.
 */
export function computeAdaptiveOverlay(
  rating: UnderstandingRating | null,
  sessionType: "lecture" | "practice",
): string | null {
  if (rating === null) return null;

  if (rating <= 2) {
    return sessionType === "practice"
      ? "Last session was tough — start with a brief review before attempting problems."
      : "Last session was challenging — go slower, prioritise understanding over coverage.";
  }

  if (rating >= 4) {
    return sessionType === "practice"
      ? "Strong last session — push for harder problem variants and time yourself."
      : "Great last session — focus on edge cases and connections to other topics.";
  }

  return null;
}

// ---------------------------------------------------------------------------
// Execution analytics helpers
// ---------------------------------------------------------------------------

/**
 * Calculates the delay in seconds between when the execution page was
 * opened and when "Start session" was clicked.
 */
export function computeStartDelaySeconds(openedAt: number, startedAt: number): number {
  return Math.max(0, Math.round((startedAt - openedAt) / 1000));
}

/**
 * Computes an effective completion ratio for discipline/gap tracking:
 * yes = 1.0, partial = 0.5, no = 0.0
 */
export function completionRatio(status: CompletionStatus): number {
  if (status === "yes") return 1.0;
  if (status === "partial") return 0.5;
  return 0.0;
}

// ---------------------------------------------------------------------------
// Persistence keys (sessionStorage)
// ---------------------------------------------------------------------------

/** Key for persisting an in-progress session across page navigations */
export const ACTIVE_SESSION_STORAGE_KEY = "sf_active_execution";

export interface PersistedExecution {
  blockIndex: number;
  topicId: number;
  topicName: string;
  sessionType: "lecture" | "practice";
  startedAt: number;  // epoch ms
  elapsedSeconds: number;
}

export function saveActiveExecution(data: PersistedExecution): void {
  try {
    sessionStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, JSON.stringify(data));
  } catch {
    // Ignore storage errors (private browsing etc.)
  }
}

export function loadActiveExecution(): PersistedExecution | null {
  try {
    const raw = sessionStorage.getItem(ACTIVE_SESSION_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as PersistedExecution;
  } catch {
    return null;
  }
}

export function clearActiveExecution(): void {
  try {
    sessionStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY);
  } catch {
    // Ignore
  }
}

/** Key for tracking today's consecutive completed sessions */
export const MOMENTUM_STORAGE_KEY = "sf_momentum";

export interface MomentumData {
  date: string;                    // ISO date "YYYY-MM-DD"
  consecutiveCompleted: number;
  lastWasInterrupted: boolean;
}

export function loadMomentumData(today: string): MomentumData {
  try {
    const raw = localStorage.getItem(MOMENTUM_STORAGE_KEY);
    if (!raw) return { date: today, consecutiveCompleted: 0, lastWasInterrupted: false };
    const data = JSON.parse(raw) as MomentumData;
    // Reset if it's a new day
    if (data.date !== today) return { date: today, consecutiveCompleted: 0, lastWasInterrupted: false };
    return data;
  } catch {
    return { date: today, consecutiveCompleted: 0, lastWasInterrupted: false };
  }
}

export function saveMomentumData(data: MomentumData): void {
  try {
    localStorage.setItem(MOMENTUM_STORAGE_KEY, JSON.stringify(data));
  } catch {
    // Ignore
  }
}

/** Key for cross-block self-rating persistence */
export const LAST_RATING_STORAGE_KEY = "sf_last_rating";

export function saveLastRating(rating: UnderstandingRating): void {
  try {
    sessionStorage.setItem(LAST_RATING_STORAGE_KEY, String(rating));
  } catch {
    // Ignore
  }
}

export function loadLastRating(): UnderstandingRating | null {
  try {
    const raw = sessionStorage.getItem(LAST_RATING_STORAGE_KEY);
    if (!raw) return null;
    const n = parseInt(raw, 10);
    if (n >= 1 && n <= 5) return n as UnderstandingRating;
    return null;
  } catch {
    return null;
  }
}
