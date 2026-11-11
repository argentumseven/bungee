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

// Use server receipt times, not the phone's clock. Never choose between two
// foreground claims during a profile switch, or fall back to an inactive user.
export function recoveryCamera(phone: CameraPhone | undefined, now = Date.now() / 1000): {
  target?: CameraInstallation;
  detail: string;
} {
  if (!phone) return { detail: "Select a paired phone" };
  if (!phone.enrolled || phone.revoked) return { detail: "Pair this phone first" };
  const fresh = (at: number | null | undefined) => at != null && now - at >= -5 && now - at < 90;
  const active = [phone, ...(phone.profiles || [])].filter(p =>
    p.enrolled && !p.revoked && !p.binding_released && !p.duplicate_blocked_at &&
    fresh(p.last_contact) && fresh(p.management_report_at) && p.management?.foreground_user === true
  );
  if (active.length > 1) return { detail: "Profile switch still being reported. Wait for one active profile, or select its profile button." };
  if (!active.length) return { detail: "No active profile reported recently. Open Bungee in the active Android profile and pair it if needed." };
  const target = active[0];
  const name = target.id === phone.id ? phone.main_profile_name || phone.name : target.name;
  if (!target.management?.camera?.armed || !target.capabilities.includes("take_picture")) {
    return { detail: `${name} is active. Enable theft photos and approve recovery commands locally in that profile.` };
  }
  return { target: { ...target, name }, detail: `Front camera in ${name} · locally enabled theft photos` };
}
