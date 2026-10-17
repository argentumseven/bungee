import React, { useEffect, useState, useRef } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  ArrowDownLeft,
  ArrowRight,
  BellRing,
  Check,
  ChevronRight,
  CircleHelp,
  Clipboard,
  Compass,
  Fingerprint,
  Heart,
  House,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  MapPin,
  History,
  Download,
  MessageSquare,
  Plus,
  Radio,
  RefreshCw,
  Settings,
  ShieldCheck,
  Smartphone,
  VolumeX,
  X,
  Zap,
} from "lucide-react";
import QRCode from "qrcode";
import { version as releaseVersion } from "../../release.json";
import "./style.css";
import { api } from "./api";
import {
  PrivateMap,
  NetworkCard,
  geoLabel,
  type NetworkObservation,
} from "./PrivateMap";
import { DeviceCare } from "./DeviceCare";

type Location = {
  latitude: number;
  longitude: number;
  accuracy: number;
  observed_at: number;
};
type Device = {
  id: string;
  name: string;
  address: string;
  created: number;
  last_seen: number | null;
  last_contact?: number | null;
  revoked: boolean;
  enrolled: boolean;
  enrollment_state?: "pending" | "expired" | "enrolled" | "revoked";
  wg_public_key?: string;
  preshared_key: boolean;
  capabilities: string[];
  network?: NetworkObservation | null;
  telemetry: null | {
    battery: number;
    charging: boolean;
    location: Location | null;
    device_owner: boolean;
  };
};
type Command = {
  id: string;
  device_id: string;
  kind: string;
  created: number;
  expires: number;
  status: string;
  result: string | null;
  delivery_uncertain?: boolean;
  receipt_received_at?: number | null;
};
type Event = {
  at: number;
  action: string;
  device_id: string | null;
  detail: string;
};
const ago = (t: number | null) =>
  t
    ? Date.now() / 1000 - t < 90
      ? "Just now"
      : Date.now() / 1000 - t < 3600
        ? `${Math.floor((Date.now() / 1000 - t) / 60)} min ago`
        : new Date(t * 1000).toLocaleString()
    : "Not connected yet";
const online = (d: Device) =>
  !!(d.last_contact ?? d.last_seen) &&
  Date.now() / 1000 - (d.last_contact ?? d.last_seen)! < 150 &&
  !d.revoked;
function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark">
        <Radio size={23} strokeWidth={2.4} />
      </span>
      bungee<span className="brand-dot">.</span>
    </div>
  );
}
function App() {
  const [auth, setAuth] = useState<boolean | null>(null),
    [password, setPassword] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [devices, setDevices] = useState<Device[]>([]),
    [commands, setCommands] = useState<Command[]>([]),
    [events, setEvents] = useState<Event[]>([]),
    [selected, setSelected] = useState(""),
    [page, setPage] = useState("Overview");
  const [modal, setModal] = useState<
      "enroll" | "message" | "revoke" | "clear_location" | "help" | null
    >(null),
    [toast, setToast] = useState("");
  const [name, setName] = useState(""),
    [wgKey, setWgKey] = useState(""),
    [bundle, setBundle] = useState(""),
    [qr, setQr] = useState(""),
    [message, setMessage] = useState(""),
    [lastRefresh, setLastRefresh] = useState<number | null>(null);
  const [clearTarget, setClearTarget] = useState<Device | null>(null);
  const active = devices.filter((d) => !d.revoked),
    device = active.find((d) => d.id === selected) || active[0];
  const load = async () => {
    try {
      const data = await api<{ devices: Device[]; commands: Command[] }>(
        "/devices",
      );
      setDevices(data.devices);
      setCommands(data.commands);
      setLastRefresh(Date.now());
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    api("/session")
      .then(() => setAuth(true))
      .catch(() => setAuth(false));
  }, []);
  useEffect(() => {
    const expire = () => {
      setAuth(false);
      setDevices([]);
      setCommands([]);
      setEvents([]);
      setSelected("");
      setModal(null);
      setClearTarget(null);
      setBundle("");
    };
    window.addEventListener("bungee:session-expired", expire);
    return () => window.removeEventListener("bungee:session-expired", expire);
  }, []);
  useEffect(() => {
    if (!auth) return;
    void load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [auth]);
  useEffect(() => {
    if (auth && page === "Activity")
      api<{ events: Event[] }>("/audit")
        .then((x) => setEvents(x.events))
        .catch((e) => setError(e.message));
  }, [auth, page, commands]);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(""), 6000);
    return () => clearTimeout(id);
  }, [toast]);
  useEffect(() => {
    if (bundle)
      QRCode.toDataURL(bundle, {
        width: 320,
        margin: 2,
        errorCorrectionLevel: "M",
      }).then(setQr);
  }, [bundle]);
  async function login(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/session", {
        method: "POST",
        body: JSON.stringify({ password }),
      });
      setPassword("");
      setAuth(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function send(kind: string, text?: string) {
    if (!device) return;
    setBusy(true);
    try {
      await api(`/devices/${device.id}/commands`, {
        method: "POST",
        body: JSON.stringify({
          kind,
          message: text,
        }),
      });
      setToast("Command queued. The phone will acknowledge it when connected.");
      setModal(null);
      setMessage("");
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function enroll(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const data = await api("/enrollments", {
        method: "POST",
        body: JSON.stringify({ name, wg_public_key: wgKey.trim() }),
      });
      setBundle(JSON.stringify(data));
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function revoke() {
    if (!device) return;
    setBusy(true);
    try {
      await api(`/devices/${device.id}`, { method: "DELETE" });
      setModal(null);
      setToast(
        "Device revoked. Its location has been erased and its tunnel access removed.",
      );
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function clearLocation() {
    if (!clearTarget) return;
    setBusy(true);
    try {
      await api(`/devices/${clearTarget.id}/history`, { method: "DELETE" });
      setModal(null);
      setClearTarget(null);
      setToast(
        "Saved history erased. New fixes can appear while sharing remains enabled.",
      );
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function close() {
    setModal(null);
    setClearTarget(null);
    setBundle("");
    setQr("");
    setError("");
  }
  if (auth === null)
    return (
      <div className="loading">
        <Brand />
        <LoaderCircle className="spin" />
      </div>
    );
  if (!auth)
    return (
      <main className="login-layout">
        <section className="login-story">
          <Brand />
          <div>
            <span className="eyebrow">A LITTLE CLOSER TO HOME</span>
            <h1>
              Your devices.
              <br />
              Your people.
              <br />
              <em>Your peace of mind.</em>
            </h1>
            <p>
              A private place to keep your household connected.
              <br />
              Hosted by you. Held by you.
            </p>
          </div>
          <div className="story-footer">
            <ShieldCheck size={18} /> No cloud account. No data broker. Just
            home.
          </div>
        </section>
        <section className="login-panel">
          <div className="login-form">
            <div className="icon-tile">
              <Fingerprint size={30} />
            </div>
            <span className="eyebrow">YOUR PRIVATE HOUSEHOLD</span>
            <h2>Welcome home.</h2>
            <p>
              Sign in to your Bungee server to find a device or lend a little
              help.
            </p>
            <form onSubmit={login}>
              <label htmlFor="password">Server administrator password</label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                minLength={16}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              {error && (
                <div className="error" role="alert">
                  {error}
                </div>
              )}
              <button className="primary full" disabled={busy}>
                {busy ? (
                  <LoaderCircle className="spin" size={18} />
                ) : (
                  <LockKeyhole size={17} />
                )}
                Unlock your household
                <ArrowRight size={17} />
              </button>
            </form>
            <p className="fine">
              <LockKeyhole size={13} /> Credentials stay with this server. Read
              your locally generated admin-password file to get started.
            </p>
          </div>
          <div className="login-caption">
            SELF-HOSTED BY DESIGN · PRIVATE BY DEFAULT
          </div>
        </section>
      </main>
    );
  return (
    <div className="shell">
      <aside className="sidebar">
        <Brand />
        <div className="household">
          <div className="house-icon">
            <House size={19} />
          </div>
          <div>
            <strong>My household</strong>
            <small>Your private space</small>
          </div>
          <ShieldCheck size={16} />
        </div>
        <span className="nav-label">WORKSPACE</span>
        <nav>
          {[
            { name: "Overview", icon: House },
            { name: "Devices", icon: Smartphone },
            { name: "Device care", icon: ShieldCheck },
            { name: "History", icon: History },
            { name: "Activity", icon: Activity },
            { name: "Settings", icon: Settings },
          ].map(({ name, icon: Icon }) => (
            <button
              key={name}
              className={page === name ? "nav-item active" : "nav-item"}
              onClick={() => setPage(name)}
            >
              <Icon size={19} />
              {name}
              {name === "Devices" && (
                <span className="nav-count">{active.length}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="privacy-note">
            <div>
              <ShieldCheck size={18} />
              <strong>Home is the cloud.</strong>
            </div>
            <p>Your location data stays on your server. Always.</p>
            <span>
              <i className="status-dot" /> Private connection
            </span>
          </div>
          <button className="nav-item" onClick={() => setModal("help")}>
            <CircleHelp size={18} />
            Getting started
            <ArrowDownLeft size={15} />
          </button>
          <button
            className="nav-item"
            onClick={async () => {
              await api("/session", { method: "DELETE" });
              setAuth(false);
            }}
          >
            <LogOut size={18} />
            Lock dashboard
          </button>
          <div className="sidebar-foot">
            BUNGEE <span>SELF-HOSTED · v{releaseVersion}</span>
          </div>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="breadcrumb">
            My household
            <ChevronRight size={14} />
            <strong>{page}</strong>
          </div>
          <div className="top-status">
            <i className="status-dot" />
            Self-hosted<span className="avatar">H</span>
          </div>
        </header>
        <main className="main">
          <div className="page-heading">
            <div>
              <div className="eyebrow">CONNECTED, ON YOUR TERMS</div>
              <h1>
                {page === "Overview"
                  ? "A little peace of mind."
                  : page === "Devices"
                    ? "Everyone, accounted for."
                    : page === "Device care"
                      ? "Ready when it matters."
                      : page === "History"
                        ? "A trail you control."
                        : page === "Activity"
                          ? "A clear trail."
                          : "Private by design."}
              </h1>
              <p>
                {page === "Overview"
                  ? "Everything you need to keep your household devices close."
                  : page === "Devices"
                    ? "Manage the phones that belong to your household."
                    : page === "Device care"
                      ? "Recovery, local safety and any saved DNS summaries."
                      : page === "History"
                        ? "Look back through GPS, IP observations and check-ins. Stored only here."
                        : page === "Activity"
                          ? "Enrollment, access, and remote commands. All on your server."
                          : "Understand the boundaries protecting your household."}
              </p>
            </div>
            {["Overview", "Devices"].includes(page) && (
              <button
                className="primary"
                onClick={() => {
                  setName("");
                  setWgKey("");
                  setModal("enroll");
                }}
              >
                <Plus size={18} />
                Add a device
              </button>
            )}
          </div>
          {error && (
            <div className="error banner" role="alert">
              {error} <button onClick={load}>Retry</button>
            </div>
          )}
          {["Overview", "Devices"].includes(page) && (
            <>
              <section className="stats">
                <Stat
                  icon={<Smartphone size={20} />}
                  label="Household devices"
                  value={String(active.length)}
                  note="Paired to your home"
                />
                <Stat
                  icon={<Radio size={20} />}
                  label="Connected now"
                  value={String(active.filter(online).length)}
                  note="Authenticated contact in the last 2½ minutes"
                  color="green"
                />
                <Stat
                  icon={<ShieldCheck size={20} />}
                  label="Your data belongs to"
                  value="You."
                  note="No external map requests"
                  color="purple"
                />
              </section>
              <div className="dashboard-grid">
                <section className="panel device-panel">
                  <div className="panel-heading">
                    <h2>
                      Your devices{" "}
                      <span className="count">{active.length}</span>
                    </h2>
                    <span className="subtle">HOUSEHOLD</span>
                  </div>
                  {active.length === 0 ? (
                    <div className="empty-device">
                      <div className="phone-illustration">
                        <Smartphone size={57} strokeWidth={1.2} />
                        <span>
                          <ShieldCheck size={17} />
                        </span>
                      </div>
                      <h3>It starts with one phone.</h3>
                      <p>
                        Pair your first device to give it a private way home.
                      </p>
                      <button
                        className="text-button"
                        onClick={() => setModal("enroll")}
                      >
                        Pair a device
                        <ArrowRight size={16} />
                      </button>
                    </div>
                  ) : (
                    <div className="device-list">
                      {active.map((d) => (
                        <button
                          key={d.id}
                          className={`device-row ${device?.id === d.id ? "selected" : ""}`}
                          onClick={() => setSelected(d.id)}
                        >
                          <span className="device-icon">
                            <Smartphone size={24} />
                          </span>
                          <span className="device-text">
                            <strong>{d.name}</strong>
                            <small>
                              <i
                                className={`status-dot ${online(d) ? "" : "offline"}`}
                              />
                              {!d.enrolled
                                ? d.enrollment_state === "expired" ? "Invitation expired · reissue in Settings" : "Awaiting enrollment"
                                : online(d)
                                  ? "Connected"
                                  : "Offline"}
                              <span>·</span>
                              {ago(d.last_contact ?? d.last_seen)}
                            </small>
                          </span>
                          <span className="battery">
                            <span
                              title={`Battery from saved telemetry: ${ago(d.last_seen)}`}
                            >
                              {d.telemetry ? `${d.telemetry.battery}%` : "—"}
                            </span>
                            {d.telemetry?.charging && <Zap size={12} />}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="panel-footer">
                    <LockKeyhole size={13} />
                    Connected through your private WireGuard tunnel
                  </div>
                </section>
                <section className="panel location-panel">
                  <div className="panel-heading">
                    <h2>
                      <MapPin size={17} />
                      Last-known location
                    </h2>
                    <span className="map-badge">
                      <LockKeyhole size={11} />
                      LOCAL VIEW
                    </span>
                  </div>
                  <LocationView device={device} />
                  <div className="location-footer">
                    <div>
                      <span className="icon-tile small">
                        <Compass size={18} />
                      </span>
                      <div>
                        <strong>
                          {device?.telemetry?.location
                            ? device.name
                            : "A private point of view"}
                        </strong>
                        <small>
                          {device?.telemetry?.location
                            ? `Accuracy ±${Math.round(device.telemetry.location.accuracy)} m · observed ${ago(device.telemetry.location.observed_at)}`
                            : "Locations appear here after the phone grants access."}
                        </small>
                      </div>
                    </div>
                    <span className="subtle">NO EXTERNAL MAP REQUESTS</span>
                  </div>
                </section>
              </div>
              <div className="lower-grid">
                <section className="panel">
                  <div className="panel-heading">
                    <h2>Send a little help</h2>
                    <span className="subtle">
                      {device ? device.name : "SELECT A PAIRED DEVICE"}
                    </span>
                  </div>
                  <div className="actions-grid">
                    {[
                      {
                        kind: "locate",
                        name: "Refresh location",
                        desc: "Ask for a fresh fix",
                        icon: MapPin,
                      },
                      {
                        kind: "ring",
                        name: "Play a sound",
                        desc: "Make it easier to find",
                        icon: BellRing,
                      },
                      {
                        kind: "message",
                        name: "Leave a message",
                        desc: "A note on the lock screen",
                        icon: MessageSquare,
                      },
                      {
                        kind: "lock",
                        name: "Lock device",
                        desc: "Requires device admin",
                        icon: LockKeyhole,
                      },
                    ].map(({ kind, name, desc, icon: Icon }) => (
                      <button
                        className="action"
                        key={kind}
                        disabled={
                          busy ||
                          !device?.enrolled ||
                          !device.capabilities.includes(kind)
                        }
                        onClick={() =>
                          kind === "message" ? setModal("message") : send(kind)
                        }
                      >
                        <span className="action-icon">
                          <Icon size={20} />
                        </span>
                        <strong>{name}</strong>
                        <small>{desc}</small>
                        <ArrowRight className="action-arrow" size={15} />
                      </button>
                    ))}
                  </div>
                  {device && (
                    <div className="secondary-actions">
                      <button
                        className="text-button"
                        disabled={
                          !device.capabilities.includes("stop_ringing") || busy
                        }
                        onClick={() => send("stop_ringing")}
                      >
                        <VolumeX size={14} />
                        Stop sound
                      </button>
                      <button
                        className="text-button"
                        disabled={
                          !device.capabilities.includes("clear_message") || busy
                        }
                        onClick={() => send("clear_message")}
                      >
                        Clear recovery message
                      </button>
                    </div>
                  )}
                </section>
                <section className="panel command-panel">
                  <div className="panel-heading">
                    <h2>Recent commands</h2>
                    <Activity size={17} />
                  </div>
                  {commands
                    .filter((c) => !device || c.device_id === device.id)
                    .slice(0, 4)
                    .map((c) => (
                      <div className="command-row" key={c.id}>
                        <span
                          className={`receipt ${c.status === "executed" ? "success" : ""}`}
                        >
                          {c.status === "executed" ? (
                            <Check size={15} />
                          ) : (
                            <RefreshCw size={15} />
                          )}
                        </span>
                        <div>
                          <strong>{c.kind.replaceAll("_", " ")}</strong>
                          <small>
                            {ago(c.created)}
                            {c.result && ` · ${c.result}`}
                            {c.delivery_uncertain &&
                              " · No receipt: delivery or execution may have occurred."}
                            {c.receipt_received_at != null &&
                              c.receipt_received_at > c.expires &&
                              " · Confirmed after reconnect"}
                          </small>
                        </div>
                        <span className={`command-status ${c.status}`}>
                          {c.delivery_uncertain
                            ? "Expired · unconfirmed"
                            : c.status === "delivered" ? "Offered · awaiting receipt" : c.status}
                        </span>
                      </div>
                    ))}
                  {commands.filter((c) => !device || c.device_id === device.id)
                    .length === 0 && (
                    <div className="empty-commands">
                      <Check size={22} />
                      <strong>All quiet at home.</strong>
                      <p>Command receipts will appear here.</p>
                    </div>
                  )}
                </section>
              </div>
            </>
          )}
          {page === "History" && (
            <>
              <label htmlFor="history-device">Device</label>
              <select
                id="history-device"
                value={device?.id || ""}
                onChange={(e) => setSelected(e.target.value)}
              >
                {active.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
              {device ? (
                <HistoryView key={device.id} device={device} />
              ) : (
                <section className="panel history-panel">
                  Pair a phone to begin saving history.
                </section>
              )}
            </>
          )}
          {page === "Device care" && (
            <>
              <label htmlFor="care-device">Device</label>
              <select
                id="care-device"
                className="care-device"
                value={device?.id || ""}
                onChange={(e) => setSelected(e.target.value)}
              >
                {active.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
              {device ? (
                <DeviceCare key={device.id} device={device} />
              ) : (
                <section className="panel history-panel">
                  Pair a phone to configure recovery and review its reported
                  state.
                </section>
              )}
            </>
          )}
          {page === "Activity" && (
            <section className="panel audit-panel">
              <div className="panel-heading">
                <h2>
                  <Activity size={18} />
                  Household activity
                </h2>
                <span className="subtle">LATEST 100 EVENTS</span>
              </div>
              {events.map((e, i) => (
                <div className="audit-row" key={`${e.at}-${i}`}>
                  <span className="icon-tile small">
                    <ShieldCheck size={16} />
                  </span>
                  <div>
                    <strong>{e.action.replaceAll(".", " · ")}</strong>
                    <small>
                      {e.detail || "Administrator access"}
                      {e.device_id &&
                        ` · ${devices.find((d) => d.id === e.device_id)?.name || "Device"}`}
                    </small>
                  </div>
                  <time>{new Date(e.at * 1000).toLocaleString()}</time>
                </div>
              ))}
            </section>
          )}
          {page === "Settings" && (
            <div className="settings-grid">
              <section className="panel settings-card">
                <ShieldCheck size={26} />
                <h2>Small attack surface. Clear boundaries.</h2>
                <p>
                  The dashboard and device API use separate listeners. Device
                  requests are signed with phone-held keys, timestamped, and
                  protected against replay. Your phone routes only{" "}
                  <code>10.77.0.1/32</code> through WireGuard.
                </p>
                <ul>
                  <li>
                    GPS, IP history and check-in logs stay until explicitly
                    erased or the device is revoked
                  </li>
                  <li>One-use enrollment expires in 10 minutes</li>
                  <li>Remote commands expire in 5 minutes</li>
                  <li>
                    No cloud push, external map/GeoIP lookups, network location,
                    or public certificate authority
                  </li>
                  <li>
                    Unique 256-bit WireGuard preshared key for each new phone
                  </li>
                  <li>Eight-hour administrator sessions</li>
                </ul>
                <div className="notice">
                  This is an early implementation awaiting a security audit and
                  testing on physical GrapheneOS devices. Use a test phone
                  before relying on it.
                </div>
              </section>
              <section className="panel settings-card">
                <KeyRound size={26} />
                <h2>Device consent & management</h2>
                <p>
                  Pairing approves telemetry. Household recovery commands need
                  separate approval on the phone; remote locking also needs
                  optional Android administration. Device-owner enrollment and persistent restrictions are
                  disabled. Bungee uses app-contained WireGuard and leaves
                  Android’s VPN slot free. A separate Bungee recovery entry can
                  stop controls offline.
                </p>
                <p>
                  Background failed-unlock photos and lock-screen overlays are
                  not supported by this version. Recovery messages use ordinary
                  lock-screen notifications and respect system privacy settings.
                </p>
                {active.map((d) => (
                  <div className="settings-device" key={d.id}>
                    <strong>{d.name}</strong>
                    <small>
                      {d.telemetry?.device_owner
                        ? "Legacy device owner · unsupported"
                        : "Personal-device mode"}{" "}
                      · {d.capabilities.join(", ") || "Awaiting consent"}
                    </small>
                    {!d.enrolled && d.wg_public_key && (
                      <button className="text-button" onClick={() => { setName(d.name); setWgKey(d.wg_public_key!); setBundle(""); setModal("enroll"); }}>
                        Reissue invitation
                      </button>
                    )}
                    {!d.preshared_key && d.enrolled && (
                      <p className="error">
                        Re-pair required: this legacy identity has no preshared
                        key and its tunnel is blocked.
                      </p>
                    )}
                    {d.enrolled && (
                      <button
                        className="text-button"
                        onClick={() => {
                          setClearTarget(d);
                          setModal("clear_location");
                        }}
                      >
                        Erase saved history
                      </button>
                    )}
                    <br />
                    <button
                      className="danger-text"
                      onClick={() => {
                        setSelected(d.id);
                        setModal("revoke");
                      }}
                    >
                      Revoke this device
                    </button>
                  </div>
                ))}
              </section>
            </div>
          )}
          <footer className="main-footer">
            <span>
              <Heart size={13} />
              Built for the people you call home.
            </span>
            <span>
              {lastRefresh
                ? `Updated ${new Date(lastRefresh).toLocaleTimeString()}`
                : "Connecting…"}
              <span className="footer-dot">·</span>All data stays here
            </span>
          </footer>
        </main>
      </div>
      {toast && (
        <div className="toast" role="status">
          <Check size={18} />
          {toast}
          <button
            aria-label="Dismiss notification"
            onClick={() => setToast("")}
          >
            <X size={16} />
          </button>
        </div>
      )}
      {modal && (
        <div className="modal-backdrop" onClick={close}>
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="modal-close"
              aria-label="Close dialog"
              onClick={close}
            >
              <X size={20} />
            </button>
            <span className="icon-tile">
              <ShieldCheck size={25} />
            </span>
            <h2 id="modal-title">
              {modal === "enroll"
                ? "A private way home."
                : modal === "message"
                  ? "Leave a recovery message."
                  : modal === "clear_location"
                    ? "Erase this saved history?"
                    : modal === "revoke"
                      ? "Revoke this device?"
                      : "Welcome to your household."}
            </h2>
            {modal === "enroll" && !bundle && (
              <form onSubmit={enroll}>
                <p>
                  Open Bungee on the phone and copy its WireGuard public key.
                  The private key never leaves the phone.
                </p>
                <label htmlFor="device-name">Device name</label>
                <input
                  id="device-name"
                  autoFocus
                  required
                  maxLength={60}
                  placeholder="e.g. Rowan’s Pixel"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
                <label htmlFor="wg-key">Phone’s WireGuard public key</label>
                <textarea
                  id="wg-key"
                  required
                  placeholder="Paste the public key shown on the phone"
                  value={wgKey}
                  onChange={(e) => setWgKey(e.target.value)}
                />
                <p className="fine">
                  Both people should agree to location sharing. No background
                  enrollment or silent tracking. Reissuing a never-enrolled
                  phone key replaces its earlier invitation and tunnel secret.
                </p>
                <button className="primary full" disabled={busy}>
                  <Plus size={17} />
                  Create one-time enrollment
                </button>
              </form>
            )}
            {modal === "enroll" && bundle && (
              <>
                <p>
                  Scan this with Bungee on the phone, approve the VPN, then
                  confirm enrollment. This invitation expires in 10 minutes. It
                  contains a long-lived preshared key. Use a trusted local
                  administrator connection and keep the QR private.
                </p>
                {qr && (
                  <img
                    className="qr"
                    src={qr}
                    alt="One-time Bungee enrollment QR code"
                  />
                )}
                <button
                  className="primary full"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(bundle);
                      setToast(
                        "Enrollment copied. Paste it only into your phone.",
                      );
                    } catch {
                      setError(
                        "Clipboard is unavailable. Select the enrollment text below.",
                      );
                    }
                  }}
                >
                  <Clipboard size={17} />
                  Copy enrollment
                </button>
                <details>
                  <summary>Use enrollment text instead</summary>
                  <textarea
                    readOnly
                    aria-label="Enrollment bundle"
                    value={bundle}
                  />
                </details>
                <p className="fine">
                  WireGuard peers refresh within five seconds. Keep this page
                  private.
                </p>
              </>
            )}
            {modal === "message" && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void send("message", message);
                }}
              >
                <p>
                  A visible notification for {device?.name}. It leaves the
                  phone’s unlock controls accessible. Android’s lock-screen
                  privacy settings still apply.
                </p>
                <label htmlFor="recovery-message">Recovery message</label>
                <textarea
                  id="recovery-message"
                  required
                  autoFocus
                  maxLength={240}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="This phone is loved. Please call…"
                />
                <small>{message.length}/240 characters</small>
                <button className="primary full" disabled={busy}>
                  <MessageSquare size={17} />
                  Queue message
                </button>
              </form>
            )}
            {modal === "clear_location" && (
              <>
                <p>
                  Erase all GPS history, IP observations, check-in logs, and the
                  last-known location for {clearTarget?.name}? The phone stays
                  paired. New fixes can appear while sharing is enabled; older
                  queued fixes will not restore erased history.
                </p>
                <p>
                  To stop future location updates, turn off location sharing on
                  the phone.
                </p>
                <button
                  className="primary danger full"
                  disabled={busy || !clearTarget}
                  onClick={clearLocation}
                >
                  Erase saved history
                </button>
              </>
            )}
            {modal === "revoke" && (
              <>
                <p>
                  Remove {device?.name} from your household. Its location
                  history, IP observations, check-in logs and pending commands
                  will be erased, and its WireGuard access removed. To pair it
                  again, reset pairing on the phone.
                </p>
                <button
                  className="primary danger full"
                  disabled={busy}
                  onClick={revoke}
                >
                  Revoke and erase location
                </button>
              </>
            )}
            {modal === "help" && (
              <>
                <p>
                  1. Deploy the Docker stack and set a public WireGuard UDP
                  endpoint.
                </p>
                <p>
                  2. Install the Android app. Tap its public key to copy it.
                </p>
                <p>
                  3. Choose “Add a device,” then scan the invitation on the
                  phone.
                </p>
                <p>
                  4. Approve location permissions. Start sharing from the phone.
                </p>
                <div className="notice">
                  Bungee shares only through your server. It cannot find a
                  powered-off phone, bypass GrapheneOS permissions, or use
                  Apple’s crowdsourced Find My network.
                </div>
              </>
            )}
            {error && (
              <div className="error" role="alert">
                {error}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
type HistoryRecord = Partial<Location> & {
  received_at: number;
  id?: number;
  battery?: number;
  charging?: boolean;
  device_owner?: boolean;
  ip?: string;
  geoip?: NetworkObservation["geoip"];
};
type HistoryPage = { records: HistoryRecord[]; next_before: number | null };
const localDateTime = (time: number) => {
  const d = new Date(time);
  return new Date(time - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
};
function HistoryView({ device }: { device: Device }) {
  const [from, setFrom] = useState(() => localDateTime(Date.now() - 86400000));
  const [to, setTo] = useState(() => localDateTime(Date.now() + 60000));
  const [kind, setKind] = useState("locations");
  const [recurrence, setRecurrence] = useState("all"),
    [minutes, setMinutes] = useState(5),
    [daily, setDaily] = useState("09:00"),
    [tolerance, setTolerance] = useState(15);
  const [timezone, setTimezone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  );
  const [range, setRange] = useState(() => ({
    from: Math.floor((Date.now() - 86400000) / 1000),
    to: Math.floor(Date.now() / 1000) + 120,
    kind: "locations",
    recurrence: "all",
    minutes: 5,
    daily: "09:00",
    tolerance: 15,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  }));
  const [records, setRecords] = useState<HistoryRecord[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [chosen, setChosen] = useState<HistoryRecord | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [exportStarted, setExportStarted] = useState(false);
  const request = useRef<AbortController | null>(null);
  const endpoint = (before?: number | null) =>
    `/devices/${device.id}/history?${new URLSearchParams({ from: String(range.from), to: String(range.to), kind: range.kind, limit: "200", ...(range.recurrence === "interval" ? { every: String(range.minutes * 60) } : range.recurrence === "daily" ? { daily: range.daily, timezone: range.timezone, tolerance: String(range.tolerance * 60) } : {}), ...(before ? { before: String(before) } : {}) })}`;
  useEffect(() => {
    const abort = new AbortController();
    request.current = abort;
    setBusy(true);
    setError("");
    setRecords([]);
    setChosen(null);
    setNext(null);
    api<HistoryPage>(endpoint(), { signal: abort.signal })
      .then((data) => {
        setRecords(data.records);
        setNext(data.next_before);
        setChosen(data.records[0] || null);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!abort.signal.aborted) setBusy(false);
      });
    return () => abort.abort();
  }, [device.id, range]);
  async function more() {
    const signal = request.current!.signal;
    setBusy(true);
    try {
      const data = await api<HistoryPage>(endpoint(next), { signal });
      setRecords((old) => [...old, ...data.records]);
      setNext(data.next_before);
    } catch (e) {
      if (!signal.aborted) setError((e as Error).message);
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  }
  function download() {
    const a = document.createElement("a");
    a.href = `/api${endpoint().replace("/history?", "/history.csv?")}`;
    a.download = `bungee-history-${range.kind}.csv`;
    a.click();
    setExportStarted(true);
  }
  const points = records
    .filter((r) => r.latitude !== undefined)
    .slice()
    .reverse();
  const bounds = points.reduce(
    (b, p) => ({
      minLat: Math.min(b.minLat, p.latitude!),
      maxLat: Math.max(b.maxLat, p.latitude!),
      minLon: Math.min(b.minLon, p.longitude!),
      maxLon: Math.max(b.maxLon, p.longitude!),
    }),
    {
      minLat: Infinity,
      maxLat: -Infinity,
      minLon: Infinity,
      maxLon: -Infinity,
    },
  );
  const latSpan = Math.max(0.0001, bounds.maxLat - bounds.minLat),
    lonSpan = Math.max(0.0001, bounds.maxLon - bounds.minLon);
  const minLat = (bounds.maxLat + bounds.minLat - latSpan) / 2,
    minLon = (bounds.maxLon + bounds.minLon - lonSpan) / 2;
  const xy = (p: HistoryRecord) =>
    `${30 + ((p.longitude! - minLon) / lonSpan) * 640},${230 - ((p.latitude! - minLat) / latSpan) * 200}`;
  return (
    <section className="panel history-panel">
      <div className="panel-heading">
        <h2>
          <History size={18} />
          Saved history
        </h2>
        <span className="subtle">UNTIL YOU ERASE IT</span>
      </div>
      <form
        className="history-filters"
        onSubmit={(e) => {
          e.preventDefault();
          const start = Date.parse(from) / 1000,
            end = Date.parse(to) / 1000;
          if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
            setError("Choose a valid start and end time.");
            return;
          }
          if (recurrence === "interval" && (end - start > 366 * 86400 || Math.floor((end - start) / (minutes * 60)) + 1 > 10000)) {
            setError("Interval history allows up to 366 days and 10,000 time buckets. Choose a shorter range or wider interval.");
            return;
          }
          setRange({
            from: Math.floor(start),
            to: Math.floor(end),
            kind,
            recurrence,
            minutes,
            daily,
            tolerance,
            timezone,
          });
        }}
      >
        <label>
          From (local time)
          <input
            aria-label="History from"
            type="datetime-local"
            required
            value={from}
            disabled={busy}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label>
          To (local time)
          <input
            aria-label="History to"
            type="datetime-local"
            required
            value={to}
            disabled={busy}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
        <label>
          Records
          <select
            aria-label="History records"
            value={kind}
            disabled={busy}
            onChange={(e) => setKind(e.target.value)}
          >
            <option value="locations">GPS fixes</option>
            <option value="network">IP observations &amp; GeoIP</option>
            <option value="state">Device check-ins</option>
          </select>
        </label>
        <label>
          Show records
          <select
            aria-label="History recurrence"
            value={recurrence}
            disabled={busy}
            onChange={(e) => setRecurrence(e.target.value)}
          >
            <option value="all">Every saved record</option>
            <option value="interval">One per interval</option>
            <option value="daily">Every day at a time</option>
          </select>
        </label>
        {recurrence === "interval" && (
          <label>
            Interval
            <select
              aria-label="History interval"
              value={
                minutes === 5 || minutes === 60 ? String(minutes) : "custom"
              }
              disabled={busy}
              onChange={(e) =>
                setMinutes(
                  e.target.value === "custom" ? 15 : Number(e.target.value),
                )
              }
            >
              <option value="5">Every 5 minutes</option>
              <option value="60">Every hour</option>
              <option value="custom">Custom</option>
            </select>
          </label>
        )}
        {recurrence === "interval" && (
          <label>
            Minutes
            <input
              aria-label="History interval minutes"
              type="number"
              min={1}
              max={1440}
              required
              value={minutes}
              disabled={busy}
              onChange={(e) => setMinutes(Number(e.target.value))}
            />
          </label>
        )}
        {recurrence === "daily" && (
          <>
            <label>
              Daily time
              <input
                aria-label="History daily time"
                type="time"
                required
                value={daily}
                disabled={busy}
                onChange={(e) => setDaily(e.target.value)}
              />
            </label>
            <label>
              Timezone
              <input
                aria-label="History timezone"
                value={timezone}
                required
                maxLength={80}
                disabled={busy}
                onChange={(e) => setTimezone(e.target.value)}
              />
            </label>
            <label>
              Within ± minutes
              <input
                aria-label="History daily tolerance"
                type="number"
                min={0}
                max={120}
                required
                value={tolerance}
                disabled={busy}
                onChange={(e) => setTolerance(Number(e.target.value))}
              />
            </label>
          </>
        )}
        <button className="primary" disabled={busy}>
          Look up history
        </button>
        <button
          className="secondary"
          type="button"
          disabled={busy || !records.length}
          onClick={download}
        >
          <Download size={16} />
          Export CSV
        </button>
      </form>
      {exportStarted && <p className="fine" role="status">CSV streams directly to your browser. Cancel in its Downloads panel. Exports stop after five minutes; use a smaller time range if needed.</p>}
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <p className="fine">
        {range.recurrence === "interval"
          ? `Showing the newest saved record in each ${range.minutes}-minute interval, anchored at the start of this range. Empty intervals remain gaps. Limit: 366 days and 10,000 buckets per lookup.`
          : range.recurrence === "daily"
            ? `Showing the closest saved record within ±${range.tolerance} minutes of ${range.daily} in ${range.timezone}, up to 366 days. Missing spring-forward times are skipped; repeated fall-back times use the first occurrence.`
            : "Showing every saved record in this range."}{" "}
        Recurrence changes this lookup and its CSV export; all original records
        stay saved.
      </p>
      {busy && <p role="status">Loading saved history…</p>}
      {!busy && !records.length && (
        <p>
          No saved records in this time range. Offline phones upload queued GPS
          fixes when they reconnect.
        </p>
      )}
      {range.kind === "locations" && points.length > 0 && (
        <>
          <div className="trail-caption">
            GPS HISTORY · LOADED POINTS · LOCAL DATA ONLY
          </div>
          <PrivateMap
            points={points as Location[]}
            selected={chosen as Location | null}
            label="OpenStreetMap GPS history"
          />
          <svg
            className="history-trail"
            viewBox="0 0 700 260"
            role="img"
            aria-label="Saved GPS trail, longitude horizontally and latitude vertically"
          >
            <rect width="700" height="260" rx="12" fill="#f2f0f8" />
            {[1, 2, 3, 4].map((n) => (
              <path
                key={n}
                d={`M${n * 140} 20V240 M20 ${n * 50}H680`}
                stroke="#ded7ec"
                strokeWidth="0.6"
              />
            ))}
            <text
              x="350"
              y="253"
              textAnchor="middle"
              fill="#8e7da7"
              fontSize="8"
            >
              LONGITUDE →
            </text>
            <text x="16" y="18" fill="#8e7da7" fontSize="8">
              LATITUDE ↑
            </text>
            <polyline
              points={points.map(xy).join(" ")}
              fill="none"
              stroke="#8771bd"
              strokeWidth="2"
            />
            {points.map((p) => {
              const [cx, cy] = xy(p).split(",");
              return (
                <circle
                  key={p.observed_at}
                  cx={cx}
                  cy={cy}
                  r={chosen?.observed_at === p.observed_at ? 6 : 3}
                  fill={
                    chosen?.observed_at === p.observed_at
                      ? "#47316d"
                      : "#a18bc8"
                  }
                >
                  <title>
                    {new Date(p.observed_at! * 1000).toLocaleString()}
                  </title>
                </circle>
              );
            })}
          </svg>
          {chosen && (
            <p className="history-selection">
              Selected: {new Date(chosen.observed_at! * 1000).toLocaleString()}{" "}
              · {chosen.latitude!.toFixed(6)}, {chosen.longitude!.toFixed(6)} ·
              ±{Math.round(chosen.accuracy!)} m
            </p>
          )}
          <p className="fine">
            Lines connect sampled fixes; gaps do not prove a route or continuous
            coverage. Accuracy is reported by the phone.
          </p>
        </>
      )}
      {range.kind === "network" && chosen && (
        <>
          <NetworkCard network={chosen as NetworkObservation} />
          {chosen.geoip?.latitude != null && (
            <PrivateMap
              points={[]}
              network={chosen as NetworkObservation}
              label="Historical approximate IP location"
            />
          )}
        </>
      )}
      {records.length > 0 && (
        <div className="history-table-wrap">
          <table className="history-table">
            <thead>
              <tr>
                {range.kind === "locations" ? (
                  <>
                    <th>Observed</th>
                    <th>Coordinates</th>
                    <th>Accuracy</th>
                    <th>Received</th>
                  </>
                ) : range.kind === "network" ? (
                  <>
                    <th>Observed</th>
                    <th>Connection IP</th>
                    <th>Approximate area</th>
                    <th>Database radius</th>
                  </>
                ) : (
                  <>
                    <th>Received</th>
                    <th>Battery</th>
                    <th>Charging</th>
                    <th>Mode</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {records.map((r) => (
                <tr key={range.kind !== "state" ? r.observed_at : r.id}>
                  {range.kind === "locations" ? (
                    <>
                      <td>
                        <button
                          className="text-button"
                          onClick={() => setChosen(r)}
                        >
                          {new Date(r.observed_at! * 1000).toLocaleString()}
                        </button>
                      </td>
                      <td>
                        {r.latitude!.toFixed(6)}, {r.longitude!.toFixed(6)}
                      </td>
                      <td>±{Math.round(r.accuracy!)} m</td>
                      <td>{new Date(r.received_at * 1000).toLocaleString()}</td>
                    </>
                  ) : range.kind === "network" ? (
                    <>
                      <td>
                        <button
                          className="text-button"
                          onClick={() => setChosen(r)}
                        >
                          {new Date(r.observed_at! * 1000).toLocaleString()}
                        </button>
                      </td>
                      <td>{r.ip}</td>
                      <td>{geoLabel(r.geoip)}</td>
                      <td>
                        {r.geoip?.accuracy_radius_km
                          ? `${r.geoip.accuracy_radius_km} km`
                          : "Unknown"}
                      </td>
                    </>
                  ) : (
                    <>
                      <td>{new Date(r.received_at * 1000).toLocaleString()}</td>
                      <td>{r.battery}%</td>
                      <td>{r.charging ? "Yes" : "No"}</td>
                      <td>{r.device_owner ? "Managed" : "Personal"}</td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {next !== null && (
        <button className="secondary" disabled={busy} onClick={more}>
          Load older records
        </button>
      )}
      <p className="fine">
        GPS time is when the fix was observed. Received time is when your server
        stored it. Check-in battery values describe receipt time, not a
        backfilled GPS observation.
      </p>
    </section>
  );
}
function Stat({
  icon,
  label,
  value,
  note,
  color = "blue",
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  note: string;
  color?: string;
}) {
  return (
    <div className="stat panel">
      <div>
        <span className={`stat-icon ${color}`}>{icon}</span>
        <span className="stat-label">{label}</span>
      </div>
      <strong>{value}</strong>
      <small>{note}</small>
    </div>
  );
}
function LocationView({ device }: { device?: Device }) {
  const loc = device?.telemetry?.location;
  return (
    <>
      {loc || device?.network?.geoip?.latitude != null ? (
        <PrivateMap
          points={loc ? [loc] : []}
          selected={loc}
          network={device?.network}
          label="Last-known GPS and approximate IP location"
        />
      ) : (
        <div className="map">
          <div className="map-placeholder">
            <span>
              <MapPin size={25} />
            </span>
            <strong>
              {device
                ? "Waiting for a location"
                : "Their next adventure starts here."}
            </strong>
            <small>
              {device
                ? "The phone needs location permission and a connection home."
                : "Pair a phone to see its last-known coordinates."}
            </small>
          </div>
        </div>
      )}
      {loc && (
        <p className="gps-coordinate">
          GPS: {loc.latitude.toFixed(6)}, {loc.longitude.toFixed(6)} · ±
          {Math.round(loc.accuracy)} m
        </p>
      )}
      <NetworkCard network={device?.network} />
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
