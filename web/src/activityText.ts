/** Wording for the household activity feed. Pure functions so the same text is tested without a browser. */
export type Detail = {
  source?: string; since?: number; airplane?: boolean; location_services?: boolean; gps_provider?: boolean;
  fine_location?: boolean; background_location?: boolean; locked?: boolean; interactive?: boolean; sharing?: boolean;
  network?: string; suppressed?: number; failures?: number; minutes?: number;
} | null | undefined;

/** Titles for the phone-event kinds the server reports (sharing start/stop and device-state observations). */
export const phoneKinds: Record<string, string> = {
  started: "Sharing started", stopped: "Sharing stopped", gps_enabled: "GPS enabled", gps_disabled: "GPS disabled", error: "Error",
  locate_started: "Temporary GPS started", locate_finished: "Temporary GPS finished",
  airplane_on: "Airplane mode turned on", airplane_off: "Airplane mode turned off",
  location_off: "Location turned off", location_on: "Location turned on",
  permission_lost: "Location permission removed", permission_restored: "Location permission granted",
  gps_gap: "GPS fixes stopped", gps_gap_ended: "GPS fixes resumed",
};
export const categories: Record<string, string> = { manual: "Manual", automatic: "Automatic", system: "Android / system", crash: "Crash", error: "Error", unknown: "Unknown" };

const actions: Record<string, string> = {
  "admin.login": "Administrator signed in", "admin.password_changed": "Administrator password changed",
  "device.enrolled": "Phone paired", "device.revoked": "Phone disconnected and its data erased", "device.disconnected": "Phone disconnected",
  "device.reconnected": "Phone reconnected", "device.archive_erased": "Saved phone record deleted", "device.binding_purged": "Inactive pairing keys removed",
  "enrollment.created": "Invitation created", "enrollment.reissued": "Invitation reissued", "enrollment.reclaimed": "Unused invitation reclaimed", "profiles.enabled": "Android profiles enabled",
  "command.queued": "Command queued", "command.receipt": "Command receipt received", "command.canceled": "Command canceled", "policy.updated": "Recovery policy updated",
  "history.erased": "Saved history erased", "history.imported": "History imported", "location.erased": "All saved GPS erased", "location.purged": "Older saved GPS purged", "location.erased_all": "Saved GPS erased for all phones",
  "photo.erased": "Recovery photo erased", "photos.erased": "Recovery photos erased", "photos.all_erased": "All recovery photos erased", "maps.queued": "Map download queued",
  "activity.purged": "Activity log purged", "retention.updated": "Automatic cleanup changed",
};
export const auditTitle = (action: string) => actions[action] ?? action.replaceAll(".", " · ").replaceAll("_", " ");

/** Plain-language circumstances recorded with a device-state event. Android never says who changed a setting. */
export function contextLine(detail: Detail): string {
  if (!detail) return "";
  const parts: string[] = [];
  if (detail.source === "reconciled") parts.push("found changed after Bungee was not running; exact time unknown");
  if (typeof detail.locked === "boolean") parts.push(detail.locked ? "phone was locked" : "phone was unlocked");
  if (typeof detail.interactive === "boolean") parts.push(detail.interactive ? "screen on" : "screen off");
  if (detail.airplane === true) parts.push("airplane mode on");
  if (detail.location_services === false) parts.push("location services off");
  if (detail.gps_provider === false && detail.location_services !== false) parts.push("GPS provider off");
  if (typeof detail.sharing === "boolean") parts.push(detail.sharing ? "Bungee sharing was running" : "Bungee sharing was not running");
  if (detail.network === "none") parts.push("no network");
  if (detail.failures) parts.push(`${detail.failures} attempts in a row without a fix`);
  if (typeof detail.minutes === "number") parts.push(`${detail.minutes} min without a fix`);
  if (detail.suppressed) parts.push(`${detail.suppressed} more rapid changes not listed`);
  const text = parts.join(" · ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** An event delivered long after it happened is a reconnection backfill, not a live observation. */
export function lateDelivery(at: number | null, recordedAt: number, receivedAt: number): boolean {
  return receivedAt - (at ?? recordedAt) > 300;
}

export type Filter = { device: string; group: string; from?: number; to?: number };
export const groups: Array<[string, string]> = [
  ["all", "Everything"], ["admin", "Administrator actions"], ["phone", "Everything reported by phones"],
  ["device_state", "Airplane mode, location and GPS gaps"], ["sharing", "Sharing start and stop"],
];
export const activityQuery = (filter: Filter, before: string | null, limit = 50) => {
  const q = new URLSearchParams({ limit: String(limit), group: filter.group });
  if (filter.device) q.set("device", filter.device);
  if (filter.from != null) q.set("from", String(filter.from));
  if (filter.to != null) q.set("to", String(filter.to));
  if (before) q.set("before", before);
  return `?${q.toString()}`;
};

/** Age choices shared by manual purges and automatic cleanup. Zero means everything / keep everything. */
export const ageChoices: Array<[number, string]> = [[7, "7 days"], [14, "14 days"], [30, "30 days"], [60, "60 days"], [90, "90 days"], [180, "180 days"], [365, "1 year"], [730, "2 years"]];
export const purgeQuery = (params: { device?: string; days?: number; scope?: string }) => {
  const q = new URLSearchParams();
  if (params.device) q.set("device", params.device);
  if (params.days) q.set("older_than_days", String(params.days));
  if (params.scope && params.scope !== "all") q.set("scope", params.scope);
  const text = q.toString();
  return text ? `?${text}` : "";
};
export const formatBytes = (n: number) => n >= 1073741824 ? `${(n / 1073741824).toFixed(1)} GB` : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;

/** The message the dashboard sends to ask a phone's holder to turn Location on. Android gives no app a way to do it. */
export const LOCATION_REQUEST_MESSAGE = "Location services are switched off on this phone. Please open Settings → Location and turn Location on so the household can find it.";
