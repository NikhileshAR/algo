/**
 * LocalDbContext — Phase 1
 *
 * React context that owns the lifecycle of the local IndexedDB store.
 * Provides:
 *   - Initialization state (ready / initializing / error)
 *   - Reactive data for profile, topics, sessions, and today's schedule
 *   - Mutation helpers (addTopic, logSession, computeSchedule, etc.)
 *   - Server migration status and trigger
 *   - Nightly scheduler lifecycle
 *
 * Design:
 *   All state is sourced from IndexedDB. There is no server dependency for
 *   reading or writing data. The server may be present as a sync target in
 *   a later phase, but this context operates entirely offline.
 *
 *   Manual session logging is permitted as a fallback but is flagged with
 *   qualityWeight = 0.5 so it contributes less to model updates.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";

import { openStudyFlowDB } from "@/lib/local-db/idb";
import {
  ProfileRepo,
  TopicsRepo,
  SessionsRepo,
  SchedulesRepo,
  TelemetryRepo,
  OverridesRepo,
  MetaRepo,
} from "@/lib/local-db/repositories";
import { ensureTodaySchedule, requestOverride, DAILY_OVERRIDE_LIMIT } from "@/lib/local-db/nightly";
import {
  checkServerAvailable,
  serverHasProfile,
  getMigrationStatus,
  importFromServer,
  skipMigration,
} from "@/lib/local-db/migrate-from-server";
import { applyMasteryUpdate, computeSessionQuality } from "@/lib/local-db/scheduler-algo";
import type {
  LocalStudentProfile,
  LocalTopic,
  LocalStudySession,
  LocalDailySchedule,
  LocalTelemetryEvent,
  MigrationResult,
  MigrationStatus,
  SessionSource,
} from "@/lib/local-db/schema";

// ─── Context value type ───────────────────────────────────────────────────────

interface LocalDbContextValue {
  // ── Initialization ──────────────────────────────────────────────────────
  ready: boolean;
  initError: string | null;

  // ── Profile ─────────────────────────────────────────────────────────────
  profile: LocalStudentProfile | null;
  saveProfile: (
    data: Omit<LocalStudentProfile, "id" | "createdAt" | "updatedAt">,
  ) => Promise<LocalStudentProfile>;
  patchProfile: (
    updates: Partial<Omit<LocalStudentProfile, "id" | "createdAt">>,
  ) => Promise<LocalStudentProfile | null>;

  // ── Topics ───────────────────────────────────────────────────────────────
  topics: LocalTopic[];
  addTopic: (
    data: Omit<LocalTopic, "id" | "createdAt" | "updatedAt" | "confidenceScore" | "priorityScore" | "testsCount">,
  ) => Promise<LocalTopic>;
  updateTopic: (id: string, updates: Partial<Omit<LocalTopic, "id" | "createdAt">>) => Promise<void>;
  deleteTopic: (id: string) => Promise<void>;

  // ── Sessions ─────────────────────────────────────────────────────────────
  sessions: LocalStudySession[];
  logSession: (data: {
    topicId: string;
    topicName: string;
    sessionType: "lecture" | "practice";
    durationMinutes: number;
    distractionMinutes?: number;
    source: SessionSource;
    testScore?: number | null;
    testScoreMax?: number | null;
    notes?: string | null;
    studiedAt?: string;
    focusRatio?: number;
    interactionCount?: number;
  }) => Promise<LocalStudySession>;

  // ── Schedule ─────────────────────────────────────────────────────────────
  todaySchedule: LocalDailySchedule | null;
  /** Trigger a manual override recalculation. Rate-limited to once/day. */
  overrideSchedule: (reason?: string) => Promise<
    | { schedule: LocalDailySchedule; overrideCount: number }
    | { blocked: true; overrideCount: number }
  >;
  overrideLimitPerDay: number;
  overrideCountToday: number;

  // ── Migration ────────────────────────────────────────────────────────────
  migrationStatus: MigrationStatus | null;
  serverApiUrl: string | null;
  runMigration: (apiUrl: string) => Promise<MigrationResult>;
  skipServerMigration: () => Promise<void>;

  // ── Telemetry ────────────────────────────────────────────────────────────
  appendTelemetryEvent: (event: Omit<LocalTelemetryEvent, "id">) => Promise<void>;

  // ── Refresh ──────────────────────────────────────────────────────────────
  refresh: () => Promise<void>;
}

// ─── Context ──────────────────────────────────────────────────────────────────

const LocalDbContext = createContext<LocalDbContextValue | null>(null);

export function useLocalDb(): LocalDbContextValue {
  const ctx = useContext(LocalDbContext);
  if (!ctx) {
    throw new Error("useLocalDb must be used inside <LocalDbProvider>");
  }
  return ctx;
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export function LocalDbProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);

  const [profile, setProfile] = useState<LocalStudentProfile | null>(null);
  const [topics, setTopics] = useState<LocalTopic[]>([]);
  const [sessions, setSessions] = useState<LocalStudySession[]>([]);
  const [todaySchedule, setTodaySchedule] = useState<LocalDailySchedule | null>(null);
  const [migrationStatus, setMigrationStatus] = useState<MigrationStatus | null>(null);
  const [serverApiUrl, setServerApiUrl] = useState<string | null>(null);
  const [overrideCountToday, setOverrideCountToday] = useState(0);

  // ── Load all data from IndexedDB ──────────────────────────────────────────
  const loadAll = useCallback(async () => {
    const [p, t, s, sched] = await Promise.all([
      ProfileRepo.get(),
      TopicsRepo.list(),
      SessionsRepo.list(100),
      SchedulesRepo.getToday(),
    ]);
    setProfile(p);
    setTopics(t);
    setSessions(s);
    setTodaySchedule(sched);
  }, []);

  // ── Initialize on mount ───────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        // Open DB (creates object stores if first run)
        await openStudyFlowDB();

        if (cancelled) return;
        await loadAll();

        // ── Lazy schedule: compute today's schedule on first open ──────────
        // This replaces the old "setTimeout at 11pm" approach. The schedule
        // is generated deterministically the first time the user opens the
        // app on any given day. If the schedule already exists, this is a no-op.
        ensureTodaySchedule(async (newSchedule) => {
          if (!cancelled) {
            setTodaySchedule(newSchedule);
            const updatedTopics = await TopicsRepo.list();
            setTopics(updatedTopics);
          }
        }).catch((err) => {
          if (!cancelled) {
            // Non-fatal: schedule compute failed. App still works, user can
            // trigger a manual recalculation via the override button.
            console.error("[StudyFlow] Lazy schedule compute failed:", err);
            setInitError(
              err instanceof Error
                ? `Schedule compute failed: ${err.message}`
                : "Schedule compute failed — tap Recalculate to retry.",
            );
          }
        });

        // Mark the app as ready immediately — DO NOT wait for the server check.
        // The server check is purely for the optional one-time migration banner.
        if (!cancelled) setReady(true);

        // ── Server migration discovery (fire-and-forget) ───────────────────
        // This must never block the ready state or any core flow.
        const storedMigration = await getMigrationStatus();
        if (storedMigration) {
          if (!cancelled) setMigrationStatus(storedMigration);
        } else {
          // Try to discover the server — non-blocking, best-effort
          try {
            const guessedUrl = window.location.origin;
            const available = await checkServerAvailable(guessedUrl);
            if (available && !cancelled) {
              const hasProfile = await serverHasProfile(guessedUrl);
              if (hasProfile && !cancelled) {
                setServerApiUrl(guessedUrl);
                setMigrationStatus("available");
              }
            }
          } catch {
            // Server not reachable — that's fine; app works fully offline
          }
        }
      } catch (err) {
        if (!cancelled) {
          setInitError(err instanceof Error ? err.message : "Failed to open local database");
          setReady(true);
        }
      }
    }

    void init();

    return () => {
      cancelled = true;
    };
  }, [loadAll]);

  // ── Load today's override count on ready ──────────────────────────────────
  useEffect(() => {
    if (!ready) return;
    OverridesRepo.countToday().then(setOverrideCountToday).catch(() => {});
  }, [ready, todaySchedule]);

  // ── Profile mutations ─────────────────────────────────────────────────────
  const saveProfile = useCallback(
    async (data: Omit<LocalStudentProfile, "id" | "createdAt" | "updatedAt">) => {
      const p = await ProfileRepo.save(data);
      setProfile(p);
      return p;
    },
    [],
  );

  const patchProfile = useCallback(
    async (updates: Partial<Omit<LocalStudentProfile, "id" | "createdAt">>) => {
      const p = await ProfileRepo.patch(updates);
      if (p) setProfile(p);
      return p;
    },
    [],
  );

  // ── Topic mutations ───────────────────────────────────────────────────────
  const addTopic = useCallback(
    async (data: Omit<LocalTopic, "id" | "createdAt" | "updatedAt" | "confidenceScore" | "priorityScore" | "testsCount">) => {
      const t = await TopicsRepo.create(data);
      setTopics(await TopicsRepo.list());
      return t;
    },
    [],
  );

  const updateTopic = useCallback(async (id: string, updates: Partial<Omit<LocalTopic, "id" | "createdAt">>) => {
    await TopicsRepo.update(id, updates);
    setTopics(await TopicsRepo.list());
  }, []);

  const deleteTopic = useCallback(async (id: string) => {
    await TopicsRepo.delete(id);
    setTopics(await TopicsRepo.list());
  }, []);

  // ── Session logging ───────────────────────────────────────────────────────
  const logSession = useCallback(
    async (data: {
      topicId: string;
      topicName: string;
      sessionType: "lecture" | "practice";
      durationMinutes: number;
      distractionMinutes?: number;
      source: SessionSource;
      testScore?: number | null;
      testScoreMax?: number | null;
      notes?: string | null;
      studiedAt?: string;
      focusRatio?: number;
      interactionCount?: number;
    }): Promise<LocalStudySession> => {
      const source = data.source;
      const qualityWeight: number = source === "manual" ? 0.5 : 1.0;
      const distractionMinutes = data.distractionMinutes ?? 0;
      const durationMinutes = data.durationMinutes;
      const focusRatio =
        data.focusRatio ??
        (durationMinutes + distractionMinutes > 0
          ? durationMinutes / (durationMinutes + distractionMinutes)
          : 1);
      const qualityScore = computeSessionQuality({
        focusRatio,
        interactionCount: data.interactionCount ?? 0,
        focusedMinutes: durationMinutes,
      });

      const session = await SessionsRepo.create({
        topicId: data.topicId,
        topicName: data.topicName,
        sessionType: data.sessionType,
        durationMinutes,
        distractionMinutes,
        source,
        qualityWeight,
        focusRatio,
        qualityScore,
        testScore: data.testScore ?? null,
        testScoreMax: data.testScoreMax ?? null,
        notes: data.notes ?? null,
        studiedAt: data.studiedAt ?? new Date().toISOString(),
      });

      // Update topic's lastStudiedAt
      await TopicsRepo.update(data.topicId, {
        lastStudiedAt: session.studiedAt,
      });

      // Apply mastery update for practice sessions with test scores
      if (
        data.sessionType === "practice" &&
        data.testScore != null &&
        data.testScoreMax != null
      ) {
        const topic = await TopicsRepo.get(data.topicId);
        if (topic) {
          const { masteryAfter, confidenceAfter } = applyMasteryUpdate(
            topic.masteryScore,
            topic.testsCount,
            data.testScore,
            data.testScoreMax,
            qualityWeight,
          );
          await TopicsRepo.update(data.topicId, {
            masteryScore: masteryAfter,
            confidenceScore: confidenceAfter,
            testsCount: topic.testsCount + 1,
          });
        }
      }

      // Update profile capacity and discipline (weighted)
      // Aggregate all sessions from today to compute actual vs scheduled ratio.
      const prof = await ProfileRepo.get();
      if (prof) {
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const todaySessionsAll = await SessionsRepo.listSince(todayStart.toISOString());
        const todayFocusedHours = todaySessionsAll.reduce(
          (sum, s) => sum + (s.durationMinutes / 60) * s.qualityWeight,
          0,
        );
        const newCapacity = 0.8 * prof.capacityScore + 0.2 * todayFocusedHours;
        // D = focused hours today / scheduled hours (capped at 1)
        const scheduledHours = Math.max(prof.dailyTargetHours, 0.1);
        const newDiscipline = Math.min(todayFocusedHours / scheduledHours, 1);
        await ProfileRepo.patch({
          capacityScore: newCapacity,
          disciplineScore: newDiscipline,
        });
      }

      // Reload reactive state
      setSessions(await SessionsRepo.list(100));
      setTopics(await TopicsRepo.list());
      const p = await ProfileRepo.get();
      if (p) setProfile(p);

      return session;
    },
    [],
  );

  // ── Schedule override ────────────────────────────────────────────────────
  const overrideSchedule = useCallback(async (reason?: string) => {
    const result = await requestOverride(reason ?? null);
    if (!("blocked" in result)) {
      setTodaySchedule(result.schedule);
      setTopics(await TopicsRepo.list());
      const p = await ProfileRepo.get();
      if (p) setProfile(p);
      setOverrideCountToday(result.overrideCount);
    } else {
      setOverrideCountToday(result.overrideCount);
    }
    return result;
  }, []);

  // ── Migration ─────────────────────────────────────────────────────────────
  const runMigration = useCallback(async (apiUrl: string): Promise<MigrationResult> => {
    setMigrationStatus("running");
    const migResult = await importFromServer(apiUrl);
    setMigrationStatus(migResult.status);
    if (migResult.status === "done") {
      await loadAll();
    }
    return migResult;
  }, [loadAll]);

  const skipServerMigration = useCallback(async () => {
    await skipMigration();
    setMigrationStatus("skipped");
  }, []);

  // ── Telemetry ─────────────────────────────────────────────────────────────
  const appendTelemetryEvent = useCallback(
    async (event: Omit<LocalTelemetryEvent, "id">) => {
      await TelemetryRepo.appendEvent(event);
    },
    [],
  );

  // ── Refresh ───────────────────────────────────────────────────────────────
  const refresh = useCallback(async () => {
    await loadAll();
  }, [loadAll]);

  const value: LocalDbContextValue = {
    ready,
    initError,
    profile,
    saveProfile,
    patchProfile,
    topics,
    addTopic,
    updateTopic,
    deleteTopic,
    sessions,
    logSession,
    todaySchedule,
    overrideSchedule,
    overrideLimitPerDay: DAILY_OVERRIDE_LIMIT,
    overrideCountToday,
    migrationStatus,
    serverApiUrl,
    runMigration,
    skipServerMigration,
    appendTelemetryEvent,
    refresh,
  };

  return (
    <LocalDbContext.Provider value={value}>
      {children}
    </LocalDbContext.Provider>
  );
}

export { LocalDbContext };
