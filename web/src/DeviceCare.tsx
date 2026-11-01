import React, { useEffect, useState } from "react";
import {
  ShieldCheck,
  Radio,
  RefreshCw,
  LockKeyhole,
  Trash2,
  Globe,
} from "lucide-react";
import { api } from "./api";
import { RecoveryMessagePreview } from "./RecoveryMessagePreview";
import { RecoveryPhotos } from "./RecoveryPhotos";

type Policy = {
  managed_dns: boolean;
  auto_resume: boolean;
  always_on: boolean;
  protect_settings: boolean;
  prevent_uninstall: boolean;
  require_strong_lock: boolean;
  blocked_apps: string[];
  lost_mode: boolean;
  haste?:boolean;
  recovery_message: string;
};
type Report = {
  system_dns?:{available:boolean;servers:string[];private_dns_active:boolean;private_dns_name:string|null;captured_by_bungee:false}|null;
  owner: boolean;
  consent: boolean;
  recovery_consent: boolean;
  revision: number;
  dns_active: boolean;
  always_on: boolean;
  uninstall_blocked: boolean;
  protection_active: boolean;
  strong_lock_required: boolean;
  blocked_apps: string[];
  lost_mode_active: boolean;
  errors: string[];
  android_version: string;
  security_patch: string;
  secure_lock: boolean;
  screen_locked: boolean;
  unlock_monitoring: boolean;
  failed_unlocks: number;
  last_failed_at: number | null;
  camera?: { armed: boolean; pending: number; dropped: number; status: string; reported_at: number; failed_in_row?: number; queued?:{id:string;captured_at:number;reason:string}[] } | null;
  delivery?: null | {
    reported_at: number;
    queued_fixes: number;
    dropped_fixes: number;
    oldest_queued_at: number | null;
    pending_receipts: number;
    gps_access?: string | null;
  };
};
type Saved = {
  revision: number;
  policy: Policy;
  report: Report | null;
  dns_configured: boolean;
  dns_upstream: string | null;
  persistent_controls_enabled: false;
  legacy_policy_present: boolean;
};
type DnsRow = {
  domain: string;
  queries: number;
  activities: number;
  last_at: number;
  answers: number;
  nxdomain: number;
  errors: number;
  types: Record<string, number>;
};
type DnsSummary = {
  records: DnsRow[];
  queries: number;
  activities: number;
  domains: number;
  configured: boolean;
  from: number;
  to: number;
};
const time = (n: number) => new Date(n * 1000).toLocaleString();
export function DeviceCare({
  device,
}: {
  device: { id: string; name: string };
}) {
  const [saved, setSaved] = useState<Saved | null>(null),
    [draft, setDraft] = useState<Policy | null>(null);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const [days, setDays] = useState(1),
    [dns, setDns] = useState<DnsSummary | null>(null),
    [dnsReload, setDnsReload] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    const load = (initial = false) =>
      api<Saved>(`/devices/${device.id}/policy`, { signal: abort.signal })
        .then((data) => {
          setSaved(data);
          if (initial) {
            setDraft(data.policy);
            setRevision(data.revision);
          }
        })
        .catch((e) => {
          if (!abort.signal.aborted) setError(e.message);
        });
    void load(true);
    const timer = setInterval(() => void load(), 5000);
    return () => {
      abort.abort();
      clearInterval(timer);
    };
  }, [device.id]);
  useEffect(() => {
    const abort = new AbortController();
    const to = Math.floor(Date.now() / 1000),
      from = to - days * 86400;
    setDns(null);
    api<DnsSummary>(`/devices/${device.id}/dns?from=${from}&to=${to}`, {
      signal: abort.signal,
    })
      .then(setDns)
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      });
    return () => abort.abort();
  }, [device.id, days, dnsReload]);
  const report = saved?.report;
  const set = (key: keyof Policy, value: boolean) =>
    setDraft((old) => (old ? { ...old, [key]: value } : old));
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!draft) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const policy = {
        ...draft,
        managed_dns: false,
        always_on: false,
        auto_resume: false,
        protect_settings: false,
        prevent_uninstall: false,
        require_strong_lock: false,
        blocked_apps: [],
      };
      const result = await api<{ revision: number; policy: Policy }>(
        `/devices/${device.id}/policy`,
        {
          method: "POST",
          body: JSON.stringify({ expected_revision: revision, policy }),
        },
      );
      setRevision(result.revision);
      setDraft(result.policy);
      setSaved((old) => (old ? { ...old, ...result } : old));
      setNotice(
        "Saved. Wait for the phone to report the new revision and check for errors.",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function eraseDns() {
    if (
      !window.confirm(
        `Erase saved DNS summaries for ${device.name} from this server?`,
      )
    )
      return;
    try {
      await api(`/devices/${device.id}/dns`, { method: "DELETE" });
      setDnsReload((n) => n + 1);
      setNotice("DNS summaries erased.");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <div className="device-care">
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="care-notice" role="status">
          {notice}
        </div>
      )}
      {!saved || !draft ? (
        <p>Loading device care…</p>
      ) : (
        <>
          <div className="care-grid">
            <form className="panel care-card" onSubmit={save}>
              <div className="panel-heading">
                <h2>
                  <LockKeyhole size={18} />
                  Recovery & management
                </h2>
                <span className="map-badge">
                  {report?.owner ? "LEGACY OWNER" : "PERSONAL"}
                </span>
              </div>
              <Toggle
                label="Lost mode"
                checked={draft.lost_mode}
                disabled={!report?.recovery_consent || busy}
                onChange={(v) => setDraft(old=>old?{...old,lost_mode:v,haste:v?old.haste:false}:old)}
                note="Keep lost mode pending while offline. On reconnect, the phone attempts one lock per revision and shows your message if permissions allow."
              />
              <Toggle label="Faster GPS (haste)" checked={!!draft.haste} disabled={!draft.lost_mode || !report?.recovery_consent || busy} onChange={v=>set("haste",v)} note="While lost mode is active, sample about every 10 seconds with a shorter averaging window. Uses more battery; precise location permission and local consent still apply."/>
              <label htmlFor="lost-contact">Recovery contact message</label>
              <textarea
                id="lost-contact"
                value={draft.recovery_message}
                maxLength={240}
                required={draft.lost_mode}
                disabled={busy}
                onChange={(e) =>
                  setDraft({ ...draft, recovery_message: e.target.value })
                }
                placeholder="This phone is lost. Please call…"
              />
              <p className="fine">
                Android controls lock-screen visibility. Lost mode leaves
                credential entry accessible. Send an alarm separately.
              </p>
              <details className="message-preview-details">
                <summary>Preview recovery message</summary>
                <RecoveryMessagePreview message={draft.recovery_message} lost />
              </details>
              <div className="notice">
                Bungee uses removable device administration for screen locking
                and failed-unlock reports. Device ownership, forced DNS, app
                suspension and uninstall restrictions are unavailable. To stop
                Bungee offline, open “Bungee recovery” on the phone.
              </div>
              {(report?.owner || saved.legacy_policy_present) && (
                <div className="error" role="alert">
                  Legacy device ownership or policy detected. Do not uninstall,
                  clear app data or change APK signing keys. Local cleanup can
                  release known policies but cannot guarantee removing Android
                  ownership without a reset.
                </div>
              )}

              <button
                className="primary"
                disabled={busy || !report?.recovery_consent}
              >
                Save device care
              </button>
              {saved.revision !== revision && (
                <p className="error">
                  Policy changed elsewhere. Reload this page before saving.
                </p>
              )}
            </form>
            <section className="panel care-card">
              <div className="panel-heading">
                <h2>
                  <ShieldCheck size={18} />
                  Phone-reported state
                </h2>
                <Radio size={17} />
              </div>
              {!report ? (
                <p>
                  Start the updated app on this phone to report recovery and
                  management status.
                </p>
              ) : (
                <>
                  <div className="care-state">
                    <span
                      className={`status-dot ${report.revision !== saved.revision || report.errors.length ? "offline" : ""}`}
                    />
                    <strong>
                      {report.revision !== saved.revision
                        ? "Waiting for this phone"
                        : report.errors.length
                          ? "Some controls need attention"
                          : "Requested state reported"}
                    </strong>
                  </div>
                  <h3 className="delivery-heading">Theft-photo protection</h3>
                  <p className="fine">{report.camera ? `${report.camera.armed ? "Armed at last report" : "Not ready at last report"} · ${time(report.camera.reported_at)}. ${report.camera.status}. Pending ${report.camera.pending}/8; discarded at capacity ${report.camera.dropped}.` : "Not reported. Check the app version and theft-photo settings on the phone."} Enable protection on the phone before it is lost. This server cannot enable it remotely.</p>
                  {!!report.camera?.queued?.length && <ul className="fine">{report.camera.queued.map(photo=><li key={photo.id}>{photo.reason==="local_test"?"Labelled camera test":"Failed-entry capture"} · {time(photo.captured_at)} · awaiting upload at last report</li>)}</ul>}
                  <h3 className="delivery-heading">Delivery &amp; offline queue</h3>
                  {report.delivery ? (
                    <>
                      <p className="fine">
                        Last reported {time(report.delivery.reported_at)}. Queue counts reflect that report and can change while offline.
                      </p>
                      <dl className="care-health">
                        <div>
                          <dt>GPS access at last report</dt>
                          <dd>{({background: "Background permission granted", foreground: "Active · background restart not permitted", needs_foreground_start: "Paused · open Bungee to resume GPS", start_restricted: "Paused · Android restricted the location service", permission_denied: "Paused · precise permission missing", disabled: "Sharing disabled", paused: "Paused"} as Record<string,string>)[report.delivery.gps_access ?? ""] ?? "Not reported by this app"}</dd>
                        </div>
                        <div>
                          <dt>Queued GPS fixes</dt>
                          <dd>
                            {report.delivery.queued_fixes.toLocaleString()}
                          </dd>
                        </div>
                        <div>
                          <dt>Discarded at queue capacity</dt>
                          <dd>
                            {report.delivery.dropped_fixes.toLocaleString()}
                          </dd>
                        </div>
                        <div>
                          <dt>Oldest queued observation</dt>
                          <dd>
                            {report.delivery.oldest_queued_at
                              ? time(report.delivery.oldest_queued_at)
                              : "None reported"}
                          </dd>
                        </div>
                        <div>
                          <dt>Receipts awaiting confirmation</dt>
                          <dd>{report.delivery.pending_receipts}</dd>
                        </div>
                      </dl>
                    </>
                  ) : (
                    <p className="fine">
                      Update the phone app to report its encrypted offline
                      queue. An offline phone cannot report its current queue
                      size.
                    </p>
                  )}
                  <dl className="care-health">
                    <div>
                      <dt>Screen lock</dt>
                      <dd>
                        {report.secure_lock ? "Enabled" : "Not configured"}
                      </dd>
                    </div>
                    <div>
                      <dt>Currently locked</dt>
                      <dd>{report.screen_locked ? "Yes" : "No"}</dd>
                    </div>
                    <div>
                      <dt>Android</dt>
                      <dd>{report.android_version || "Unknown"}</dd>
                    </div>
                    <div>
                      <dt>Security patch</dt>
                      <dd>{report.security_patch || "Unknown"}</dd>
                    </div>
                    <div>
                      <dt>Lost mode</dt>
                      <dd>{report.lost_mode_active ? "Active" : "Off"}</dd>
                    </div>
                    <div>
                      <dt>System DNS through home</dt>
                      <dd>
                        {report.dns_active
                          ? "Configured on phone"
                          : "Unchanged · app traffic only"}
                      </dd>
                    </div>
                    <div>
                      <dt>Always-on VPN</dt>
                      <dd>{report.always_on ? "Enabled" : "Off"}</dd>
                    </div>
                    <div>
                      <dt>Suspended apps</dt>
                      <dd>{report.blocked_apps.length}</dd>
                    </div>
                    <div>
                      <dt>Failed credential attempts</dt>
                      <dd>
                        {report.unlock_monitoring
                          ? (report.camera?.failed_in_row ?? report.failed_unlocks)
                          : "Unavailable"}
                      </dd>
                    </div>
                    {report.last_failed_at && (
                      <div>
                        <dt>Last failed credential</dt>
                        <dd>{time(report.last_failed_at)}</dd>
                      </div>
                    )}
                  </dl>
                  {report.errors.length > 0 && (
                    <ul className="care-errors">
                      {report.errors.map((e, i) => (
                        <li key={i}>{e}</li>
                      ))}
                    </ul>
                  )}
                </>
              )}
              <p className="fine">
                Failure streaks reset after a successful credential unlock. Fingerprint and face failures may not count. The app signs these reports; hardware attestation is unavailable.
                Failed-credential reports require Android administration and
                may exclude biometric attempts.
              </p>
              <div className="notice">
                Bungee’s app-contained tunnel carries only its own API traffic; it does not route system DNS or other apps. Set your DNS resolver in the phone’s actual system VPN or Private DNS configuration. DNS summaries below come from earlier managed-DNS installations.
                New installations leave system DNS unchanged. Summaries cannot
                identify the requesting app or show queries that bypassed Bungee.
              </div>
            </section>
          </div>
          <RecoveryPhotos key={device.id} deviceId={device.id} />
          <section className="panel care-card dns-panel">
            <div className="panel-heading">
              <h2>
                <Globe size={18} />
                Bungee DNS diagnostics
              </h2>
              <div className="dns-tools">
                <select
                  aria-label="DNS time range"
                  value={days}
                  onChange={(e) => setDays(Number(e.target.value))}
                >
                  <option value={1}>Last 24 hours</option>
                  <option value={7}>Last 7 days</option>
                  <option value={30}>Last 30 days</option>
                </select>
                <button
                  className="text-button"
                  aria-label="Refresh DNS summaries"
                  onClick={() => setDnsReload((n) => n + 1)}
                >
                  <RefreshCw size={16} />
                </button>
              </div>
            </div>
            <p className="notice">Phone-wide DNS is not routed through Bungee. Its tunnel carries only this app; it leaves Android’s VPN slot unused. Browser DNS needs Wi-Fi DNS or Android Private DNS configured for AdGuard separately. A path test below proves forwarding only for Bungee’s fixed diagnostic query.</p>
            {report?.system_dns&&<p className="fine">{report.system_dns.available?`Android-reported DNS: ${report.system_dns.servers.join(", ")||"none reported"}. Private DNS: ${report.system_dns.private_dns_active?report.system_dns.private_dns_name||"active (automatic)":"not active"}. These are OS settings, not evidence that a browser query passed through Bungee.`:"Android DNS settings were unavailable at the last report."}</p>}
            {dns ? (
              <>
                <p className="fine">{dns.configured?"A home DNS upstream is configured. Run Test DNS path on the device page to verify phone → Bungee → resolver. AdGuard sees these forwarded queries from the Bungee server address.":"No home DNS upstream is configured. Set the resolver address during server configuration before testing."}</p>
                <div className="dns-totals">
                  <div>
                    <strong>{dns.domains.toLocaleString()}</strong>
                    <span>site groups</span>
                  </div>
                  <div>
                    <strong>{dns.activities.toLocaleString()}</strong>
                    <span>grouped activity windows</span>
                  </div>
                  <div>
                    <strong>
                      {Math.max(
                        0,
                        dns.queries - dns.activities,
                      ).toLocaleString()}
                    </strong>
                    <span>bundled / repeated queries folded in</span>
                  </div>
                </div>
                {dns.records.length ? (
                  <div className="history-table-wrap">
                    <table className="history-table">
                      <thead>
                        <tr>
                          <th>Site group</th>
                          <th>Grouped activity</th>
                          <th>Queries</th>
                          <th>Last seen</th>
                          <th>Results</th>
                        </tr>
                      </thead>
                      <tbody>
                        {dns.records.map((r) => (
                          <tr key={r.domain}>
                            <td>
                              <strong>{r.domain}</strong>
                              <small className="dns-types">
                                {Object.entries(r.types)
                                  .filter(([, n]) => n > 0)
                                  .map(([type]) => type)
                                  .join(" · ")}
                              </small>
                            </td>
                            <td>{r.activities}</td>
                            <td>{r.queries}</td>
                            <td>{time(r.last_at)}</td>
                            <td>
                              {r.errors
                                ? `${r.errors} errors`
                                : r.nxdomain
                                  ? `${r.nxdomain} not found`
                                  : "Answered"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="care-muted">
                    No saved DNS summaries in this range. Managed DNS is
                    disabled for new deployments.
                  </p>
                )}
                <p className="fine">
                  Top 100 groups. Subdomains are folded using a bundled
                  public-suffix list. A/AAAA/HTTPS and retries in the same
                  10-second window count as one activity; known system probes
                  are combined. Only five-minute rollups are stored, with no raw
                  subdomains, answer addresses, payloads or remote lookups for
                  classification. Time ranges include their boundary rollups.
                </p>
                <button className="text-button danger-text" onClick={eraseDns}>
                  <Trash2 size={14} />
                  Erase DNS summaries
                </button>
              </>
            ) : (
              <p>Loading DNS summary…</p>
            )}
          </section>
        </>
      )}
    </div>
  );
}
function Toggle({
  label,
  note,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  note: string;
  checked: boolean;
  disabled: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="care-toggle">
      <span>
        <strong>{label}</strong>
        <small>{note}</small>
      </span>
      <input
        type="checkbox"
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}
