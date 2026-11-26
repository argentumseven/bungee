import React, { useEffect, useState } from "react";
import {
  ShieldCheck,
  LockKeyhole,
} from "lucide-react";
import { api } from "./api";
import { RecoveryMessagePreview } from "./RecoveryMessagePreview";
import { LOCATION_REQUEST_MESSAGE } from "./activityText";
import type { PhoneProfiles } from "./PhoneStatus";

type Policy = {
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
  owner: boolean;
  consent: boolean;
  recovery_consent: boolean;
  revision: number;
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
    location_services?: boolean | null;
    airplane_mode?: boolean | null;
    last_fix_at?: number | null;
    fix_failures?: number | null;
  };
};
type AirplaneChange = { at: number | null; recorded_at: number; received_at: number };
type Saved = {
  revision: number;
  policy: Policy;
  report: Report | null;
  persistent_controls_enabled: false;
  legacy_policy_present: boolean;
  airplane_changes?: { on: AirplaneChange | null; off: AirplaneChange | null };
};
const time = (n: number) => new Date(n * 1000).toLocaleString();
export function DeviceCare({
  device,
  capabilities,
  onViewSharing,
}: {
  device: PhoneProfiles;
  capabilities?: string[];
  onViewSharing: () => void;
}) {
  const [saved, setSaved] = useState<Saved | null>(null),
    [draft, setDraft] = useState<Policy | null>(null);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
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
  const report = saved?.report;
  const focus = device.focus;
  const focusCapabilities = focus?.state === "active" && focus.since_ms != null
    ? focus.id === device.id ? capabilities : device.profiles?.find(p => p.id === focus.id)?.capabilities
    : undefined;
  const canAskForLocation = (device.profiles_enabled ? focusCapabilities : capabilities)?.includes("message");
  const locationOff = report?.delivery?.location_services === false || report?.delivery?.gps_access === "location_services_off";
  async function askForLocation() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api(`/devices/${device.id}/commands`, { method: "POST", body: JSON.stringify({ kind: "message", message: LOCATION_REQUEST_MESSAGE, profile: device.profiles_enabled ? "active" : undefined }) });
      setNotice("Message queued. When the phone collects it, it appears on its lock screen with a request to turn Location on. Clear it afterwards from the recovery message controls.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
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
                and failed-unlock reports. Device ownership, app
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
                <button type="button" className="secondary" onClick={onViewSharing}>Open sharing history</button>
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
                  <h3 className="delivery-heading">Main profile camera protection</h3>
                  <p className="fine">{report.camera ? `${report.camera.armed ? "Armed at last report" : "Not ready at last report"} · ${time(report.camera.reported_at)}. ${report.camera.status}. Pending ${report.camera.pending}/8; discarded at capacity ${report.camera.dropped}.` : "Not reported. Check the app version and theft-photo settings on the phone."} Enable protection on the phone before it is lost. This server cannot enable it remotely.</p>
                  {!!report.camera?.queued?.length && <ul className="fine">{report.camera.queued.map(photo=><li key={photo.id}>{photo.reason==="remote_manual"?"Manually requested picture":photo.reason==="local_test"?"Labelled camera test":"Failed-entry capture"} · {time(photo.captured_at)} · awaiting upload at last report</li>)}</ul>}
                  <h3 className="delivery-heading">Delivery &amp; offline queue</h3>
                  {locationOff && (
                    <div className="notice location-off-notice" role="status">
                      <strong>Android location services were off at the last report.</strong>{" "}
                      The phone cannot collect GPS fixes, although it can still receive commands. Android does not let this server, or any app, switch Location on remotely.
                      You can ask whoever has the phone to do it: this sends a message that shows on the phone and explains what to turn on.
                      <div>
                        <button type="button" className="secondary" disabled={busy || !canAskForLocation} onClick={() => void askForLocation()}>
                          Ask the phone to turn Location on
                        </button>
                        {!canAskForLocation && <span className="fine"> {device.profiles_enabled ? "Use Recovery commands to choose a profile that can receive messages." : "The phone has not approved recovery messages."}</span>}
                      </div>
                    </div>
                  )}
                  <dl className="care-health airplane-history">
                    {(["on", "off"] as const).map(state => {
                      const change = saved.airplane_changes?.[state];
                      return <div key={state}>
                        <dt>Airplane mode last turned {state}</dt>
                        <dd>{!change ? "No change recorded" : change.at == null
                          ? <>Observed {time(change.recorded_at)}<small>Exact change time unknown</small></>
                          : time(change.at)}
                          {change && change.received_at - (change.at ?? change.recorded_at) > 300 &&
                            <small>Reported after reconnecting · {time(change.received_at)}</small>}
                        </dd>
                      </div>;
                    })}
                  </dl>
                  {report.delivery ? (
                    <>
                      <p className="fine">
                        Last reported {time(report.delivery.reported_at)}. Queue counts reflect that report and can change while offline.
                      </p>
                      <dl className="care-health">
                        <div>
                          <dt>GPS access at last report</dt>
                          <dd>{({background: "Background permission granted", foreground: "Active · background restart not permitted", needs_foreground_start: "Paused · open Bungee to resume GPS", start_restricted: "Paused · Android restricted the location service", location_services_off: "Paused · Android location services are off", permission_denied: "Paused · precise permission missing", disabled: "Sharing disabled", paused: "Paused"} as Record<string,string>)[report.delivery.gps_access ?? ""] ?? "Not reported by this app"}</dd>
                        </div>
                        <div>
                          <dt>Android location services</dt>
                          <dd>{report.delivery.location_services == null ? "Not reported" : report.delivery.location_services ? "On" : "Off"}</dd>
                        </div>
                        <div>
                          <dt>Airplane mode at last report</dt>
                          <dd>{report.delivery.airplane_mode == null ? "Not reported" : report.delivery.airplane_mode ? "On" : "Off"}</dd>
                        </div>
                        <div>
                          <dt>Last GPS fix obtained</dt>
                          <dd>
                            {report.delivery.last_fix_at ? time(report.delivery.last_fix_at) : "None since the app started"}
                            {!!report.delivery.fix_failures && ` · ${report.delivery.fix_failures} attempts in a row without a fix`}
                          </dd>
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
                Failed-entry reports require Android device administration. Android may omit biometric attempts, and a successful credential unlock resets the streak.
              </p>
            </section>
          </div>
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
