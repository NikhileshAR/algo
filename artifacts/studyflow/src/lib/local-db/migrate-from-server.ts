/**
 * Server → IndexedDB migration — Phase 1
 *
 * One-time import helper. When the app detects an existing API server with
 * profile/topic/session data, it offers to migrate that data into the local
 * IndexedDB store so the student doesn't lose history.
 *
 * After migration completes, the meta store is updated with
 * key "server_migration" = "done". Subsequent app boots skip the migration.
 *
 * The migration is additive (never overwrites existing local data) and
 * non-destructive (never deletes server data).
 */

import { MetaRepo, ProfileRepo, TopicsRepo, SessionsRepo } from "./repositories";
import { putRecord } from "./idb";
import { STORE } from "./schema";
import type {
  MigrationResult,
  LocalStudentProfile,
  LocalTopic,
  LocalStudySession,
} from "./schema";

// ─── Server response shapes (loosely typed) ───────────────────────────────────

interface ServerProfile {
  name: string;
  examName: string;
  examDate: string;
  dailyTargetHours: number;
  capacityScore: number;
  disciplineScore: number;
  activePracticeRatio: number;
}

interface ServerTopic {
  id: number;
  name: string;
  subject: string;
  masteryScore: number;
  confidenceScore: number;
  priorityScore: number;
  difficultyLevel: number;
  estimatedHours: number;
  prerequisites: number[];
  isCompleted: boolean;
  testsCount: number;
  lastStudiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ServerSession {
  id: number;
  topicId: number;
  topicName: string;
  sessionType: "lecture" | "practice";
  durationMinutes: number;
  distractionMinutes: number | null;
  source: string | null;
  testScore: number | null;
  testScoreMax: number | null;
  notes: string | null;
  studiedAt: string;
  createdAt: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Checks whether the server API is reachable. */
export async function checkServerAvailable(apiUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${apiUrl}/api/health`, {
      signal: AbortSignal.timeout(4000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Checks whether the server has a student profile. */
export async function serverHasProfile(apiUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${apiUrl}/api/student/profile`, {
      signal: AbortSignal.timeout(4000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Returns the current server migration status stored in meta. */
export async function getMigrationStatus(): Promise<"done" | "skipped" | null> {
  return MetaRepo.get<"done" | "skipped">("server_migration");
}

// ─── Main migration function ──────────────────────────────────────────────────

/**
 * Imports profile, topics and sessions from the API server into IndexedDB.
 *
 * Server integer IDs are mapped to local UUID strings using a stable
 * deterministic namespace so that prerequisite links remain valid after
 * migration.
 *
 * Topics already present locally are deduplicated by lowercase name, and
 * sessions already present locally are deduplicated by a composite key of
 * topicId + studiedAt.
 */
export async function importFromServer(apiUrl: string): Promise<MigrationResult> {
  const result: MigrationResult = {
    status: "running",
    imported: { topics: 0, sessions: 0, profile: false },
    errors: [],
  };

  const base = apiUrl.replace(/\/$/, "");

  try {
    // ── 1. Fetch all server data ────────────────────────────────────────────
    const [profileRes, topicsRes, sessionsRes] = await Promise.all([
      fetch(`${base}/api/student/profile`).catch(() => null),
      fetch(`${base}/api/topics`).catch(() => null),
      fetch(`${base}/api/sessions?limit=1000`).catch(() => null),
    ]);

    const serverProfile: ServerProfile | null = profileRes?.ok
      ? await profileRes.json()
      : null;
    const serverTopics: ServerTopic[] = topicsRes?.ok
      ? await topicsRes.json()
      : [];
    const serverSessions: ServerSession[] = sessionsRes?.ok
      ? await sessionsRes.json()
      : [];

    // ── 2. Build server-id → local-UUID mapping for topics ────────────────
    // Use a deterministic UUID namespace derived from the server topic ID so
    // that running the migration twice doesn't create duplicates.
    const topicIdMap = new Map<number, string>();
    for (const st of serverTopics) {
      const localId = await deterministicUUID(`topic-${st.id}`);
      topicIdMap.set(st.id, localId);
    }

    // ── 3. Migrate profile ─────────────────────────────────────────────────
    if (serverProfile) {
      const existing = await ProfileRepo.get();
      if (!existing) {
        await ProfileRepo.save({
          name: serverProfile.name,
          examName: serverProfile.examName,
          examDate: serverProfile.examDate,
          dailyTargetHours: serverProfile.dailyTargetHours,
          capacityScore: serverProfile.capacityScore,
          disciplineScore: serverProfile.disciplineScore,
          distractionScore: 0,
          activePracticeRatio: serverProfile.activePracticeRatio,
          overrideCount: 0,
        });
        result.imported.profile = true;
      }
    }

    // ── 4. Migrate topics ─────────────────────────────────────────────────
    const existingTopics = await TopicsRepo.list();
    const existingNames = new Set(existingTopics.map((t) => t.name.toLowerCase()));

    for (const st of serverTopics) {
      if (existingNames.has(st.name.toLowerCase())) {
        // Already migrated / manually added
        continue;
      }

      const localId = topicIdMap.get(st.id)!;
      const prereqs = st.prerequisites
        .map((pid) => topicIdMap.get(pid))
        .filter((id): id is string => id !== undefined);

      const topic: LocalTopic = {
        id: localId,
        name: st.name,
        subject: st.subject,
        masteryScore: st.masteryScore,
        confidenceScore: st.confidenceScore,
        priorityScore: st.priorityScore,
        difficultyLevel: st.difficultyLevel,
        estimatedHours: st.estimatedHours,
        prerequisites: prereqs,
        isCompleted: st.isCompleted,
        testsCount: st.testsCount,
        lastStudiedAt: st.lastStudiedAt,
        createdAt: st.createdAt,
        updatedAt: st.updatedAt,
      };

      // Write directly to avoid auto-generating a new ID
      await putRecord(STORE.TOPICS, topic);
      result.imported.topics += 1;
    }

    // ── 5. Migrate sessions ────────────────────────────────────────────────
    const existingSessions = await SessionsRepo.list(10_000);
    const existingSessionKeys = new Set(
      existingSessions.map((s) => `${s.topicId}:${s.studiedAt}`),
    );

    for (const ss of serverSessions) {
      const localTopicId = topicIdMap.get(ss.topicId);
      if (!localTopicId) continue;

      const key = `${localTopicId}:${ss.studiedAt}`;
      if (existingSessionKeys.has(key)) continue;

      const rawSource = ss.source ?? "manual";
      const source: LocalStudySession["source"] =
        rawSource === "extension" ? "extension" : rawSource === "auto" ? "auto" : "manual";
      const qualityWeight = source === "manual" ? 0.5 : 1.0;
      const distractionMinutes = ss.distractionMinutes ?? 0;
      const durationMinutes = ss.durationMinutes;
      const focusRatio =
        durationMinutes + distractionMinutes > 0
          ? durationMinutes / (durationMinutes + distractionMinutes)
          : 1;

      const session: LocalStudySession = {
        id: await deterministicUUID(`session-${ss.id}`),
        topicId: localTopicId,
        topicName: ss.topicName,
        sessionType: ss.sessionType,
        durationMinutes,
        distractionMinutes,
        source,
        qualityWeight,
        focusRatio,
        qualityScore: focusRatio * qualityWeight,
        testScore: ss.testScore,
        testScoreMax: ss.testScoreMax,
        notes: ss.notes,
        studiedAt: ss.studiedAt,
        createdAt: ss.createdAt,
      };

      await putRecord(STORE.SESSIONS, session);
      result.imported.sessions += 1;
    }

    // ── 6. Mark migration as done ─────────────────────────────────────────
    await MetaRepo.set("server_migration", "done");
    result.status = "done";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.errors.push(message);
    result.status = "error";
  }

  return result;
}

/** Records the user's choice to skip migration. */
export async function skipMigration(): Promise<void> {
  await MetaRepo.set("server_migration", "skipped");
}

// ─── Deterministic UUID ───────────────────────────────────────────────────────

/**
 * Produces a stable UUID v5-like string from an input string using SubtleCrypto.
 * This ensures that migrating the same server record twice yields the same local ID.
 */
async function deterministicUUID(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(`studyflow:${input}`);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = new Uint8Array(hashBuffer);

  // Format first 16 bytes as a UUID v4-like string (variant bits overridden for safety)
  const hex = Array.from(hashArray.slice(0, 16))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    "4" + hex.slice(13, 16), // version 4
    ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16) + hex.slice(17, 20), // variant
    hex.slice(20, 32),
  ].join("-");
}
