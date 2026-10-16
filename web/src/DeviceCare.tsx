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

type Policy = {
  managed_dns: boolean;
  auto_resume: boolean;
  always_on: boolean;
  protect_settings: boolean;
  prevent_uninstall: boolean;
  require_strong_lock: boolean;
  blocked_apps: string[];
  lost_mode: boolean;
  recovery_message: string;
};
type Report = {
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
};
type Saved = {
  revision: number;
  policy: Policy;
  report: Report | null;
  dns_configured: boolean;
  dns_upstream: string | null;
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
  const [revision, setRevision] = useState(0),
    [packages, setPackages] = useState("");
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
            setPackages(data.policy.blocked_apps.join("\n"));
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
  const report = saved?.report,
    managed = !!(report?.owner && report.consent);
  const set = (key: keyof Policy, value: boolean) =>
    setDraft((old) =>
      old
        ? {
            ...old,
            [key]: value,
            ...(key === "managed_dns" && value ? { always_on: true } : {}),
          }
        : old,
    );
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!draft) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const blocked = packages.split(/\s+/).filter(Boolean);
      if (blocked.length > 20) throw Error("Choose at most 20 apps.");
      const policy = { ...draft, blocked_apps: blocked };
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
        "Saved at home. Check the phone-reported state for application and errors.",
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
        `Erase saved DNS summaries for ${device.name}? New activity can appear while managed DNS is enabled.`,
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
                  {report?.owner ? "DEVICE OWNER" : "PERSONAL"}
                </span>
              </div>
              <Toggle
                label="Lost mode"
                checked={draft.lost_mode}
                disabled={!report?.recovery_consent || busy}
                onChange={(v) => set("lost_mode", v)}
                note="Keep recovery intent pending through outages. The phone locks once and displays your contact message when permitted."
              />
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
                Unlock controls stay accessible. Notification privacy and
                Android permissions still apply. Sirens remain short-lived
                commands.
              </p>
              <details className="managed-options">
                <summary>
                  <ShieldCheck size={16} />
                  Optional device-owner controls
                </summary>
                {!managed && (
                  <p className="care-muted">
                    Provision this phone as Android device owner and approve
                    “managed controls” inside Bungee first. Personal phones keep
                    their existing permissions.
                  </p>
                )}
                <Toggle
                  label="Use home DNS"
                  checked={draft.managed_dns}
                  disabled={!managed || !saved.dns_configured || busy}
                  onChange={(v) => set("managed_dns", v)}
                  note="Send Android system DNS to Bungee through WireGuard. Enabling this also requests always-on VPN."
                />
                {!saved.dns_configured && (
                  <p className="care-muted">
                    The server operator must configure a private home DNS
                    upstream before this can be enabled.
                  </p>
                )}
                <Toggle
                  label="Always-on connection"
                  checked={draft.always_on}
                  disabled={!managed || draft.managed_dns || busy}
                  onChange={(v) => set("always_on", v)}
                  note="Reconnect Bungee automatically. VPN lockdown stays off so ordinary traffic can remain direct."
                />
                <Toggle
                  label="Resume recovery after restart"
                  checked={draft.auto_resume}
                  disabled={!managed || busy}
                  onChange={(v) => set("auto_resume", v)}
                  note="Resume after first unlock, subject to Android background and location rules."
                />
                <Toggle
                  label="Protect recovery settings"
                  checked={draft.protect_settings}
                  disabled={!managed || busy}
                  onChange={(v) => set("protect_settings", v)}
                  note="Restrict VPN changes, adding users, safe boot and factory reset through Settings. Hardware recovery and power-off remain outside app control."
                />
                <Toggle
                  label="Prevent ordinary uninstall"
                  checked={draft.prevent_uninstall}
                  disabled={!managed || busy}
                  onChange={(v) => set("prevent_uninstall", v)}
                  note="Request Android uninstall protection. Device-owner status already has its own removal rules."
                />
                <Toggle
                  label="Require a strong screen lock"
                  checked={draft.require_strong_lock}
                  disabled={!managed || busy}
                  onChange={(v) => set("require_strong_lock", v)}
                  note="Ask Android to enforce high password complexity; Bungee never reads or sets your PIN."
                />
                <label htmlFor="suspended-apps">Suspend selected apps</label>
                <textarea
                  id="suspended-apps"
                  value={packages}
                  disabled={!managed || busy}
                  onChange={(e) => setPackages(e.target.value)}
                  placeholder="org.mozilla.firefox\nOne package name per line"
                />
                <p className="fine">
                  Up to 20 user-installed apps. Suspension stops the entire app,
                  including its private DNS traffic. Core Android, system apps
                  and Bungee are protected. Allowed apps can still use their own
                  encrypted or hard-coded resolvers.
                </p>
              </details>
              <button
                className="primary"
                disabled={busy || (!report?.recovery_consent && !managed)}
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
                          : "Off / awaiting configuration"}
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
                          ? report.failed_unlocks
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
                These are signed app reports, not hardware attestation.
                Failed-credential callbacks depend on Android administration;
                they do not count every biometric attempt.
              </p>
              <div className="notice">
                Managed DNS covers Android's system resolver in this profile.
                App-supplied DoH/DoT, hard-coded DNS, other profiles and periods
                without the VPN are coverage limits. Suspend selected apps when
                you need to stop their traffic. This view is not a
                browsing-history or app-attribution claim.
              </div>
            </section>
          </div>
          <section className="panel care-card dns-panel">
            <div className="panel-heading">
              <h2>
                <Globe size={18} />
                DNS at a glance
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
            {dns ? (
              <>
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
                    No forwarded DNS activity in this range. Enable home DNS on
                    an approved managed phone to begin.
                  </p>
                )}
                <p className="fine">
                  Top 100 groups. Subdomains are folded using a bundled
                  public-suffix list. A/AAAA/HTTPS and retries in the same
                  10-second window count as one activity; known system probes
                  are combined. Only five-minute rollups are stored, with no
                  raw subdomains, answer addresses, payloads or remote lookups
                  for classification. Time ranges include their boundary
                  rollups.
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
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}
