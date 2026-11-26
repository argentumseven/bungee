import { useState } from "react";
import { Plus } from "lucide-react";
import QRCode from "qrcode";
import { api } from "./api";
import { ConnectionBadge, type ProfileAgent } from "./PhoneStatus";

export function ProfileCompanions({ deviceId, deviceName, profiles, invite }: {
  deviceId: string;
  deviceName: string;
  profiles: ProfileAgent[];
  invite?: boolean;
}) {
  const [formOpen, setFormOpen] = useState(!!invite);
  const [reconnect, setReconnect] = useState<ProfileAgent>();
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [invitation, setInvitation] = useState("");
  const [qr, setQr] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const atLimit = profiles.filter(p => !p.revoked).length >= 8;

  function showForm(profile?: ProfileAgent) {
    setReconnect(profile);
    setName(profile?.name ?? "");
    setKey("");
    setInvitation("");
    setQr("");
    setError("");
    setNotice("");
    setFormOpen(true);
  }

  async function changePairing(profile: ProfileAgent, action: "disconnect" | "revoke" | "archive" | "binding") {
    const scope = `Only ${profile.name} on ${deviceName} is affected.`;
    const messages = {
      disconnect: profile.enrolled ? `Disconnect ${profile.name} and keep its captures?` : `Cancel the invitation for ${profile.name}?`,
      revoke: `Revoke ${profile.name} and permanently erase its captures, events and command history?`,
      archive: `Remove the saved ${profile.name} record and its remaining captures?`,
      binding: `Remove inactive pairing keys for ${profile.name} and keep its saved records?`,
    };
    if (!window.confirm(`${messages[action]} ${scope}`)) return;
    const suffix = action === "revoke" ? "" : `/${action}`;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api(`/devices/${profile.id}${suffix}`, action === "disconnect" ? { method: "POST", body: "{}" } : { method: "DELETE" });
      setNotice({
        disconnect: profile.enrolled ? `${profile.name} disconnected. Its saved captures were kept.` : `Invitation canceled for ${profile.name}.`,
        revoke: `${profile.name} revoked and its saved data erased.`,
        archive: `${profile.name} removed.`,
        binding: `Inactive keys removed for ${profile.name}.`,
      }[action]);
      window.dispatchEvent(new Event("bungee:refresh"));
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  return <section className="panel care-card profile-companions" aria-label="Android profiles">
    <div className="panel-heading">
      <h2>Android profiles</h2>
      <button type="button" className="secondary" disabled={atLimit || busy} onClick={() => showForm()}><Plus size={15} /> Add Android profile</button>
    </div>
    {atLimit && <p className="fine">This phone has eight linked or invited profiles.</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {notice && <p className="notice" role="status">{notice}</p>}
    {formOpen && <div className="profile-setup">
      <h3>{reconnect ? `Reconnect ${reconnect.name}` : "Pair another Android profile"}</h3>
      <p className="fine">Open Bungee in the Android user you’re adding. Copy its WireGuard public key, then scan the invitation in that same user.</p>
      <form onSubmit={async e => {
        e.preventDefault();
        setBusy(true);
        setError("");
        setNotice("");
        try {
          const result = await api(reconnect ? `/devices/${reconnect.id}/reconnect` : "/enrollments", {
            method: "POST",
            body: JSON.stringify({
              wg_public_key: key.trim(),
              ...(!reconnect && { name: name.trim(), primary_device_id: deviceId }),
            }),
          });
          const text = JSON.stringify(result);
          setInvitation(text);
          setQr(await QRCode.toDataURL(text, { width: 320, margin: 2 }));
          setNotice("Profile invitation ready. It expires in ten minutes.");
          window.dispatchEvent(new Event("bungee:refresh"));
        } catch (e) { setError((e as Error).message); }
        finally { setBusy(false); }
      }}>
        <label htmlFor="profile-name">Profile name</label>
        <input id="profile-name" value={name} maxLength={60} required disabled={!!reconnect} placeholder="Sandbox" onChange={e => setName(e.target.value)} />
        <label htmlFor="profile-key">Public key from that profile’s Bungee app</label>
        <input id="profile-key" value={key} required autoComplete="off" onChange={e => setKey(e.target.value)} />
        <div className="profile-actions">
          <button className="primary" disabled={busy || (!reconnect && atLimit)}>
            {reconnect ? "Create reconnect invitation" : "Create profile invitation"}
          </button>
          <button type="button" className="secondary" disabled={busy} onClick={() => { setFormOpen(false); setInvitation(""); setQr(""); }}>Close invitation setup</button>
        </div>
      </form>
      {invitation && <div className="profile-invitation">
        {qr && <img src={qr} alt={`Private pairing invitation for ${name}`} width={320} height={320} />}
        <label htmlFor="profile-invitation">Invitation text</label>
        <textarea id="profile-invitation" readOnly value={invitation} rows={4} />
        <button type="button" className="secondary" onClick={() => { setInvitation(""); setQr(""); }}>Hide invitation</button>
      </div>}
    </div>}
    {profiles.map(profile => <article className="profile-agent" key={profile.id}>
      <div className="panel-heading"><h3>{profile.name}</h3><ConnectionBadge phone={profile} /></div>
      {!profile.enrolled && !profile.revoked && <p className="fine">{profile.enrollment_state === "expired" ? "Invitation expired" : "Invitation pending"}</p>}
      <div className="profile-actions">
        {!profile.revoked && <button type="button" className="secondary" disabled={busy} onClick={() => void changePairing(profile, "disconnect")}>
          {profile.enrolled ? "Disconnect profile · keep captures" : "Cancel profile invitation"}
        </button>}
        {profile.enrolled && !profile.revoked && <button type="button" className="danger-button" disabled={busy} onClick={() => void changePairing(profile, "revoke")}>Revoke profile &amp; erase data</button>}
        {profile.revoked && <button type="button" className="secondary" disabled={busy} onClick={() => showForm(profile)}>Reconnect profile</button>}
        {profile.revoked && profile.can_purge_binding && <button type="button" className="secondary" disabled={busy} onClick={() => void changePairing(profile, "binding")}>Remove inactive keys</button>}
        {profile.revoked && profile.binding_released && <button type="button" className="danger-button" disabled={busy} onClick={() => void changePairing(profile, "archive")}>Remove saved profile</button>}
      </div>
    </article>)}
  </section>;
}
