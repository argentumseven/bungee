import type { ReactNode } from "react";

type ProfileManagement = {
  foreground_user?: boolean | null;
  recovery_consent?: boolean;
  app_version_code?: number | null;
  camera?: null | { armed: boolean };
};

export type ProfileAgent = {
  id: string;
  name: string;
  enrolled: boolean;
  revoked: boolean;
  capabilities: string[];
  last_contact?: number | null;
  last_seen?: number | null;
  management_report_at?: number | null;
  duplicate_blocked_at?: number | null;
  binding_released?: boolean;
  can_purge_binding?: boolean;
  enrollment_state?: string;
  management?: ProfileManagement | null;
};

type ForegroundFocus = { state: "active"; id: string; since_ms: number | null } | { state: "switching" | "unknown" };

export type PhoneProfiles = Pick<ProfileAgent, "id" | "name" | "last_seen" | "last_contact" | "management" | "management_report_at" | "duplicate_blocked_at">
  & Partial<Pick<ProfileAgent, "enrolled" | "revoked">> & {
  profiles_enabled?: boolean;
  main_profile_name?: string | null;
  profile_identity_confirmed?: boolean;
  profiles?: ProfileAgent[];
  profile_invitations?: ProfileAgent[];
  profile_archives?: ProfileAgent[];
  focus?: ForegroundFocus;
};

type ConnectionRecord = Pick<PhoneProfiles, "enrolled" | "revoked" | "last_contact" | "last_seen" | "profiles">;
const date = (at?: number | null) => at ? new Date(at * 1000).toLocaleString() : "Not reported yet";

export function recentContact(d: ConnectionRecord, now = Date.now() / 1000) {
  const contact = d.last_contact ?? d.last_seen;
  return !!contact && now - contact < 90;
}

export function phoneConnection(phone: ConnectionRecord, now: number) {
  if (phone.revoked) return { tone: "disconnected", label: "Disconnected" };
  if (!phone.enrolled) return { tone: "neutral", label: "Awaiting pairing" };
  if (recentContact(phone, now) || phone.profiles?.some(p => recentContact(p, now))) {
    return { tone: "good", label: "Connected" };
  }
  return { tone: "lost", label: "No recent contact" };
}

export function ProfileDot({ phone, now }: { phone: ConnectionRecord; now: number }) {
  const state = phoneConnection(phone, now);
  return <span className={`profile-dot ${state.tone}`} title={state.label} aria-hidden="true" />;
}

export function ConnectionBadge({ phone, now = Date.now() / 1000 }: { phone: ConnectionRecord; now?: number }) {
  const state = phoneConnection(phone, now);
  return <span className={`connection-badge ${state.tone}`}><ProfileDot phone={phone} now={now} />{state.label}</span>;
}

export const profileName = (phone: PhoneProfiles, id: string) =>
  id === phone.id ? phone.main_profile_name || phone.name : [...(phone.profiles ?? []), ...(phone.profile_archives ?? [])].find(p => p.id === id)?.name;
export const focusLabel = (phone: PhoneProfiles) =>
  phone.focus?.state === "active" ? profileName(phone, phone.focus.id) ?? "Focus unconfirmed"
    : phone.focus?.state === "switching" ? "Switching profiles" : "Focus unconfirmed";

function DuplicateNotice({ agents, now }: { agents: PhoneProfiles[]; now: number }) {
  const blocked = agents.filter(a => a.duplicate_blocked_at && now - a.duplicate_blocked_at < 86400);
  if (!blocked.length) return null;
  return <div className="duplicate-notice" role="status"><strong>Duplicate instance blocked</strong><span>A second instance tried to use the active pairing for {blocked.map(a => a.name).join(", ")}. Stop the duplicate or reconnect its pairing in Pairing &amp; history.</span></div>;
}

export function PhoneHeader({ phone, children, networkLabel, now }: {
  phone: PhoneProfiles & { telemetry?: null | { battery: number; charging: boolean } };
  children?: ReactNode;
  networkLabel?: string;
  now: number;
}) {
  const profiles = [phone, ...(phone.profiles ?? [])];
  const activeId = phone.focus?.state === "active" ? phone.focus.id : undefined;
  return <section className="panel phone-hero" aria-label="Overall phone status">
    <div className="phone-hero-heading">
      <div><span className="eyebrow">PHONE OVERVIEW</span><h2>{phone.name}</h2></div>
      <ConnectionBadge phone={phone} now={now} />
    </div>
    <dl className="phone-facts">
      <div><dt>Battery</dt><dd>{phone.telemetry ? `${phone.telemetry.battery}%${phone.telemetry.charging ? " · charging" : ""}` : "Not reported"}</dd></div>
      {phone.profiles_enabled ? <div><dt>Active Android profile</dt><dd>{focusLabel(phone)}</dd></div>
        : <div><dt>Last contact</dt><dd>{date(phone.last_contact ?? phone.last_seen)}</dd></div>}
      {networkLabel && <div><dt>Last reported network</dt><dd>{networkLabel}</dd></div>}
      <div><dt>{phone.profiles_enabled ? "Main profile status received" : "Phone status received"}</dt><dd>{date(phone.last_seen)}</dd></div>
    </dl>
    {phone.profiles_enabled && <div className="phone-profile-list">
      <h3>Android profiles</h3>
      <ul aria-label="Android profile status">{profiles.map(profile => {
        const state = profile.id === activeId ? "Active" : activeId ||
          (profile.management?.foreground_user === false && !!profile.management_report_at && now - profile.management_report_at < 90)
          ? "Background" : "Focus unconfirmed";
        return <li key={profile.id}>
          <strong>{profileName(phone, profile.id)}{profile.id === phone.id && <small className="profile-role">Main</small>}</strong>
          <span className={state === "Active" ? "profile-active" : "profile-focus-state"}>{state}</span>
          <ConnectionBadge phone={{ ...profile, profiles: undefined }} now={now} />
        </li>;
      })}</ul>
    </div>}
    <DuplicateNotice agents={profiles} now={now} />
    {children}
  </section>;
}
