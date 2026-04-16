import type { TelemetryEvent } from "./schema";

const DB_NAME = "studyflow-local";
const DB_VERSION = 2;
const TELEMETRY_STORE = "telemetry_events";
const MASTERY_STORE = "topic_mastery_states";

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
