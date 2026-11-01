import {useEffect,useState} from "react";
import {Download,RefreshCw,Smartphone} from "lucide-react";
import {api} from "./api";
type Status={server_version:string;release:null|{version:string;size:number;signer_sha256:string;commit:string};preparation:{state:string;message?:string}};
export function AppUpdates(){
 const [status,setStatus]=useState<Status|null>(null),[error,setError]=useState("");
 useEffect(()=>{let stopped=false;const load=()=>api<Status>("/app-updates").then(s=>{if(!stopped){setStatus(s);setError("");}}).catch(e=>{if(!stopped)setError(e.message)});load();const timer=setInterval(load,15000);return()=>{stopped=true;clearInterval(timer)}},[]);
 return <section className="panel settings-card"><Smartphone size={26}/><h2>Phone app updates</h2>
 <p>The paired server selects the app version. Its persistent signing key lets future updates keep your phone’s pairing, settings and queued history.</p>
 {status?.release?<><p>Bungee {status.release.version} · {(status.release.size/1024**2).toFixed(1)} MiB · ready</p><a className="primary" href="/api/app-updates/bungee.apk" download="bungee.apk"><Download size={16}/> Download this server’s APK</a><p className="fine">Already using this server’s APK? Open Bungee → App updates on your phone to download and install updates there. Android asks you to approve installation.</p><details><summary>Signing identity</summary><code className="wrap">{status.release.signer_sha256}</code><p className="fine">Backed up with the server’s encrypted private data. Keep this key when moving the server.</p></details></>:<p role="status"><RefreshCw size={14}/> {status?.preparation.message||"Preparing this server’s APK automatically. This can take a few minutes after an update."}</p>}
 <details><summary>Moving from an older GitHub APK</summary><p>Older builds used a different signing key. Android requires one reinstall to switch to this server’s APK. First keep your saved device in the manager. After installing, use <strong>Reconnect · keep history</strong> on that device with the phone’s new public key, then scan the invitation. Saved locations stay attached to the same device.</p><p>Future server APK updates install over the existing app. Do not uninstall or purge pairing for routine upgrades.</p></details>
 {error&&<p className="error" role="alert">{error}</p>}
 </section>;
}
