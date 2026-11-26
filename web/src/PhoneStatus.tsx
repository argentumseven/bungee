import type { ReactNode } from "react";
import type { ProfileAgent } from "./ProfileCompanions";

export type PhoneProfiles = {
  id: string;
  name: string;
  enrolled?: boolean;
  revoked?: boolean;
  last_contact?: number | null;
  last_seen?: number | null;
  last_poll?: number | null;
  profiles_enabled?: boolean;
  main_profile_name?: string | null;
  profile_identity_confirmed?: boolean;
  profiles?: ProfileAgent[];
  profile_invitations?: ProfileAgent[];
  profile_archives?: ProfileAgent[];
  duplicate_blocked_at?: number | null;
};

export const recentContact = (d: PhoneProfiles) => {
  const contact = d.last_contact ?? d.last_seen;
  return !!contact && Date.now() / 1000 - contact < 90;
};

const mainName = (phone: PhoneProfiles) => phone.main_profile_name || "Main profile";
const date = (at?: number | null) => at ? new Date(at * 1000).toLocaleString() : "Not reported yet";

export function lastPolled(phone: PhoneProfiles) {
  const profiles = [{ name: mainName(phone), last_poll: phone.last_poll }, ...(phone.profiles ?? [])];
  const latest = profiles.reduce((last, profile) => (profile.last_poll ?? 0) > (last.last_poll ?? 0) ? profile : last);
  return latest.last_poll ? { name: latest.name, at: date(latest.last_poll) } : null;
}

export function phoneConnection(phone: PhoneProfiles, profile = false) {
  if (phone.revoked) return { tone: "neutral", label: "Disconnected" };
  if (!phone.enrolled) return { tone: "neutral", label: "Awaiting pairing" };
  if (recentContact(phone) || (!profile && phone.profiles?.some(recentContact))) return { tone: "good", label: "Connected" };
  return { tone: "neutral", label: "Offline" };
}

export function ProfileDot({ phone, profile = false }: { phone: PhoneProfiles; profile?: boolean }) {
  const state = phoneConnection(phone, profile);
  return <span className={`profile-dot ${state.tone}`} title={state.label} aria-hidden="true" />;
}

export function ConnectionBadge({ phone, profile = false }: { phone: PhoneProfiles; profile?: boolean }) {
  const state = phoneConnection(phone, profile);
  return <span className={`connection-badge ${state.tone}`}><i aria-hidden="true" />{state.label}</span>;
}

export function DuplicateNotice({ agents }: { agents: PhoneProfiles[] }) {
  const blocked = agents.filter(a => a.duplicate_blocked_at && Date.now() / 1000 - a.duplicate_blocked_at < 86400);
  if (!blocked.length) return null;
  return <div className="duplicate-notice" role="status"><strong>Duplicate instance blocked</strong><span>A second instance tried to use the active pairing for {blocked.map(a => a.name).join(", ")}. Stop the duplicate or use Reconnect to deliberately replace an installation.</span></div>;
}

export function PhoneHeader({ phone, children, networkLabel }: {
  phone: PhoneProfiles & { telemetry?: null | { battery: number; charging: boolean } };
  children?: ReactNode;
  networkLabel?: string;
}) {
  const polled = lastPolled(phone);
  return <section className="panel phone-hero" aria-label="Overall phone status">
    <div className="phone-hero-heading">
      <div><span className="eyebrow">PHONE OVERVIEW</span><h2>{phone.name}</h2></div>
      <ConnectionBadge phone={phone} />
    </div>
    <dl className="phone-facts">
      <div><dt>Battery</dt><dd>{phone.telemetry ? `${phone.telemetry.battery}%${phone.telemetry.charging ? " · charging" : ""}` : "Not reported"}</dd></div>
      {phone.profiles_enabled ? <div><dt>Last profile polled</dt><dd>{polled?.name ?? "No poll yet"}{polled && <small>{polled.at}</small>}</dd></div>
        : <div><dt>Last contact</dt><dd>{date(phone.last_contact ?? phone.last_seen)}</dd></div>}
      {networkLabel && <div><dt>Last reported network</dt><dd>{networkLabel}</dd></div>}
      <div><dt>{phone.profiles_enabled ? "Main profile status received" : "Phone status received"}</dt><dd>{date(phone.last_seen)}</dd></div>
    </dl>
    <DuplicateNotice agents={[phone, ...(phone.profiles ?? [])]} />
    {children}
  </section>;
}

export function ProfileOptions({ phone, selected, onSelect }: { phone: PhoneProfiles; selected: string; onSelect: (id: string) => void }) {
  return <>
    <button type="button" className={!selected ? "selected" : ""} aria-pressed={!selected} aria-description={phoneConnection(phone, true).label} onClick={() => onSelect("")}>
      <ProfileDot phone={phone} profile /><span>{mainName(phone)}</span><small className="profile-role">Main</small>
    </button>
    {phone.profiles?.map(profile => <button type="button" key={profile.id} className={selected === profile.id ? "selected" : ""} aria-pressed={selected === profile.id} aria-description={phoneConnection(profile, true).label} onClick={() => onSelect(profile.id)}>
      <ProfileDot phone={profile} profile /><span>{profile.name}</span>
    </button>)}
  </>;
}

export function ProfileTabs(props: Parameters<typeof ProfileOptions>[0]) {
  if (!props.phone.profiles_enabled) return null;
  return <nav className="profile-tabs" aria-label="Phone profiles"><ProfileOptions {...props} /></nav>;
}
