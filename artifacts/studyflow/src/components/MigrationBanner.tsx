/**
 * MigrationBanner — Phase 1
 *
 * Non-blocking bottom banner that appears when the app detects existing
 * data on the legacy API server that hasn't been migrated to IndexedDB yet.
 *
 * States:
 *   available → "Import your existing data" CTA
 *   running   → spinner with progress description
 *   done      → brief success confirmation, then auto-dismisses
 *   skipped   → hidden
 *   error     → error message with retry button
 *   null      → hidden (migration complete, server not present, or not yet detected)
 */

import { useState } from "react";
import { useLocalDb } from "@/context/LocalDbContext";
import { Button } from "@/components/ui/button";
import { Loader2, DownloadCloud, CheckCircle2, AlertTriangle, X } from "lucide-react";

export default function MigrationBanner() {
  const {
    migrationStatus,
    serverApiUrl,
    runMigration,
    skipServerMigration,
  } = useLocalDb();

  const [lastResult, setLastResult] = useState<{
    topics: number;
    sessions: number;
    profile: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (
    !migrationStatus ||
    migrationStatus === "skipped" ||
    migrationStatus === "done" && !lastResult
  ) {
    return null;
  }

  async function handleImport() {
    if (!serverApiUrl) return;
    setError(null);
    const result = await runMigration(serverApiUrl);
    if (result.status === "done") {
      setLastResult(result.imported);
    } else if (result.status === "error") {
      setError(result.errors[0] ?? "Unknown error during migration.");
    }
  }

  // Auto-hide after showing done confirmation
  if (migrationStatus === "done" && lastResult) {
    return (
      <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-5 py-3 shadow-lg text-sm text-emerald-900 animate-in slide-in-from-bottom-4 duration-500">
        <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
        <span>
          Migration complete — {lastResult.topics} topics and{" "}
          {lastResult.sessions} sessions imported to your local database.
        </span>
        <button
          onClick={() => setLastResult(null)}
          className="ml-2 text-emerald-700 hover:text-emerald-900 transition-colors"
          aria-label="Dismiss"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    );
  }

  if (migrationStatus === "available") {
    return (
      <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 max-w-lg w-full mx-4 rounded-xl border bg-card shadow-xl px-5 py-4 space-y-3 animate-in slide-in-from-bottom-4 duration-500">
        <div className="flex items-start gap-3">
          <DownloadCloud className="h-5 w-5 text-primary mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold leading-tight">
              Import existing data
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              StudyFlow has detected existing topics and sessions on the server.
              Import them once into your local database — they'll be available
              offline from then on.
            </p>
          </div>
          <button
            onClick={skipServerMigration}
            className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
            aria-label="Skip migration"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {error && (
          <div className="flex items-start gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}
        <div className="flex gap-2 justify-end">
          <Button variant="ghost" size="sm" onClick={skipServerMigration}>
            Skip
          </Button>
          <Button size="sm" onClick={handleImport}>
            <DownloadCloud className="h-4 w-4 mr-1.5" />
            Import now
          </Button>
        </div>
      </div>
    );
  }

  if (migrationStatus === "running") {
    return (
      <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 rounded-xl border bg-card shadow-lg px-5 py-3 text-sm animate-in slide-in-from-bottom-4 duration-500">
        <Loader2 className="h-4 w-4 animate-spin text-primary shrink-0" />
        <span className="text-muted-foreground">Importing data to local database…</span>
      </div>
    );
  }

  if (migrationStatus === "error") {
    return (
      <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 rounded-xl border border-red-200 bg-red-50 shadow-lg px-5 py-3 text-sm text-red-900 animate-in slide-in-from-bottom-4 duration-500">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        <span>Migration failed. {error}</span>
        <Button variant="ghost" size="sm" onClick={handleImport} className="ml-2 text-red-700 hover:text-red-900">
          Retry
        </Button>
      </div>
    );
  }

  return null;
}
