import { useState } from "react";
import { Clipboard, RefreshCw } from "lucide-react";
import { version } from "../../release.json";

const command = "cd /usr/local/src/bungee &&\ngit pull --ff-only origin main &&\nsudo python3 scripts/bungee-host.py rebuild &&\nsudo python3 /opt/bungee/bungee-host.py status";

export function ServerUpdates() {
  const [notice, setNotice] = useState("");
  return <section className="panel settings-card server-updates" aria-label="Server updates">
    <RefreshCw size={26}/>
    <h2>Update this server</h2>
    <p>Running Bungee {version}. After GitHub changes, run this on your server from the source checkout. Change the paths if you installed elsewhere.</p>
    <pre><code>{command}</code></pre>
    <button className="secondary" onClick={async () => {
      try { await navigator.clipboard.writeText(command); setNotice("Update command copied. Run it in your server terminal."); }
      catch { setNotice("Select and copy the command above, then run it in your server terminal."); }
    }}><Clipboard size={16}/> Copy update command</button>
    {notice && <p role="status">{notice}</p>}
    <p>A Git pull updates source; rebuild updates the running containers and dashboard, with an encrypted snapshot and health checks. Pairing and saved history are preserved. Update the server before installing its matching phone APK.</p>
    <p className="fine">This is a manual source update. The host timer checks published container releases separately; the dashboard does not query GitHub for updates.</p>
  </section>;
}
