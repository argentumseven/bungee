import { useEffect, useState } from "react";
import { ChevronDown, Download, Fingerprint, RefreshCw, Smartphone, TriangleAlert } from "lucide-react";
import { api } from "./api";

type Status = {
  server_version: string;
  release: null | { version: string; size: number; signer_sha256: string; commit: string };
  preparation: { state: string; message?: string; downloaded_bytes?: number; total_bytes?: number };
};
const mib = (bytes: number) => (bytes / 1024 ** 2).toFixed(1);

export function AppUpdates() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        const result = await api<Status>("/app-updates", { signal: controller.signal });
        if (!controller.signal.aborted) { setStatus(result); setError(""); }
      } catch (e) {
        if (!controller.signal.aborted) setError((e as Error).message);
      } finally { pending = false; }
    };
    void load();
    const timer = setInterval(load, 3000);
    return () => { controller.abort(); clearInterval(timer); };
  }, []);
  const release = status?.release;
  const downloaded = status?.preparation.downloaded_bytes ?? 0;
  const total = status?.preparation.total_bytes ?? 0;
  return <section className="panel settings-card app-updates">
    <div className="updates-heading"><Smartphone size={22} /><h2>Phone app updates</h2></div>
    <p>GitHub and this server distribute the same official APK with one persistent signing key. Routine updates keep pairing, settings, and queued history.</p>
    {release ? <>
      <div className="apk-release">
        <div><strong>Bungee {release.version}</strong><small>{mib(release.size)} MiB · Ready to download</small></div>
        <a className="primary" href="/api/app-updates/bungee.apk" download="bungee.apk"><Download size={16} /> Download APK</a>
      </div>
      <p className="fine">On a paired phone, open Bungee → App updates to download the update. Android will ask you to approve installation.</p>
      <details className="apk-details">
        <summary><Fingerprint size={17} /> Signing identity <ChevronDown size={16} /></summary>
        <div className="apk-details-content">
          <p>The server verifies the APK against this official release certificate and serves the GitHub release unchanged.</p>
          <div className="apk-fingerprint"><strong>SHA-256 certificate fingerprint</strong><code>{release.signer_sha256}</code></div>
        </div>
      </details>
    </> : <div role="status" className="apk-preparation">
      <p><RefreshCw size={15} /> {status?.preparation.message || "Preparing this server’s APK. This can take a few minutes after an update."}</p>
      {status?.preparation.state === "preparing" && <progress aria-label="Server APK preparation" {...(total > 0 ? { value: downloaded, max: total } : {})} />}
      {total > 0 && status?.preparation.state === "preparing" && <p className="fine">{Math.min(100, Math.floor(downloaded * 100 / total))}% · {mib(downloaded)} / {mib(total)} MiB</p>}
    </div>}
    <details className="apk-details apk-recovery">
      <summary><TriangleAlert size={17} /> Phone says “different signing key”? <ChevronDown size={16} /></summary>
      <div className="apk-details-content">
        <p>Android requires the update and the installed app to share a signing certificate. Keep the saved phone record in the dashboard so its history stays available.</p>
        <h3>Previously installed this server’s APK</h3>
        <p>Older household-signed installations receive compatible in-app updates when the original key is available. If the key is missing, restore the original APK signing identity from its encrypted backup.</p>
        <h3>Installed a historical GitHub APK</h3>
        <p>Those builds used disposable signing keys. Follow these steps to switch to the official APK.</p>
        <ol>
          <li>Let queued phone data upload. Uninstalling removes unsent data from the phone.</li>
          <li>Download the APK above. Turn off removable device administration in Bungee, then uninstall the old app and install the downloaded APK.</li>
          <li>On the same saved phone in Pairing &amp; history, choose <strong>Reconnect · keep history</strong> with the new phone public key and scan the invitation.</li>
        </ol>
      </div>
    </details>
    {error && <p className="error" role="alert">{error}</p>}
  </section>;
}
