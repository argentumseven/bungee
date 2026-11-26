import { useState } from 'react';
import { api } from './api';
import { ProfileCompanions } from './ProfileCompanions';
import type { PhoneProfiles } from './PhoneStatus';

export function MainProfileChoice({value,onChange,id='main-profile'}:{value:string;onChange:(value:string)=>void;id?:string}) {
 const [custom,setCustom]=useState(!['Owner','Personal'].includes(value));
 return <><label htmlFor={id}>Main Android profile</label><select id={id} value={custom?'custom':value} onChange={e=>{setCustom(e.target.value==='custom');onChange(e.target.value==='custom'?'':e.target.value);}}><option value="Owner">Owner</option><option value="Personal">Personal</option><option value="custom">Another named profile…</option></select>{custom&&<><label htmlFor={`${id}-name`}>Android profile name</label><input id={`${id}-name`} required maxLength={60} value={value} onChange={e=>onChange(e.target.value)} placeholder="The name used on your phone"/></>}</>;
}
export function ProfileSetup({ phone, invite }: { phone: PhoneProfiles; invite?: boolean }) {
  const [label, setLabel] = useState("Owner");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (phone.profiles_enabled && phone.profile_identity_confirmed) {
    return <ProfileCompanions
      deviceId={phone.id}
      deviceName={phone.name}
      profiles={[...(phone.profiles ?? []), ...(phone.profile_invitations ?? []), ...(phone.profile_archives ?? [])]}
      invite={invite}
    />;
  }
  return <section className="panel care-card sandbox-opt-in" aria-label="Android profile setup">
    <div className="panel-heading"><h2>Set up Android profiles</h2></div>
    {phone.profiles_enabled
      ? <p className="notice" role="status">Open Bungee in {phone.main_profile_name || "the main Android profile"} and let it connect before adding another profile.</p>
      : <>
        <p>Choose the Android user where this phone is already paired. That main installation supplies GPS, battery and shared recovery controls.</p>
        <form onSubmit={async e => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            await api(`/devices/${phone.id}/profiles/setup`, { method: "POST", body: JSON.stringify({ main_profile_name: label }) });
            window.dispatchEvent(new Event("bungee:refresh"));
          } catch (e) { setError((e as Error).message); }
          finally { setBusy(false); }
        }}>
          <MainProfileChoice value={label} onChange={setLabel} id={`main-${phone.id}`} />
          {error && <p className="error" role="alert">{error}</p>}
          <button className="primary" disabled={busy || !phone.enrolled}>Use {label || "selected profile"} as main</button>
        </form>
      </>}
  </section>;
}
