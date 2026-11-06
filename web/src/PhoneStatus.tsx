import type { ProfileAgent } from './ProfileCompanions';
export type PhoneProfiles = {
  id: string; name: string; enrolled?: boolean; revoked?: boolean;
  last_contact?: number | null; last_seen?: number | null;
  profiles_enabled?: boolean; main_profile_name?: string | null;
  profile_identity_confirmed?: boolean; profiles?: ProfileAgent[];
  profile_invitations?: ProfileAgent[]; profile_archives?: ProfileAgent[];
  duplicate_blocked_at?: number | null;
};
export const recentContact=(d:{last_contact?:number|null;last_seen?:number|null})=>!!(d.last_contact??d.last_seen) && Date.now()/1000-(d.last_contact??d.last_seen??0)<90;
export function phoneConnection(d:PhoneProfiles) {
  if (!d.enrolled || d.revoked) return {tone:'neutral',label:d.revoked?'Disconnected':'Awaiting pairing',detail:'Pairing must finish before this phone can connect.'};
  if (recentContact(d)) return {tone:'good',label:'Connected',detail:d.profiles_enabled?'Main profile connected · phone status available':'Authenticated connection to your server'};
  if (d.profiles?.some(recentContact)) return {tone:'limited',label:'Profile connected',detail:'Main profile offline · phone-wide status may be old'};
  return {tone:'neutral',label:'Offline',detail:'Showing saved information · reconnects when the phone is available'};
}
export function ConnectionBadge({phone,profile=false}:{phone:PhoneProfiles;profile?:boolean}) {
  const state=phoneConnection(profile?{...phone,profiles:[]}:phone);
  return <span className={`connection-badge ${state.tone}`} title={state.detail}><i aria-hidden="true"/>{state.label}</span>;
}
export function DuplicateNotice({agents}:{agents:PhoneProfiles[]}) {
  const blocked=agents.filter(a=>a.duplicate_blocked_at && Date.now()/1000-a.duplicate_blocked_at<86400);
  if(!blocked.length)return null;
  return <div className="duplicate-notice" role="status"><strong>Duplicate instance blocked</strong><span>{blocked.map(a=>a.name).join(', ')}: a second instance attempted to use an active pairing. The accepted connection keeps its role. Stop the duplicate; use Reconnect to deliberately replace an installation.</span></div>;
}
export function PhoneHeader({phone,children,networkLabel}:{phone:PhoneProfiles & {telemetry?:null|{battery:number;charging:boolean};last_seen?:number|null};children?:React.ReactNode;networkLabel?:string}) {
  const state=phoneConnection(phone);
  const date=(at?:number|null)=>at?new Date(at*1000).toLocaleString():'Not reported yet';
  return <section className="panel phone-hero" aria-label="Overall phone status"><div className="phone-hero-heading"><div><span className="eyebrow">{phone.profiles_enabled?'PHONE OVERVIEW':'YOUR PHONE'}</span><h2>{phone.name}</h2><p>{state.detail}</p></div><ConnectionBadge phone={phone}/></div><div className="phone-facts"><div><span>Battery</span><strong>{phone.telemetry?`${phone.telemetry.battery}%${phone.telemetry.charging?' · charging':''}`:'Not reported'}</strong></div><div><span>{phone.profiles_enabled?'Main profile contact':'Last contact'}</span><strong>{date(phone.last_contact??phone.last_seen)}</strong></div>{phone.profiles_enabled&&<div><span>Paired profiles</span><strong>{1+(phone.profiles?.length||0)} <small>including main</small></strong></div>}{networkLabel&&<div><span>Last reported network</span><strong>{networkLabel}</strong></div>}<div><span>Phone status received</span><strong>{date(phone.last_seen)}</strong></div></div><DuplicateNotice agents={[phone,...(phone.profiles||[])]}/>{children}</section>;
}
export function ProfileTabs({phone,selected,onSelect}:{phone:PhoneProfiles;selected:string;onSelect:(id:string)=>void}) {
  if(!phone.profiles_enabled || !phone.profiles?.length)return null;
  return <nav className="profile-tabs" aria-label="Phone profiles"><button className={!selected?'selected':''} onClick={()=>onSelect('')}>Phone overview</button><button className={selected===phone.id?'selected':''} onClick={()=>onSelect(phone.id)}>{phone.main_profile_name||'Main profile'} <small>Main</small></button>{phone.profiles.map(p=><button key={p.id} className={selected===p.id?'selected':''} onClick={()=>onSelect(p.id)}><i className={`profile-dot ${recentContact(p)?'good':'neutral'}`} aria-hidden="true"/>{p.name}</button>)}</nav>;
}
