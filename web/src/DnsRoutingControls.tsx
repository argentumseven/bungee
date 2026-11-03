import {useEffect,useState} from 'react';
import {LoaderCircle,Power,ShieldCheck,Trash2} from 'lucide-react';
import {api} from './api';
export type DnsProfile={revision:number;enabled:boolean;requested_enabled:boolean;fallback:boolean;removed:boolean;hostname:string;configured:boolean;report:{revision:number;state:string;active:boolean;consent:boolean;permission:boolean;detail:string;at:number}|null};
export function DnsRoutingControls({id,name,profile,onSaved,canEnable}:{id:string;name:string;profile:DnsProfile;canEnable:boolean;onSaved:()=>void}){
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[removing,setRemoving]=useState(false),[fallback,setFallback]=useState(profile.fallback),[offlineConfirm,setOfflineConfirm]=useState(false);
 useEffect(()=>setFallback(profile.fallback),[profile.fallback,profile.revision]);
 const report=profile.report,cleared=profile.removed&&!profile.hostname,pending=!cleared&&profile.revision>0&&(!report||report.revision<profile.revision);
 async function save(action:string,fallback=profile.fallback){
  setBusy(true);setError('');setNotice('');
  try{await api(`/devices/${encodeURIComponent(id)}/private-dns`,{method:'POST',body:JSON.stringify({expected_revision:profile.revision,action,fallback,...(action==='confirm_restored'?{restored_locally:true}:{})})});setRemoving(false);setOfflineConfirm(false);setNotice(action==='confirm_restored'?'DNS setup removed after your confirmation of local restoration.':action==='remove'?'Removal requested. Keep the app running until it confirms DNS restoration.':action==='disable'?'Off requested. Waiting for the phone to restore its previous DNS setting.':'Setting saved. Waiting for the phone to apply it.');onSaved();}
  catch(e){setFallback(profile.fallback);setError((e as Error).message);}finally{setBusy(false);}
 }
 return <section className="panel dns-private-controls" aria-label={`DNS controls for ${name}`}>
  <div><span className="eyebrow">THIS PHONE</span><h2>DNS controls · {name}</h2><p>{cleared?'DNS setup removed; local restoration confirmed':pending?'Change pending · waiting for phone confirmation':report?.detail||'Open the updated phone app and approve household DNS control.'}</p>
  {report&&<p className="fine">Last phone report: {new Date(report.at*1000).toLocaleString()} · {report.active?'Private DNS selected':'Bungee DNS not active'}</p>}</div>
  {!profile.configured&&<p className="dns-config-note">A public Bungee DNS-over-TLS hostname and trusted wildcard certificate are required before turning this on. Your home resolver’s outgoing HTTPS setting does not provide this connection.</p>}
  {profile.configured&&(!report?.permission||!report.consent)&&<p className="dns-config-note">On {name}, grant the one-time ADB permission shown in Home DNS, then enable “Allow household DNS control.”</p>}
  <label className="dns-fallback"><input type="checkbox" checked={fallback} disabled={busy} onChange={e=>{setFallback(e.target.checked);void save('fallback',e.target.checked);}}/><span><strong>Fall back to normal DNS if requests fail</strong><small>Three failed checks switch the running phone to Automatic DNS. It stays there until you retry. Filtering and Bungee DNS logging are bypassed during fallback.</small></span></label>
  <div className="dns-private-actions"><button className="primary" disabled={busy||!canEnable||!profile.configured||!report?.permission||!report.consent} onClick={()=>void save('enable')}><ShieldCheck size={16}/> Turn on / retry DNS</button><button className="secondary" disabled={busy} onClick={()=>void save('disable')}><Power size={16}/> Turn DNS off</button><button className="dns-erase" disabled={busy} onClick={()=>setRemoving(v=>!v)}><Trash2 size={16}/> Remove DNS setup</button>{busy&&<LoaderCircle size={17} className="spin"/>}</div>
  {removing&&<div className="dns-remove-confirm"><p>Remove this phone’s DNS setup after restoring its previous setting? Keep the relay running until the phone confirms removal. This keeps pairing, DNS history and other Bungee features.</p><button className="secondary" disabled={busy} onClick={()=>setRemoving(false)}>Keep DNS setup</button> <button className="dns-erase" disabled={busy} onClick={()=>void save('remove')}>Restore &amp; remove DNS</button></div>}
  {pending&&profile.removed&&<div className="dns-remove-confirm"><p>If the phone is offline, restore its Private DNS in Android settings or Bungee’s offline recovery first. Confirm below only after checking that it uses normal DNS.</p><label><input type="checkbox" checked={offlineConfirm} onChange={e=>setOfflineConfirm(e.target.checked)}/> I restored DNS on this phone and verified it no longer uses Bungee.</label><p><button className="secondary" disabled={busy||!offlineConfirm} onClick={()=>void save('confirm_restored')}>Confirm local restoration &amp; remove profile</button></p></div>}
  {error&&<p className="error" role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
  <p className="fine">For app removal, use “Remove DNS setup” on the phone first. Android cannot run cleanup after uninstall or force-stop. A fallback needs the DNS monitor running.</p>
 </section>;
}
