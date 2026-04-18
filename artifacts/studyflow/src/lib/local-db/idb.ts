import type { TelemetryEvent } from "./schema";

const DB_NAME = "studyflow-local";
// v3 adds append-only validation stores for Phase 7 real-user validation.
const DB_VERSION = 3;
const TELEMETRY_STORE = "telemetry_events";
const MASTERY_STORE = "topic_mastery_states";
export const VALIDATION_DAILY_STORE = "validation_daily_snapshots";
export const VALIDATION_WEEKLY_STORE = "validation_weekly_summaries";
export const VALIDATION_RESET_STORE = "validation_reset_impacts";
export const VALIDATION_DROPOFF_STORE = "validation_dropoff_events";
export const VALIDATION_EXECUTION_EVENT_STORE = "validation_execution_events";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(TELEMETRY_STORE)) {
        const store = db.createObjectStore(TELEMETRY_STORE, { keyPath: "id" });
        store.createIndex("timestamp", "timestamp", { unique: false });
      }
      if (!db.objectStoreNames.contains(MASTERY_STORE)) {
        db.createObjectStore(MASTERY_STORE, { keyPath: "topicId" });
      }
      if (!db.objectStoreNames.contains(VALIDATION_DAILY_STORE)) {
        const store = db.createObjectStore(VALIDATION_DAILY_STORE, { keyPath: "id" });
        store.createIndex("timestamp", "timestamp", { unique: false });
        store.createIndex("date_mode", ["date", "mode"], { unique: false });
      }
      if (!db.objectStoreNames.contains(VALIDATION_WEEKLY_STORE)) {
        const store = db.createObjectStore(VALIDATION_WEEKLY_STORE, { keyPath: "id" });
        store.createIndex("timestamp", "timestamp", { unique: false });
        store.createIndex("week_mode", ["week_start", "week_end", "mode"], { unique: true });
      }
      if (!db.objectStoreNames.contains(VALIDATION_RESET_STORE)) {
        const store = db.createObjectStore(VALIDATION_RESET_STORE, { keyPath: "id" });
        store.createIndex("timestamp", "timestamp", { unique: false });
        store.createIndex("reset_mode", ["reset_date", "mode"], { unique: true });
      }
      if (!db.objectStoreNames.contains(VALIDATION_DROPOFF_STORE)) {
        const store = db.createObjectStore(VALIDATION_DROPOFF_STORE, { keyPath: "id" });
        store.createIndex("timestamp", "timestamp", { unique: false });
        store.createIndex("lastdate_mode", ["last_date", "mode"], { unique: true });
      }
      if (!db.objectStoreNames.contains(VALIDATION_EXECUTION_EVENT_STORE)) {
        const store = db.createObjectStore(VALIDATION_EXECUTION_EVENT_STORE, { keyPath: "id" });
        store.createIndex("timestamp", "timestamp", { unique: false });
        store.createIndex("date_mode", ["date", "mode"], { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Failed to open IndexedDB"));
  });
}

export async function getDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = openDb();
  }
  return dbPromise;
}

export async function putTelemetryEvent(event: TelemetryEvent): Promise<void> {
  const db = await getDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(TELEMETRY_STORE, "readwrite");
    tx.objectStore(TELEMETRY_STORE).put(event);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Failed to write telemetry event"));
  });
}

export async function getTelemetryEventsInRange(startIso: string, endIso: string): Promise<TelemetryEvent[]> {
  const db = await getDb();
  return new Promise<TelemetryEvent[]>((resolve, reject) => {
    const tx = db.transaction(TELEMETRY_STORE, "readonly");
    const index = tx.objectStore(TELEMETRY_STORE).index("timestamp");
    const range = IDBKeyRange.bound(startIso, endIso);
    const request = index.getAll(range);

    request.onsuccess = () => {
      resolve((request.result ?? []) as TelemetryEvent[]);
    };
    request.onerror = () => reject(request.error ?? new Error("Failed to read telemetry events"));
  });
}
