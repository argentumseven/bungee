import {useEffect,useState} from "react";
import {Download,RefreshCw,Smartphone,TriangleAlert} from "lucide-react";
import {api} from "./api";
type Status={server_version:string;release:null|{version:string;size:number;signer_sha256:string;commit:string};preparation:{state:string;message?:string;downloaded_bytes?:number;total_bytes?:number}};
export function AppUpdates(){
 const [status,setStatus]=useState<Status|null>(null),[error,setError]=useState("");
 useEffect(()=>{let stopped=false;const load=()=>api<Status>("/app-updates").then(s=>{if(!stopped){setStatus(s);setError("");}}).catch(e=>{if(!stopped)setError(e.message)});load();const timer=setInterval(load,3000);return()=>{stopped=true;clearInterval(timer)}},[]);
 const downloaded=status?.preparation.downloaded_bytes??0,total=status?.preparation.total_bytes??0;
 return <section className="panel settings-card app-updates"><Smartphone size={26}/><h2>Phone app updates</h2>
 <p>GitHub and this server distribute the same official APK, signed with one persistent release key. Routine updates keep pairing, settings and queued history.</p>
 {status?.release?<><p>Bungee {status.release.version} · {(status.release.size/1024**2).toFixed(1)} MiB · ready</p><a className="primary" href="/api/app-updates/bungee.apk" download="bungee.apk"><Download size={16}/> Download this server’s APK</a><p className="fine">Already using this server’s APK? Open Bungee → App updates on your phone to download and install updates there. Android asks you to approve installation.</p><details><summary>Signing identity</summary><code className="wrap">{status.release.signer_sha256}</code><p className="fine">This is the official release certificate. The server verifies the APK and serves the GitHub release unchanged; it does not hold the publisher’s private key.</p></details></>:<div role="status" className="apk-preparation"><p><RefreshCw size={14}/> {status?.preparation.message||"Preparing this server’s APK automatically. This can take a few minutes after an update."}</p>{status?.preparation.state==="preparing"&&<progress aria-label="Server APK preparation" {...(total>0?{value:downloaded,max:total}:{})}/>} {total>0&&status?.preparation.state==="preparing"&&<p className="fine">{Math.min(100,Math.floor(downloaded*100/total))}% · {(downloaded/1024**2).toFixed(1)} / {(total/1024**2).toFixed(1)} MiB</p>}</div>}
 <details className="apk-recovery"><summary><TriangleAlert size={16}/> Phone says “different signing key”?</summary>
 <p>Android blocks updates signed by a different key. Checking again or downloading another GitHub APK cannot change that. Do not purge the phone’s saved device.</p>
 <p><strong>If this phone previously used this server’s APK:</strong> older household-signed installations keep a compatible update from this server automatically. If that compatibility key is missing, restore the original APK signing identity from its encrypted backup before considering a reinstall.</p>
 <p><strong>If the phone uses a historical GitHub APK:</strong> those builds had disposable signing keys. Switch once to this server’s APK:</p>
 <ol><li>Let queued phone data upload first. Uninstalling removes unsent data from the phone. Keep its saved device in this manager.</li><li>Download this server’s APK above. Turn off removable device administration in Bungee, uninstall the old app, then install the server APK.</li><li>On the same saved device, choose <strong>Reconnect · keep history</strong> with the new phone public key, then scan the invitation. GPS, IP history and photos already saved on the server stay attached to that device.</li></ol>
 <p>Official GitHub and server updates now use the same release certificate. Existing household-signed phones receive compatible in-app updates. Do not uninstall for routine upgrades.</p></details>
 {error&&<p className="error" role="alert">{error}</p>}
 </section>;
}
