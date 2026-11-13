export type CameraInstallation = {
  id: string;
  name: string;
  enrolled: boolean;
  revoked: boolean;
  binding_released?: boolean;
  duplicate_blocked_at?: number | null;
  last_contact?: number | null;
  management_report_at?: number | null;
  capabilities: string[];
  management?: null | {
    foreground_user?: boolean | null;
    camera?: null | { armed: boolean };
  };
};

type CameraPhone = CameraInstallation & {
  main_profile_name?: string | null;
  profiles?: CameraInstallation[];
};

// A rejected duplicate attempt is shown for a day (see PhoneStatus). It must not
// disable an otherwise healthy installation indefinitely.
export const DUPLICATE_NOTICE_SECONDS = 86400;
const FRESH_SECONDS = 90;

// Receipt times come from the server, so compare them with the server's clock:
// pass `Date.now() / 1000 + skew`, where skew comes from the /devices server_time.
const fresh = (now: number, at: number | null | undefined) => at != null && now - at >= -5 && now - at < FRESH_SECONDS;
const duplicateBlocked = (now: number, p: CameraInstallation) =>
  p.duplicate_blocked_at != null && now - p.duplicate_blocked_at < DUPLICATE_NOTICE_SECONDS;
const reportedActive = (now: number, p: CameraInstallation) =>
  p.enrolled && !p.revoked && !p.binding_released && !duplicateBlocked(now, p) &&
  fresh(now, p.last_contact) && fresh(now, p.management_report_at) && p.management?.foreground_user === true;

/** The installation recently reported that its Android user is not the one on screen. */
export const reportedBackground = (p: CameraInstallation, now = Date.now() / 1000) =>
  p.enrolled && !p.revoked && fresh(now, p.management_report_at) && p.management?.foreground_user === false;

/** Whether one specific installation can take a picture right now, with the reason if not. */
export function installationCamera(p: CameraInstallation, now = Date.now() / 1000): { ready: boolean; detail: string } {
  if (!p.enrolled || p.revoked || p.binding_released) return { ready: false, detail: "Not paired" };
  if (duplicateBlocked(now, p)) return { ready: false, detail: "A duplicate instance was blocked recently. Stop the duplicate or reconnect this profile." };
  if (!fresh(now, p.last_contact) || !fresh(now, p.management_report_at)) return { ready: false, detail: "No recent report. Open Bungee in this Android profile." };
  if (p.management?.foreground_user !== true) return { ready: false, detail: "This Android profile is not active. Switch to it on the phone, then try again." };
  if (!p.management?.camera?.armed || !p.capabilities.includes("take_picture")) return { ready: false, detail: "Enable theft photos and approve recovery commands locally in this profile." };
  return { ready: true, detail: "Front camera · locally enabled theft photos" };
}

// Never choose between two foreground claims during a profile switch,
// or fall back to an inactive user.
export function recoveryCamera(phone: CameraPhone | undefined, now = Date.now() / 1000): {
  target?: CameraInstallation;
  detail: string;
} {
  if (!phone) return { detail: "Select a paired phone" };
  if (!phone.enrolled || phone.revoked) return { detail: "Pair this phone first" };
  const active = [phone, ...(phone.profiles || [])].filter(p => reportedActive(now, p));
  if (active.length > 1) return { detail: "Profile switch still being reported. Wait for one active profile, or select its profile button." };
  if (!active.length) return { detail: "No active profile reported recently. Open Bungee in the active Android profile and pair it if needed." };
  const target = active[0];
  const name = target.id === phone.id ? phone.main_profile_name || phone.name : target.name;
  if (!target.management?.camera?.armed || !target.capabilities.includes("take_picture")) {
    return { detail: `${name} is active. Enable theft photos and approve recovery commands locally in that profile.` };
  }
  return { target: { ...target, name }, detail: `Front camera in ${name} · locally enabled theft photos` };
}
