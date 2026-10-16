import React, { useEffect, useState } from "react";
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
import "./style.css";

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
  revoked: boolean;
  enrolled: boolean;
  capabilities: string[];
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
  !!d.last_seen && Date.now() / 1000 - d.last_seen < 150 && !d.revoked;
async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...options,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  if (!res.ok) {
    if (res.status === 401 && path !== "/session")
      window.dispatchEvent(new Event("bungee:session-expired"));
    const body = await res.json().catch(() => ({ error: "Connection failed" }));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}
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
        body: JSON.stringify({ kind, message: text }),
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
      await api(`/devices/${clearTarget.id}/location`, { method: "DELETE" });
      setModal(null);
      setClearTarget(null);
      setToast(
        "Saved location erased. New fixes can appear while sharing remains enabled.",
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
            BUNGEE <span>FOUNDATION · v0.1</span>
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
                    : page === "Activity"
                      ? "A clear trail."
                      : "Private by design."}
              </h1>
              <p>
                {page === "Overview"
                  ? "Everything you need to keep your household devices close."
                  : page === "Devices"
                    ? "Manage the phones that belong to your household."
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
                  note="Seen in the last 2½ minutes"
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
                                ? "Awaiting enrollment"
                                : online(d)
                                  ? "Connected"
                                  : "Offline"}
                              <span>·</span>
                              {ago(d.last_seen)}
                            </small>
                          </span>
                          <span className="battery">
                            {d.telemetry ? `${d.telemetry.battery}%` : "—"}
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
                          </small>
                        </div>
                        <span className={`command-status ${c.status}`}>
                          {c.status}
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
                    Last-known location and device state stay until erased or
                    the device is revoked
                  </li>
                  <li>One-use enrollment expires in 10 minutes</li>
                  <li>Remote commands expire in 5 minutes</li>
                  <li>No cloud push service or external map tiles</li>
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
                  Phones grant capabilities during enrollment. Optional
                  device-owner provisioning supports a future MDM control plane.
                  Android permits one VPN per profile; this tunnel occupies that
                  slot.
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
                        ? "Device-owner enrolled"
                        : "Personal-device mode"}{" "}
                      · {d.capabilities.join(", ") || "Awaiting consent"}
                    </small>
                    {d.telemetry?.location && (
                      <button
                        className="text-button"
                        onClick={() => {
                          setClearTarget(d);
                          setModal("clear_location");
                        }}
                      >
                        Clear saved location
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
                    ? "Erase this saved location?"
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
                  enrollment or silent tracking.
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
                  confirm enrollment. This invitation expires in 10 minutes.
                  Treat it as a secret.
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
                  Erase the last-known location for {clearTarget?.name}? The
                  phone stays paired. New fixes can appear while sharing is
                  enabled; older cached fixes will not restore the erased point.
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
                  Erase saved location
                </button>
              </>
            )}
            {modal === "revoke" && (
              <>
                <p>
                  Remove {device?.name} from your household. Its last location
                  and pending commands will be erased, and its WireGuard access
                  removed. To pair it again, reset pairing on the phone.
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
                  4. Approve VPN and location permissions. Start sharing from
                  the phone.
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
    <div className="map">
      <svg
        viewBox="0 0 700 280"
        preserveAspectRatio="xMidYMid slice"
        aria-hidden="true"
      >
        <defs>
          <pattern
            id="grid"
            width="35"
            height="35"
            patternUnits="userSpaceOnUse"
          >
            <path
              d="M 35 0 L 0 0 0 35"
              fill="none"
              stroke="#dbe3dc"
              strokeWidth="0.6"
            />
          </pattern>
        </defs>
        <rect width="700" height="280" fill="#edf1e9" />
        <path
          d="M0 200 Q150 140 225 220T500 150T740 100"
          fill="none"
          stroke="#d5e1c9"
          strokeWidth="110"
        />
        <path
          d="M600 -50 Q400 100 620 300"
          stroke="#c4dbe1"
          strokeWidth="35"
          fill="none"
        />
        {[0, 1, 2, 3, 4].map((n) => (
          <path
            key={n}
            d={`M-80 ${40 + n * 45} Q160 ${-60 + n * 40} 320 ${60 + n * 45} T760 ${80 + n * 44}`}
            fill="none"
            stroke="#ced8c7"
            strokeWidth="1.3"
          />
        ))}
        <path
          d="M0 70 L160 110 L400 30 L700 125 M100 280 L180 120 L330 130 L500 280 M-20 180 L150 170 L350 250 L720 160"
          stroke="#fff"
          strokeWidth="9"
          fill="none"
        />
        <path
          d="M0 70 L160 110 L400 30 L700 125 M100 280 L180 120 L330 130 L500 280 M-20 180 L150 170 L350 250 L720 160"
          stroke="#e5e8df"
          strokeWidth="1"
          fill="none"
        />
        <rect width="700" height="280" fill="url(#grid)" />
      </svg>
      <div className="map-caption">
        COORDINATE VIEW · ILLUSTRATIVE BACKGROUND
      </div>
      <span className="north">
        N<Compass size={20} />
      </span>
      {loc ? (
        <div className="map-location">
          <div className="location-chip">
            <Smartphone size={15} />
            {device?.name}
            <i
              className={`status-dot ${device && online(device) ? "" : "offline"}`}
            />
          </div>
          <span className="map-pin">
            <MapPin size={23} fill="currentColor" />
          </span>
          <span className="coordinates">
            {loc.latitude.toFixed(5)}, {loc.longitude.toFixed(5)}
          </span>
        </div>
      ) : (
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
      )}
      <div className="map-privacy">
        <ShieldCheck size={12} />
        No map provider sees your coordinates
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
