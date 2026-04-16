/**
 * IndexedDB connection layer — Phase 1
 *
 * Opens (and upgrades) the StudyFlow local database.
 * Returns a promise-wrapped IDBDatabase for use by the repository layer.
 *
 * Object stores created in v1:
 *   profile   — single-record student profile (keyPath: id)
 *   topics    — curriculum topics (keyPath: id)
 *   sessions  — study sessions (keyPath: id)
 *   schedules — daily schedules (keyPath: id)
 *   telemetry — raw behavioural events (keyPath: id)
 *   overrides — schedule override audit log (keyPath: id)
 *   meta      — misc key-value pairs (keyPath: key)
 */

import { DB_NAME, DB_VERSION, STORE } from "./schema";

let _db: IDBDatabase | null = null;

/** Opens the database, creating/upgrading it as necessary. Returns a shared instance. */
export function openStudyFlowDB(): Promise<IDBDatabase> {
  if (_db) return Promise.resolve(_db);

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      const oldVersion = event.oldVersion;

      if (oldVersion < 1) {
        // ── profile ──────────────────────────────────────────────────────────
        db.createObjectStore(STORE.PROFILE, { keyPath: "id" });

        // ── topics ───────────────────────────────────────────────────────────
        const topics = db.createObjectStore(STORE.TOPICS, { keyPath: "id" });
        topics.createIndex("subject", "subject", { unique: false });
        topics.createIndex("priorityScore", "priorityScore", { unique: false });
        topics.createIndex("isCompleted", "isCompleted", { unique: false });

        // ── sessions ─────────────────────────────────────────────────────────
        const sessions = db.createObjectStore(STORE.SESSIONS, {
          keyPath: "id",
        });
        sessions.createIndex("topicId", "topicId", { unique: false });
        sessions.createIndex("studiedAt", "studiedAt", { unique: false });
        sessions.createIndex("source", "source", { unique: false });

        // ── schedules ────────────────────────────────────────────────────────
        const schedules = db.createObjectStore(STORE.SCHEDULES, {
          keyPath: "id",
        });
        // Not unique — multiple schedules can exist for the same date
        // (e.g. nightly + override). SchedulesRepo.getByDate() returns the
        // most-recently-computed one.
        schedules.createIndex("date", "date", { unique: false });

        // ── telemetry ─────────────────────────────────────────────────────────
        const telemetry = db.createObjectStore(STORE.TELEMETRY, {
          keyPath: "id",
        });
        telemetry.createIndex("topicId", "topicId", { unique: false });
        telemetry.createIndex("timestamp", "timestamp", { unique: false });
        telemetry.createIndex("type", "type", { unique: false });

        // ── overrides ─────────────────────────────────────────────────────────
        const overrides = db.createObjectStore(STORE.OVERRIDES, {
          keyPath: "id",
        });
        overrides.createIndex("date", "date", { unique: false });

        // ── meta ──────────────────────────────────────────────────────────────
        db.createObjectStore(STORE.META, { keyPath: "key" });
      }
    };

    request.onsuccess = (event) => {
      _db = (event.target as IDBOpenDBRequest).result;

      // Propagate unexpected close / version change
      _db.onversionchange = () => {
        _db?.close();
        _db = null;
      };
      _db.onclose = () => {
        _db = null;
      };

      resolve(_db);
    };

    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(new Error("IndexedDB open blocked — close other tabs and reload"));
  });
}

/** Closes the shared DB connection (call on app teardown / testing). */
export function closeStudyFlowDB(): void {
  _db?.close();
  _db = null;
}

// ─── Low-level helpers ────────────────────────────────────────────────────────

/** Wraps an IDBRequest in a Promise. */
export function promisifyRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Runs a callback inside a read-write transaction. Resolves when the tx commits. */
export async function withWriteTx<T>(
  storeName: string | string[],
  fn: (tx: IDBTransaction) => Promise<T>,
): Promise<T> {
  const db = await openStudyFlowDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    let result: T;
    fn(tx)
      .then((r) => {
        result = r;
      })
      .catch(reject);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(new Error("Transaction aborted"));
  });
}

/** Runs a callback inside a read-only transaction. */
export async function withReadTx<T>(
  storeName: string | string[],
  fn: (tx: IDBTransaction) => Promise<T>,
): Promise<T> {
  const db = await openStudyFlowDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    fn(tx).then(resolve).catch(reject);
    tx.onerror = () => reject(tx.error);
  });
}

/** Returns all records from a store. */
export async function getAllFromStore<T>(storeName: string): Promise<T[]> {
  const db = await openStudyFlowDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const store = tx.objectStore(storeName);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result as T[]);
    req.onerror = () => reject(req.error);
  });
}

/** Fetches a single record by primary key. */
export async function getByKey<T>(
  storeName: string,
  key: IDBValidKey,
): Promise<T | undefined> {
  const db = await openStudyFlowDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const store = tx.objectStore(storeName);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

/** Puts (upserts) a record. */
export async function putRecord<T>(storeName: string, record: T): Promise<void> {
  const db = await openStudyFlowDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    const req = store.put(record);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    tx.onerror = () => reject(tx.error);
  });
}

/** Deletes a record by primary key. */
export async function deleteRecord(
  storeName: string,
  key: IDBValidKey,
): Promise<void> {
  const db = await openStudyFlowDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    const req = store.delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    tx.onerror = () => reject(tx.error);
  });
}

/** Returns all records matching an index value. */
export async function getByIndex<T>(
  storeName: string,
  indexName: string,
  value: IDBValidKey,
): Promise<T[]> {
  const db = await openStudyFlowDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const store = tx.objectStore(storeName);
    const idx = store.index(indexName);
    const req = idx.getAll(value);
    req.onsuccess = () => resolve(req.result as T[]);
    req.onerror = () => reject(req.error);
  });
}

/** Returns all records in an index range (e.g. dates ≥ lower bound). */
export async function getByIndexRange<T>(
  storeName: string,
  indexName: string,
  range: IDBKeyRange,
): Promise<T[]> {
  const db = await openStudyFlowDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const store = tx.objectStore(storeName);
    const idx = store.index(indexName);
    const req = idx.getAll(range);
    req.onsuccess = () => resolve(req.result as T[]);
    req.onerror = () => reject(req.error);
  });
}
