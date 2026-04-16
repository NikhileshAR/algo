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

  /** Aggregate raw telemetry events into per-topic daily summaries. */
  summarizeDay(events: LocalTelemetryEvent[]): TelemetrySummary[] {
    const byTopic = new Map<string, {
      focusedMs: number;
      distractionMs: number;
      interactionCount: number;
      focusSegments: Array<{ start: number; end: number }>;
      currentFocusStart: number | null;
      currentDistractionStart: number | null;
      date: string;
    }>();

    function ensureTopic(topicId: string, date: string) {
      if (!byTopic.has(topicId)) {
        byTopic.set(topicId, {
          focusedMs: 0,
          distractionMs: 0,
          interactionCount: 0,
          focusSegments: [],
          currentFocusStart: null,
          currentDistractionStart: null,
          date,
        });
      }
      return byTopic.get(topicId)!;
    }

    for (const ev of events.sort((a, b) => a.timestamp.localeCompare(b.timestamp))) {
      if (!ev.topicId) continue;
      const ts = new Date(ev.timestamp).getTime();
      const date = ev.timestamp.split("T")[0];
      const entry = ensureTopic(ev.topicId, date);

      switch (ev.type) {
        case "tab_focus":
        case "session_start":
          if (entry.currentDistractionStart !== null) {
            entry.distractionMs += ts - entry.currentDistractionStart;
            entry.currentDistractionStart = null;
          }
          entry.currentFocusStart = ts;
          break;

        case "tab_blur":
        case "session_end":
          if (entry.currentFocusStart !== null) {
            entry.focusedMs += ts - entry.currentFocusStart;
            entry.currentFocusStart = null;
          }
          entry.currentDistractionStart = ts;
          break;

        case "idle_start":
          if (entry.currentFocusStart !== null) {
            entry.focusedMs += ts - entry.currentFocusStart;
            entry.currentFocusStart = null;
          }
          break;

        case "idle_end":
          entry.currentFocusStart = ts;
          break;

        case "scroll":
        case "click":
          entry.interactionCount += 1;
          break;
      }
    }

    const summaries: TelemetrySummary[] = [];
    for (const [topicId, entry] of byTopic.entries()) {
      const focusedMin = Math.floor(entry.focusedMs / 60_000);
      const distractionMin = Math.floor(entry.distractionMs / 60_000);
      const total = focusedMin + distractionMin;
      const focusRatio = total > 0 ? focusedMin / total : 0;
      // Quality: blend of focus ratio and interaction density
      const interactionRate = focusedMin > 0 ? Math.min(entry.interactionCount / focusedMin, 1) : 0;
      const qualityScore = Math.round((focusRatio * 0.7 + interactionRate * 0.3) * 100) / 100;

      summaries.push({
        date: entry.date,
        topicId,
        focusedMinutes: focusedMin,
        distractionMinutes: distractionMin,
        interactionCount: entry.interactionCount,
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
