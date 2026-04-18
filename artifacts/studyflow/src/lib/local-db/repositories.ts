/**
 * Repository layer — Phase 1
 *
 * Thin CRUD wrappers over the IndexedDB primitives. Each repository
 * encapsulates all reads/writes for a single entity type.
 *
 * All IDs are local UUIDs. Timestamps are ISO-8601 strings.
 */

import {
  getAllFromStore,
  getByKey,
  getByIndex,
  getByIndexRange,
  putRecord,
  deleteRecord,
} from "./idb";
import {
  STORE,
  type LocalStudentProfile,
  type LocalTopic,
  type LocalStudySession,
  type LocalDailySchedule,
  type LocalTelemetryEvent,
  type LocalScheduleOverride,
  type TelemetrySummary,
  type MetaKey,
  type MetaRecord,
} from "./schema";

function uuid(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

function todayStr(): string {
  return new Date().toISOString().split("T")[0];
}

// ─── Profile repository ───────────────────────────────────────────────────────

export const ProfileRepo = {
  async get(): Promise<LocalStudentProfile | null> {
    const all = await getAllFromStore<LocalStudentProfile>(STORE.PROFILE);
    return all[0] ?? null;
  },

  async save(data: Omit<LocalStudentProfile, "id" | "createdAt" | "updatedAt">): Promise<LocalStudentProfile> {
    const existing = await this.get();
    const profile: LocalStudentProfile = {
      id: existing?.id ?? uuid(),
      createdAt: existing?.createdAt ?? now(),
      ...data,
      updatedAt: now(),
    };
    await putRecord(STORE.PROFILE, profile);
    return profile;
  },

  async patch(updates: Partial<Omit<LocalStudentProfile, "id" | "createdAt">>): Promise<LocalStudentProfile | null> {
    const existing = await this.get();
    if (!existing) return null;
    const updated: LocalStudentProfile = { ...existing, ...updates, updatedAt: now() };
    await putRecord(STORE.PROFILE, updated);
    return updated;
  },
};

// ─── Topics repository ────────────────────────────────────────────────────────

export const TopicsRepo = {
  async list(): Promise<LocalTopic[]> {
    const topics = await getAllFromStore<LocalTopic>(STORE.TOPICS);
    // Return sorted descending by priorityScore
    return topics.sort((a, b) => b.priorityScore - a.priorityScore);
  },

  async get(id: string): Promise<LocalTopic | null> {
    return (await getByKey<LocalTopic>(STORE.TOPICS, id)) ?? null;
  },

  async create(
    data: Omit<LocalTopic, "id" | "createdAt" | "updatedAt" | "confidenceScore" | "priorityScore" | "testsCount">,
  ): Promise<LocalTopic> {
    const topic: LocalTopic = {
      id: uuid(),
      confidenceScore: 0,
      priorityScore: 0,
      testsCount: 0,
      createdAt: now(),
      updatedAt: now(),
      ...data,
    };
    await putRecord(STORE.TOPICS, topic);
    return topic;
  },

  async update(id: string, updates: Partial<Omit<LocalTopic, "id" | "createdAt">>): Promise<LocalTopic | null> {
    const existing = await this.get(id);
    if (!existing) return null;
    const updated: LocalTopic = { ...existing, ...updates, updatedAt: now() };
    await putRecord(STORE.TOPICS, updated);
    return updated;
  },

  async delete(id: string): Promise<void> {
    await deleteRecord(STORE.TOPICS, id);
  },

  async bulkCreate(items: Array<Omit<LocalTopic, "id" | "createdAt" | "updatedAt" | "confidenceScore" | "priorityScore" | "testsCount">>): Promise<LocalTopic[]> {
    const created: LocalTopic[] = [];
    for (const item of items) {
      created.push(await this.create(item));
    }
    return created;
  },
};

// ─── Sessions repository ──────────────────────────────────────────────────────

export const SessionsRepo = {
  async list(limit = 200): Promise<LocalStudySession[]> {
    const all = await getAllFromStore<LocalStudySession>(STORE.SESSIONS);
    return all
      .sort((a, b) => b.studiedAt.localeCompare(a.studiedAt))
      .slice(0, limit);
  },

  async listByTopic(topicId: string): Promise<LocalStudySession[]> {
    const sessions = await getByIndex<LocalStudySession>(STORE.SESSIONS, "topicId", topicId);
    return sessions.sort((a, b) => b.studiedAt.localeCompare(a.studiedAt));
  },

  async listSince(isoDate: string): Promise<LocalStudySession[]> {
    const range = IDBKeyRange.lowerBound(isoDate);
    const sessions = await getByIndexRange<LocalStudySession>(STORE.SESSIONS, "studiedAt", range);
    return sessions.sort((a, b) => b.studiedAt.localeCompare(a.studiedAt));
  },

  async get(id: string): Promise<LocalStudySession | null> {
    return (await getByKey<LocalStudySession>(STORE.SESSIONS, id)) ?? null;
  },

  async create(
    data: Omit<LocalStudySession, "id" | "createdAt">,
  ): Promise<LocalStudySession> {
    const session: LocalStudySession = {
      id: uuid(),
      createdAt: now(),
      ...data,
    };
    await putRecord(STORE.SESSIONS, session);
    return session;
  },

  /** Compute quality weight based on source */
  sourceWeight(source: LocalStudySession["source"]): number {
    return source === "manual" ? 0.5 : 1.0;
  },

  /**
   * Detect and resolve overlapping sessions (multi-device conflict resolution).
   *
   * Each session spans [studiedAt, studiedAt + durationMinutes).
   * Overlapping sessions are resolved by these rules:
   *
   *   Rule A — Same topic, overlapping time:
   *     Merge into one session. Keep:
   *       - max(focusedTime) as durationMinutes (don't double-count)
   *       - source = higher-quality source (auto > extension > manual)
   *       - qualityScore = max of both
   *     Rationale: one device tracked what the other missed; take the best.
   *
   *   Rule B — Different topics, overlapping time:
   *     The student cannot genuinely study two topics simultaneously.
   *     Keep both sessions but reduce each by the overlap duration so that
   *     total credited time = actual wall-clock time.
   *     Log a ConflictRecord for auditability.
   *
   * Returns:
   *   resolved   — deduplicated / trimmed sessions (input is NOT modified)
   *   conflicts  — list of detected overlaps with the applied rule
   *
   * This is a pure function — does NOT write to IndexedDB. Call site must
   * persist the resolved list if desired.
   */
  resolveOverlaps(sessions: LocalStudySession[]): {
    resolved: LocalStudySession[];
    conflicts: Array<{
      sessionA: LocalStudySession;
      sessionB: LocalStudySession;
      overlapMinutes: number;
      rule: "merged" | "split";
    }>;
  } {
    type Interval = { start: number; end: number; session: LocalStudySession };

    const toInterval = (s: LocalStudySession): Interval => ({
      start: new Date(s.studiedAt).getTime(),
      end: new Date(s.studiedAt).getTime() + s.durationMinutes * 60_000,
      session: s,
    });

    const sourceRank = (source: LocalStudySession["source"]): number =>
      source === "auto" ? 3 : source === "extension" ? 2 : 1;

    const intervals = sessions.map(toInterval).sort((a, b) => a.start - b.start);
    const conflicts: Array<{
      sessionA: LocalStudySession;
      sessionB: LocalStudySession;
      overlapMinutes: number;
      rule: "merged" | "split";
    }> = [];

    // Work on a mutable copy of durations/sources
    type MutableSession = LocalStudySession & { _durationMs: number };
    const mutable: MutableSession[] = intervals.map((iv) => ({
      ...iv.session,
      _durationMs: iv.end - iv.start,
    }));

    // Pairwise overlap detection (O(n²) — acceptable for ≤200 sessions/day)
    const merged = new Set<number>(); // indexes to remove (absorbed by merge)

    for (let i = 0; i < mutable.length; i++) {
      if (merged.has(i)) continue;
      const a = mutable[i];
      const aStart = new Date(a.studiedAt).getTime();
      const aEnd = aStart + a._durationMs;

      for (let j = i + 1; j < mutable.length; j++) {
        if (merged.has(j)) continue;
        const b = mutable[j];
        const bStart = new Date(b.studiedAt).getTime();
        const bEnd = bStart + b._durationMs;

        // No overlap — since sorted by start, all later j also won't overlap a
        if (bStart >= aEnd) break;

        const overlapMs = Math.min(aEnd, bEnd) - Math.max(aStart, bStart);
        if (overlapMs <= 0) continue;

        const overlapMinutes = Math.floor(overlapMs / 60_000);

        if (a.topicId === b.topicId) {
          // Rule A: same topic — merge, keep highest-quality session
          const keepA = sourceRank(a.source) >= sourceRank(b.source);
          const winner = keepA ? i : j;
          const loser = keepA ? j : i;
          // Conservative attribution: keep credited duration capped at the larger
          // original session to avoid counting overlapping time twice.
          const mergedDurationMs = Math.max(a._durationMs, b._durationMs);
          mutable[winner] = {
            ...mutable[winner],
            _durationMs: mergedDurationMs,
            durationMinutes: Math.floor(mergedDurationMs / 60_000),
            qualityScore: Math.max(a.qualityScore, b.qualityScore),
            focusRatio: Math.max(a.focusRatio, b.focusRatio),
          };
          merged.add(loser);
          conflicts.push({ sessionA: a, sessionB: b, overlapMinutes, rule: "merged" });
        } else {
          // Rule B: different topics — attribute overlap to the earlier-starting
          // session and trim only the later-starting one (b).
          const trimMs = overlapMs;
          mutable[j] = {
            ...mutable[j],
            _durationMs: Math.max(b._durationMs - trimMs, 0),
            durationMinutes: Math.max(Math.floor((b._durationMs - trimMs) / 60_000), 0),
          };
          conflicts.push({ sessionA: a, sessionB: b, overlapMinutes, rule: "split" });
        }
      }
    }

    const resolved = mutable
      .filter((_, i) => !merged.has(i))
      .map(({ _durationMs: _d, ...s }) => s as LocalStudySession);

    return { resolved, conflicts };
  },
};

// ─── Schedules repository ─────────────────────────────────────────────────────

export const SchedulesRepo = {
  async getByDate(date: string): Promise<LocalDailySchedule | null> {
    const schedules = await getByIndex<LocalDailySchedule>(STORE.SCHEDULES, "date", date);
    // Return the most recently computed one if multiple exist
    if (schedules.length === 0) return null;
    return schedules.sort((a, b) => b.computedAt.localeCompare(a.computedAt))[0];
  },

  async getToday(): Promise<LocalDailySchedule | null> {
    return this.getByDate(todayStr());
  },

  async save(schedule: LocalDailySchedule): Promise<void> {
    await putRecord(STORE.SCHEDULES, schedule);
  },

  async listRecent(days = 7): Promise<LocalDailySchedule[]> {
    const since = new Date(Date.now() - days * 86_400_000).toISOString().split("T")[0];
    const range = IDBKeyRange.lowerBound(since);
    const schedules = await getByIndexRange<LocalDailySchedule>(STORE.SCHEDULES, "date", range);
    return schedules.sort((a, b) => b.date.localeCompare(a.date));
  },
};

// ─── Telemetry repository ─────────────────────────────────────────────────────

export const TelemetryRepo = {
  async appendEvent(event: Omit<LocalTelemetryEvent, "id">): Promise<LocalTelemetryEvent> {
    const record: LocalTelemetryEvent = { id: uuid(), ...event };
    await putRecord(STORE.TELEMETRY, record);
    return record;
  },

  async listForDate(date: string): Promise<LocalTelemetryEvent[]> {
    const start = `${date}T00:00:00.000Z`;
    const end = `${date}T23:59:59.999Z`;
    const range = IDBKeyRange.bound(start, end);
    return getByIndexRange<LocalTelemetryEvent>(STORE.TELEMETRY, "timestamp", range);
  },

  /**
   * Aggregate raw telemetry events into per-topic daily summaries.
   *
   * Quality model — five behaviorally-strict signals:
   *
   *   focusRatio (weight 0.35)
   *     = focusedMs / (focusedMs + distractionMs + idleMs)
   *     Only foreground, non-idle time counts as focused.
   *
   *   interactionDensity (weight 0.25)
   *     = clamp(interactions / focusedMinutes, 0, 1)
   *     Passive reading without any scroll/click = low quality.
   *
   *   fragmentationPenalty (weight 0.20)
   *     = 1 / (1 + max(segmentCount - 1, 0) * 0.2)
   *     One continuous focus segment = 1.0; each additional segment reduces it.
   *
   *   tabSwitchPenalty (weight 0.10)
   *     = 1 / (1 + tabSwitchCount * 0.15)
   *     Each context switch within a focus window reduces quality.
   *
   *   videoEngagement (weight 0.10)
   *     = videoWatchedMs / videoTotalMs   (1.0 if no video events)
   *     YouTube watchers who skip through get lower scores.
   *
   * qualityScore = sum of (signal * weight), rounded to 2 dp.
   */
  summarizeDay(events: LocalTelemetryEvent[]): TelemetrySummary[] {
    const MS_PER_DAY = 86_400_000;
    type TopicEntry = {
      date: string;
      focusedMs: number;
      distractionMs: number;
      idleMs: number;
      interactionCount: number;
      tabSwitchCount: number;
      focusSegmentCount: number;
      // For fragmentation tracking
      currentFocusStart: number | null;
      currentDistractionStart: number | null;
      currentIdleStart: number | null;
      inFocusWindow: boolean;
      // Video engagement
      videoWatchedMs: number;
      videoTotalMs: number;
    };

    const byTopic = new Map<string, TopicEntry>();

    function ensureTopic(topicId: string, date: string): TopicEntry {
      if (!byTopic.has(topicId)) {
        byTopic.set(topicId, {
          date,
          focusedMs: 0,
          distractionMs: 0,
          idleMs: 0,
          interactionCount: 0,
          tabSwitchCount: 0,
          focusSegmentCount: 0,
          currentFocusStart: null,
          currentDistractionStart: null,
          currentIdleStart: null,
          inFocusWindow: false,
          videoWatchedMs: 0,
          videoTotalMs: 0,
        });
      }
      return byTopic.get(topicId)!;
    }

    const sorted = [...events].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const closeFocusWindow = (e: TopicEntry, ts: number) => {
      if (e.currentFocusStart !== null) {
        e.focusedMs += ts - e.currentFocusStart;
        e.currentFocusStart = null;
      }
    };
    const advanceFocusWindow = (e: TopicEntry, ts: number) => {
      if (e.currentFocusStart !== null) {
        e.focusedMs += ts - e.currentFocusStart;
      }
    };
    const utcDayCloseTs = (date: string) => {
      const dayStartTs = new Date(`${date}T00:00:00.000Z`).getTime();
      return dayStartTs + MS_PER_DAY;
    };

    for (const ev of sorted) {
      if (!ev.topicId) continue;
      const ts = new Date(ev.timestamp).getTime();
      // ev.timestamp is ISO-8601, so this date bucket is UTC.
      const date = ev.timestamp.split("T")[0];
      const e = ensureTopic(ev.topicId, date);

      switch (ev.type) {
        case "tab_focus":
        case "session_start": {
          // Close any open distraction window
          if (e.currentDistractionStart !== null) {
            e.distractionMs += ts - e.currentDistractionStart;
            e.currentDistractionStart = null;
          }
          // Close any open idle window
          if (e.currentIdleStart !== null) {
            e.idleMs += ts - e.currentIdleStart;
            e.currentIdleStart = null;
          }
          // Opening a new focus segment
          if (!e.inFocusWindow) {
            e.focusSegmentCount += 1;
            e.inFocusWindow = true;
          } else {
            // Was already in focus window — rapid context switch back
            // (Cmd+Tab / Alt+Tab return without an intervening tab_blur)
            e.tabSwitchCount += 1;
            advanceFocusWindow(e, ts);
          }
          e.currentFocusStart = ts;
          break;
        }

        case "tab_blur":
        case "session_end": {
          // Close focus window
          closeFocusWindow(e, ts);
          e.inFocusWindow = false;
          // Start distraction window
          e.currentDistractionStart = ts;
          // Count the tab switch itself
          e.tabSwitchCount += 1;
          break;
        }

        case "idle_start": {
          // Idle interrupts focus, but is tracked separately from distraction
          closeFocusWindow(e, ts);
          e.inFocusWindow = false;
          // Close distraction window too (idle is neither focused nor distraction)
          if (e.currentDistractionStart !== null) {
            e.distractionMs += ts - e.currentDistractionStart;
            e.currentDistractionStart = null;
          }
          e.currentIdleStart = ts;
          break;
        }

        case "idle_end": {
          if (e.currentIdleStart !== null) {
            e.idleMs += ts - e.currentIdleStart;
            e.currentIdleStart = null;
          }
          // Resume focus (idle_end = user is back)
          e.focusSegmentCount += 1;
          e.inFocusWindow = true;
          e.currentFocusStart = ts;
          break;
        }

        case "scroll":
        case "click": {
          e.interactionCount += 1;
          break;
        }

        case "video_progress": {
          // data.watchedMs: how much was actually watched in this tick
          // data.totalMs: total video duration
          const watchedMs = typeof ev.data.watchedMs === "number" ? ev.data.watchedMs : 0;
          const totalMs = typeof ev.data.totalMs === "number" ? ev.data.totalMs : 0;
          if (watchedMs > 0) e.videoWatchedMs += watchedMs;
          if (totalMs > 0 && e.videoTotalMs < totalMs) {
            // Only advance total if we see a larger value (last event wins)
            e.videoTotalMs = totalMs;
          }
          break;
        }
      }
    }

    // Close any still-open windows at each summarized day's boundary
    for (const e of byTopic.values()) {
      // Date buckets are UTC (from ISO timestamps), so close at next UTC day-start.
      const dayCloseTs = utcDayCloseTs(e.date);
      closeFocusWindow(e, dayCloseTs);
      if (e.currentDistractionStart !== null) {
        e.distractionMs += dayCloseTs - e.currentDistractionStart;
        e.currentDistractionStart = null;
      }
      if (e.currentIdleStart !== null) {
        e.idleMs += dayCloseTs - e.currentIdleStart;
        e.currentIdleStart = null;
      }
    }

    const summaries: TelemetrySummary[] = [];

    for (const [topicId, e] of byTopic.entries()) {
      const focusedMin = Math.floor(e.focusedMs / 60_000);
      const distractionMin = Math.floor(e.distractionMs / 60_000);
      const idleMin = Math.floor(e.idleMs / 60_000);

      // focusRatio: focused time over all tracked time (excludes closed windows)
      const totalTracked = e.focusedMs + e.distractionMs + e.idleMs;
      const focusRatio = totalTracked > 0 ? e.focusedMs / totalTracked : 0;

      // interactionDensity: interactions per focused minute, capped at 1
      const interactionDensity = focusedMin > 0 ? Math.min(e.interactionCount / focusedMin, 1) : 0;

      // fragmentationPenalty: 1 continuous session = 1.0; each extra segment −0.2
      const fragmentationPenalty = e.focusSegmentCount > 0
        ? 1 / (1 + Math.max(e.focusSegmentCount - 1, 0) * 0.2)
        : 1;

      // tabSwitchPenalty: each switch reduces quality by 0.15 (diminishing returns via division)
      const tabSwitchPenalty = 1 / (1 + e.tabSwitchCount * 0.15);

      // videoEngagement: 1.0 if no video events; else watched/total
      const videoEngagementRatio = e.videoTotalMs > 0
        ? Math.min(e.videoWatchedMs / e.videoTotalMs, 1)
        : 1;

      // Composite quality score (five weighted signals)
      const qualityScore = Math.round(
        (
          focusRatio * 0.35 +
          interactionDensity * 0.25 +
          fragmentationPenalty * 0.20 +
          tabSwitchPenalty * 0.10 +
          videoEngagementRatio * 0.10
        ) * 100,
      ) / 100;

      summaries.push({
        date: e.date,
        topicId,
        focusedMinutes: focusedMin,
        distractionMinutes: distractionMin,
        idleMinutes: idleMin,
        interactionCount: e.interactionCount,
        tabSwitchCount: e.tabSwitchCount,
        focusSegmentCount: e.focusSegmentCount,
        videoEngagementRatio,
        focusRatio: Math.round(focusRatio * 100) / 100,
        qualityScore,
      });
    }

    return summaries;
  },

  /** Purge raw telemetry events older than N days to control storage growth. */
  async pruneOlderThan(days: number): Promise<number> {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const range = IDBKeyRange.upperBound(cutoff, true);
    const old = await getByIndexRange<LocalTelemetryEvent>(STORE.TELEMETRY, "timestamp", range);
    for (const ev of old) {
      await deleteRecord(STORE.TELEMETRY, ev.id);
    }
    return old.length;
  },
};

// ─── Overrides repository ─────────────────────────────────────────────────────

export const OverridesRepo = {
  async create(reason: string | null = null): Promise<LocalScheduleOverride> {
    const record: LocalScheduleOverride = {
      id: uuid(),
      date: todayStr(),
      reason,
      triggeredAt: now(),
    };
    await putRecord(STORE.OVERRIDES, record);
    return record;
  },

  async countToday(): Promise<number> {
    const today = todayStr();
    const records = await getByIndex<LocalScheduleOverride>(STORE.OVERRIDES, "date", today);
    return records.length;
  },

  async list(days = 30): Promise<LocalScheduleOverride[]> {
    const since = new Date(Date.now() - days * 86_400_000).toISOString().split("T")[0];
    const range = IDBKeyRange.lowerBound(since);
    const records = await getByIndexRange<LocalScheduleOverride>(STORE.OVERRIDES, "date", range);
    return records.sort((a, b) => b.triggeredAt.localeCompare(a.triggeredAt));
  },
};

// ─── Meta repository ──────────────────────────────────────────────────────────

export const MetaRepo = {
  async get<T>(key: MetaKey): Promise<T | null> {
    const record = await getByKey<MetaRecord>(STORE.META, key);
    return record ? (record.value as T) : null;
  },

  async set(key: MetaKey, value: unknown): Promise<void> {
    await putRecord(STORE.META, { key, value } satisfies MetaRecord);
  },
};
