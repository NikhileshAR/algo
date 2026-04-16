export interface MobileTelemetryStats {
  timestamp: string;
  platform: "android" | "ios" | "unknown";
  focusedMs: number;
  interactionCount: number;
  appSwitches: number;
  notes: string;
}

export function collectMobileStats(): MobileTelemetryStats {
  return {
    timestamp: new Date().toISOString(),
    platform: "unknown",
    focusedMs: 0,
    interactionCount: 0,
    appSwitches: 0,
    notes: "Mobile telemetry stub. Native integration pending.",
  };
}
