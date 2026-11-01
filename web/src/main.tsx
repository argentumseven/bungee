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
import { gpsTrail, currentEstimate } from "./gpsTrail";
import {
  PrivateMap,
  NetworkCard,
  geoLabel,
  type NetworkObservation,
} from "./PrivateMap";
import { DeviceCare } from "./DeviceCare";
import { AppearanceControl, useAppearance } from "./Appearance";
import { RecoveryMessagePreview } from "./RecoveryMessagePreview";
import { PasswordSettings } from "./PasswordSettings";
import { RecoveryPhotos } from "./RecoveryPhotos";
import { MapManager } from "./MapManager";

type Location = {
  latitude: number;
  longitude: number;
  accuracy: number;
  source?: string;
  samples?: number;
  system_vpn?: boolean | null;
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
  can_purge_binding?: boolean;
  preshared_key: boolean;
  capabilities: string[];
  network?: NetworkObservation | null;
  management?: { connection_health?: Health | null };
  telemetry: null | {
    battery: number;
    charging: boolean;
    location: Location | null;
    device_owner: boolean;
  };
};
type Health = { since:number; reported_at:number; connection:string; system_vpn:boolean|null; signal_dbm:number|null; attempts:number; succeeded:number; last_rtt_ms:number|null; mean_rtt_ms:number; jitter_ms:number };
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
      <img className="brand-mark" src="/bungee-mark.png" width="48" height="48" alt="" aria-hidden="true" />
      bungee<span className="brand-dot">.</span>
    </div>
  );
}
function App() {
  const [loginNotice, setLoginNotice] = useState("");
  const appearance = useAppearance();
  const [auth, setAuth] = useState<boolean | null>(null),
    [password, setPassword] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [devices, setDevices] = useState<Device[]>([]),
    [commands, setCommands] = useState<Command[]>([]),
    [events, setEvents] = useState<Event[]>([]),
    [selected, setSelected] = useState(""),
    [page, setPage] = useState("Overview");
  const [devicesExpanded,setDevicesExpanded]=useState(true);
  const [trackingTab,setTrackingTab]=useState("Current estimate");
  const [modal, setModal] = useState<
      "enroll" | "message" | "revoke" | "clear_location" | "purge_binding" | "help" | null
    >(null),
    [toast, setToast] = useState("");
  const [name, setName] = useState(""),
    [wgKey, setWgKey] = useState(""),
    [previousWgKey, setPreviousWgKey] = useState(""),
    [bundle, setBundle] = useState(""),
    [qr, setQr] = useState<{ bundle: string; src: string } | null>(null),
    [message, setMessage] = useState(""),
    [lastRefresh, setLastRefresh] = useState<number | null>(null);
  const [clearTarget, setClearTarget] = useState<Device | null>(null);
  const [bindingTarget, setBindingTarget] = useState<Device | null>(null);
  const [purgedBinding,setPurgedBinding]=useState<Device|null>(null);
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
  useEffect(()=>{
    const show=()=>{setPage("Settings");window.setTimeout(()=>document.getElementById("map-downloads")?.scrollIntoView({behavior:"smooth",block:"start"}),0);};
    window.addEventListener("bungee:maps",show);
    return()=>window.removeEventListener("bungee:maps",show);
  },[]);
  useEffect(() => {
    const expire = () => {
      setAuth(false);
      setDevices([]);
      setCommands([]);
      setEvents([]);
      setSelected("");
      setPage("Overview");
      setTrackingTab("Current estimate");
      setModal(null);
      setClearTarget(null);
      setBindingTarget(null);
      setPurgedBinding(null);
      setBundle("");
      setPreviousWgKey("");
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
    let current = true;
    setQr(null);
    if (bundle)
      QRCode.toDataURL(bundle, {
        width: 320,
        margin: 2,
        errorCorrectionLevel: "M",
      }).then(src => { if (current) setQr({ bundle, src }); })
        .catch(() => { if (current) setError("Could not create the QR. Copy the enrollment text instead."); });
    return () => { current = false; };
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
      setToast("Command queued. Check Recent commands for the phone’s response.");
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
    setQr(null);
    setPreviousWgKey("");
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
            <span className="eyebrow">SELF-HOSTED DEVICE FINDER</span>
            <h1>
              Find your
              <br />
              household’s
              <br />
              <em>phones.</em>
            </h1>
            <p>
              Check locations, send recovery messages and manage paired phones
              from your own server.
            </p>
          </div>
          <div className="story-footer">
            <ShieldCheck size={18} /> Phone records are stored on your server.
          </div>
        </section>
        <section className="login-panel">
          <div className="login-appearance"><AppearanceControl {...appearance} /></div>
          <div className="login-form">
            <div className="icon-tile">
              <Fingerprint size={30} />
            </div>
            <span className="eyebrow">BUNGEE ADMINISTRATION</span>
            <h2>Sign in to Bungee</h2>
            <p>
              Enter the administrator password for this server.
            </p>
            <form onSubmit={login}>
              {loginNotice && <p role="status">{loginNotice}</p>}
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
                Sign in
                <ArrowRight size={17} />
              </button>
            </form>
            <p className="fine">
              <LockKeyhole size={13} /> Use the password chosen during installation. Forgotten it? Reset it on the server with the host password command.
            </p>
          </div>
          <div className="login-caption">
            ANDROID & GRAPHENEOS
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
            <small>Paired phones</small>
          </div>
          <ShieldCheck size={16} />
        </div>
        <span className="nav-label">WORKSPACE</span>
        <nav>
          {[
            { name: "Overview", icon: House },
            { name: "Devices", icon: Smartphone },
            { name: "Device care", icon: ShieldCheck },
            { name: "Tracking", icon: Compass },
            { name: "Tunnels", icon: Radio },
            { name: "Activity", icon: Activity },
            { name: "Settings", icon: Settings },
          ].map(({ name, icon: Icon }) => (
            <React.Fragment key={name}><button
              key={name}
              className={page === name ? "nav-item active" : "nav-item"}
              aria-expanded={name==="Devices"?devicesExpanded:undefined}
              onClick={() => { if (name === "Devices" && page === "Devices") setDevicesExpanded(v=>!v); else {setPage(name); if(name==="Devices") setDevicesExpanded(true);} }}
            >
              <Icon size={19} />
              {name}{name==="Devices" && <ChevronRight size={14} style={{transform:devicesExpanded?"rotate(90deg)":undefined}}/>}
              {name === "Devices" && (
                <span className="nav-count">{active.length}</span>
              )}
            </button>{name==="Devices" && devicesExpanded && <div className="nav-phones" aria-label="Paired phones">{active.slice(0,5).map(d=><button key={d.id} className={page==="Devices" && device?.id===d.id ? "nav-item active":"nav-item"} onClick={()=>{setSelected(d.id);setPage("Devices");}}><i className={`status-dot ${online(d)?"":"offline"}`} />{d.name}</button>)}</div>}</React.Fragment>
          ))}

        </nav>
        <div className="sidebar-bottom">
          <div className="privacy-note">
            <div>
              <ShieldCheck size={18} />
              <strong>Local storage</strong>
            </div>
            <p>Location history is kept until you erase it.</p>
            <span>
              <i className="status-dot" /> Self-hosted
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
            <AppearanceControl {...appearance} />
            <i className="status-dot" />
            Self-hosted
          </div>
        </header>
        <main className="main">
          <div className="page-heading">
            <div>
              <div className="eyebrow">HOUSEHOLD PHONES</div>
              <h1>
                {page === "Devices" && device ? device.name : page}
              </h1>
              <p>
                {page === "Overview"
                  ? "All household phones, their battery and last reported connection."
                  : page === "Devices"
                    ? "Recovery controls and tasks for this phone."
                    : page === "Device care"
                      ? "Lost mode, theft photos and the phone’s last reported settings."
                      : page === "Tracking"
                        ? "Current estimates, movement history, network locations and recovery photos."
                        : page === "Activity"
                          ? "Enrollment, administrator access and command events."
                          : "Connection, permissions and data retention."}
              </p>
            </div>
            {["Overview", "Devices"].includes(page) && (
              <button
                className="primary"
                onClick={() => {
                  setName("");
                  setWgKey("");
                  setPreviousWgKey("");
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
          {page === "Overview" && <section className="phone-overview" aria-label="Your devices">
            {active.length===0 && <section className="panel care-card"><h2>No paired phones</h2><p>Add a device and scan its invitation in Bungee.</p></section>}
            {active.map(d=><button className="panel phone-card" key={d.id} onClick={()=>{setSelected(d.id);setPage("Devices");}}>
              <Smartphone size={26}/><h2>{d.name}</h2><strong><i className={`status-dot ${online(d)?"":"offline"}`}/>{!d.enrolled?"Awaiting enrollment":online(d)?"Connected":"Offline"}</strong>
              <p>Battery {d.telemetry ? `${d.telemetry.battery}%${d.telemetry.charging?" · charging":""}`:"not reported"}</p>
              <p>{connectionLabel(d)}{d.management?.connection_health?.signal_dbm!=null?` · ${d.management.connection_health.signal_dbm} dBm`:" · signal strength unavailable"}</p>
              <small>{d.name}: last authenticated contact {ago(d.last_contact??d.last_seen)}</small><span>Open recovery controls →</span>
            </button>)}
          </section>}
          {page === "Devices" && (
            <>
              {active.length>1 && <label className="device-picker">Phone<select value={device?.id||""} onChange={e=>setSelected(e.target.value)}>{active.map(d=><option key={d.id} value={d.id}>{d.name}</option>)}</select></label>}
              {device && <section className="panel care-card device-summary"><h2>{device.name} · {online(device)?"Connected":"Offline"}</h2><p>Last authenticated contact {ago(device.last_contact??device.last_seen)} · Battery {device.telemetry?`${device.telemetry.battery}%`:"not reported"} · {connectionLabel(device)}</p><button className="text-button" onClick={()=>setPage("Device care")}>Device care &amp; theft-photo status</button><button className="text-button" onClick={()=>setPage("Tracking")}>Tracking &amp; history</button></section>}
              <div className="dashboard-grid device-detail-grid">
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
                            : "No saved location"}
                        </strong>
                        <small>
                          {device?.telemetry?.location
                            ? `Accuracy ±${Math.round(device.telemetry.location.accuracy)} m · observed ${ago(device.telemetry.location.observed_at)}`
                            : "Start GPS sharing on the phone to save its location."}
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
                    <h2>Recovery commands</h2>
                    <span className="subtle">
                      {device ? device.name : "SELECT A PAIRED DEVICE"}
                    </span>
                  </div>
                  <button className="stop-actions" disabled={busy || !device?.enrolled || !device.capabilities.includes("stop_all")} onClick={() => send("stop_all")}><VolumeX size={18}/> Stop all Bungee actions <small>Stop sound, flash and remote GPS; clear messages and lost mode</small></button>
                  <p className="fine">A stop waits for the phone to connect. It cancels outstanding commands. It cannot unlock Android after a screen lock has already happened.</p>
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
                        name: "Sound alarm",
                        desc: "Up to 30 sec · maximum alarm volume",
                        icon: BellRing,
                      },
                      {kind:"best_guess",name:"Best guess",desc:"Collect a longer GPS burst",icon:Compass},
                      {kind:"ring_flash",name:"Alarm + flash",desc:"Sound and rear-camera flash",icon:BellRing},
                      {kind:"flash",name:"Flash only",desc:"Find the phone visually",icon:Zap},
                      {kind:"dns_check",name:"Test DNS path",desc:"Phone → Bungee → home resolver",icon:Activity},
                      {
                        kind: "message",
                        name: "Leave a message",
                        desc: "An Android notification",
                        icon: MessageSquare,
                      },
                      {
                        kind: "lock",
                        name: "Lock device",
                        desc: "Standard Android lock · unlock normally",
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
                  <p className="alarm-note">The updated phone app raises alarm volume temporarily and restores it afterward. Notification Stop requires unlock. Android interruption settings, system controls and hardware can still stop or suppress it.</p>
                  <details className="alarm-preview">
                    <summary>Preview alarm sound</summary>
                    <audio controls preload="none" src="/recovery-siren.wav" aria-label="Two-second siren preview" />
                    <p>Your browser plays one two-second cycle. The updated phone app repeats it for up to 30 seconds at maximum alarm volume, then restores the previous level. Older APKs use the earlier alarm tone.</p>
                  </details>
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
                    .slice(0, 20)
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
                        {["pending","delivered"].includes(c.status) && <button className="text-button" disabled={busy} onClick={async()=>{
                          setBusy(true); try {await api(`/devices/${c.device_id}/commands/${c.id}`,{method:"DELETE"});setToast(c.status==="delivered"?"Retries stopped. A command already offered may still complete.":"Command canceled before delivery.");await load();}catch(e){setError((e as Error).message);}finally{setBusy(false);}
                        }}>{c.status==="pending"?"Cancel":"Stop retries"}</button>}
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
                      <strong>No recent commands</strong>
                      <p>Command receipts will appear here.</p>
                    </div>
                  )}
                </section>
              </div>
            </>
          )}
          {page === "Tunnels" && <TunnelView devices={active}/>}
          {page === "Tracking" && (
            <>
              <div className="tracking-tabs" role="group" aria-label="Tracking views">{["Current estimate","GPS history","IP observations","Check-ins","Photos"].map(tab=><button key={tab} aria-pressed={trackingTab===tab} className={trackingTab===tab?"primary":"secondary"} onClick={()=>setTrackingTab(tab)}>{tab}</button>)}</div>
              <div className="tracking-device"><label htmlFor="history-device">Device</label>
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
              </select></div>
              {trackingTab==="Photos" ? <RecoveryPhotos/> : device ? (
                trackingTab==="Current estimate"?<CurrentTracking device={device}/>:<HistoryView key={`${device.id}-${trackingTab}`} device={device} initialKind={trackingTab==="IP observations"?"network":trackingTab==="Check-ins"?"state":"locations"} />
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
              <MapManager/>
              <PasswordSettings onChanged={() => {
                window.dispatchEvent(new Event("bungee:session-expired"));
                setPassword("");
                setError("");
                setLoginNotice("Password changed. Sign in with your new password.");
              }} />
              <section className="panel settings-card">
                <ShieldCheck size={26} />
                <h2>Connection and storage</h2>
                <p>
                  The dashboard and device API use separate listeners. Device
                  requests are signed with phone-held keys, timestamped, and
                  protected against replay. Bungee sends only{" "}
                  its home API traffic to <code>10.77.0.1/32</code> through WireGuard.
                </p>
                <ul>
                  <li>
                    GPS, IP history, recovery photos and check-in logs stay until explicitly
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
                  Physical GrapheneOS testing and an independent security audit
                  are still pending. Test recovery on your phone before relying on it.
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
                  Theft photos need one-time approval on the phone and a running
                  camera service. Optional boot recovery needs separate Android
                  special access. Recovery messages use Android notifications;
                  their visibility follows the phone’s notification settings.
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
                      <button className="text-button" onClick={() => { setName(d.name); setWgKey(d.wg_public_key!); setPreviousWgKey(""); setBundle(""); setModal("enroll"); }}>
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
              <section className="panel settings-card">
                <KeyRound size={26} />
                <h2>Inactive pairings</h2>
                <p>Remove revoked devices or expired, unused invitations to free their phone public keys for a fresh invitation. Paired phones stay protected while offline. To retire one, revoke it first.</p>
                {devices.filter(d => d.can_purge_binding).length === 0 && <p>No inactive bindings to remove.</p>}
                {devices.filter(d => d.can_purge_binding).map(d => <div className="settings-device" key={d.id}>
                  <strong>{d.name}</strong>
                  <small>{d.revoked ? "Revoked" : "Expired invitation · never paired"}</small>
                  <button className="danger-text" onClick={() => { setBindingTarget(d); setModal("purge_binding"); setError(""); }}>Purge binding</button>
                </div>)}
                {purgedBinding&&<button className="secondary" onClick={()=>{
                  setName(purgedBinding.name);setWgKey("");setPreviousWgKey(purgedBinding.wg_public_key||"");setBundle("");setModal("enroll");
                }}>Create another invitation</button>}
              </section>
            </div>
          )}
          <footer className="main-footer">
            <span>
              <Heart size={13} />
              Bungee · Self-hosted device finder
            </span>
            <span>
              {lastRefresh
                ? `Updated ${new Date(lastRefresh).toLocaleTimeString()}`
                : "Connecting…"}
              <span className="footer-dot">·</span>Server storage
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
            className={modal === "message" ? "modal message-modal" : "modal"}
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
                ? "Pair a phone"
                : modal === "message"
                  ? "Leave a recovery message"
                  : modal === "clear_location"
                    ? "Erase this saved history?"
                    : modal === "revoke"
                      ? "Revoke this device?"
                      : modal === "purge_binding" ? "Purge this inactive binding?" : "Pairing instructions"}
            </h2>
            {modal === "enroll" && !bundle && (
              <form onSubmit={enroll}>
                <p>
                  Open Bungee on the phone and copy its WireGuard public key.
                  The private key never leaves the phone.
                  If Bungee was reinstalled or new phone keys were generated, copy the new key now; the previous key will not work.
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
                {previousWgKey && <p className="fine">
                  Only reuse the previous key if it still matches the key shown on this phone. Reinstalling Bungee changes it.
                  <button type="button" className="text-button" onClick={() => setWgKey(previousWgKey)}>Use previous phone key</button>
                </p>}
                <p className="fine">
                  The phone user must approve sharing. Reissuing an invitation for
                  an unpaired phone invalidates its earlier invitation and tunnel secret.
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
                  Scan this with Bungee on the phone, review the sharing
                  consent and choose Agree &amp; pair. This invitation expires in 10 minutes. It
                  contains a long-lived preshared key. Use a trusted local
                  administrator connection and keep the QR private.
                </p>
                {qr && qr.bundle === bundle && (
                  <img
                    className="qr"
                    src={qr.src}
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
                className="message-composer"
                onSubmit={(e) => {
                  e.preventDefault();
                  void send("message", message);
                }}
              >
                <div className="message-editor">
                <p>
                  A high-priority notification for {device?.name}. It can appear
                  as a heads-up banner or on the lock screen when Android allows it.
                  Unlock controls stay available.
                </p>
                <label htmlFor="recovery-message">Recovery message</label>
                <textarea
                  id="recovery-message"
                  required
                  autoFocus
                  maxLength={240}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="If you find this phone, please call…"
                />
                <small>{message.length}/240 characters</small>
                <button className="primary full" disabled={busy}>
                  <MessageSquare size={17} />
                  Queue message
                </button>
                <p className="fine">Up to 240 characters. You can clear the message remotely; the phone can dismiss it after local unlock. Notification permission and privacy settings still apply.</p>
                </div>
                <RecoveryMessagePreview message={message} />
              </form>
            )}
            {modal === "clear_location" && (
              <>
                <p>
                  Erase all GPS history, IP observations, recovery photos, check-in logs, and the
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
                  history, IP observations, recovery photos, check-in logs and pending commands
                  will be erased, and its WireGuard access removed. To pair it
                  again with the same phone key, purge its inactive binding in Settings and create a fresh invitation.
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
            {modal === "purge_binding" && bindingTarget && <>
              <p>Remove the inactive record for <strong>{bindingTarget.name}</strong> and any remaining records for it? This frees its phone public key. Old invitations and connection secrets will not work again.</p>
              <p>Your phone is unchanged. Keep its current keys or generate new ones in Bungee’s Pairing &amp; recovery screen. A fresh invitation is always required.</p>
              <button className="primary danger full" disabled={busy} onClick={async () => {
                const target = bindingTarget;
                setBusy(true); setError("");
                try {
                  await api(`/devices/${target.id}/binding`, {method:"DELETE"});
                  await load();
                  setName(target.name); setWgKey(""); setPreviousWgKey(target.wg_public_key || ""); setBundle("");
                  setPurgedBinding(target);setBindingTarget(null); setModal(null);
                  setToast("Inactive binding purged. The phone is unchanged.");
                } catch(e) { setError((e as Error).message); }
                finally { setBusy(false); }
              }}>Purge binding</button>
            </>}
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
function HistoryView({ device, initialKind="locations" }: { device: Device; initialKind?:string }) {
  const [from, setFrom] = useState(() => localDateTime(Date.now() - 86400000));
  const [to, setTo] = useState(() => localDateTime(Date.now() + 60000));
  const [kind, setKind] = useState(initialKind);
  const [source,setSource]=useState("all");
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
    kind: initialKind,
    source: "all",
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
    `/devices/${device.id}/history?${new URLSearchParams({ from: String(range.from), to: String(range.to), kind: range.kind, source: range.kind==="locations"?range.source:"all", limit: "200", ...(range.recurrence === "interval" ? { every: String(range.minutes * 60) } : range.recurrence === "daily" ? { daily: range.daily, timezone: range.timezone, tolerance: String(range.tolerance * 60) } : {}), ...(before ? { before: String(before) } : {}) })}`;
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
    .filter((r): r is HistoryRecord & { latitude: number; longitude: number } =>
      r.latitude !== undefined && r.longitude !== undefined)
    .slice()
    .reverse();
  const displayTrail = gpsTrail(points);
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
            source:kind==="locations"?source:"all",
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
        {kind==="locations" && <label>Collection source<select aria-label="GPS collection source" value={source} onChange={e=>setSource(e.target.value)}><option value="all">All GPS</option><option value="passive">Passive samples</option><option value="homing">Requested homing</option><option value="haste">Lost mode · haste</option><option value="best_guess">Best-guess bursts</option></select></label>}
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

          {displayTrail.ignored > 0 && <p className="fine">{displayTrail.ignored} uncertain fix{displayTrail.ignored === 1 ? "" : "es"} omitted from visual trail; raw records remain available below and in CSV.</p>}
          {displayTrail.points.length === 0 && <p className="fine">No reliable GPS fixes to plot in this range.</p>}
          {chosen && (
            <p className="history-selection">
              Selected: {new Date(chosen.observed_at! * 1000).toLocaleString()}{" "}
              · {chosen.latitude!.toFixed(6)}, {chosen.longitude!.toFixed(6)} ·
              ±{Math.round(chosen.accuracy!)} m
            </p>
          )}
          <p className="fine">
            Lines connect only plausible nearby fixes; gaps remain open and lines do not prove a traveled route. Accuracy is reported by the phone.
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
                    <th>Uncertainty</th><th>Collection</th>
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
                      <td>±{Math.round(r.accuracy!)} m</td><td>{(r.source||"passive").replaceAll("_"," ")} · {r.samples||1} samples{r.system_vpn&&<small className="vpn-note">System VPN · IP estimate uncertain</small>}</td>
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
function connectionLabel(d:Device) { const h=d.management?.connection_health; return h?`${({wifi:"Wi-Fi",cellular:"Cellular",ethernet:"Ethernet",vpn:"System VPN",offline:"No network",other:"Other connection"} as Record<string,string>)[h.connection]||"Unknown"} · reported ${ago(h.reported_at)}`:"Connection type not yet reported"; }
function TunnelView({devices}:{devices:Device[]}) {
 return <section className="tunnel-grid">{devices.map(d=>{const h=d.management?.connection_health;return <section className="panel care-card" key={d.id}><h2>{d.name} · {online(d)?"Reachable":"No recent contact"}</h2><p>Overlay {d.address} · {connectionLabel(d)}</p><dl className="care-health"><div><dt>Last signed contact</dt><dd>{ago(d.last_contact??d.last_seen)}</dd></div><div><dt>Last API round trip</dt><dd>{h?.last_rtt_ms!=null?`${h.last_rtt_ms} ms`:"Not reported"}</dd></div><div><dt>Smoothed round trip / jitter</dt><dd>{h?`${h.mean_rtt_ms} / ${h.jitter_ms} ms`:"Not reported"}</dd></div><div><dt>API probes succeeded</dt><dd>{h&&h.attempts?`${h.succeeded}/${h.attempts} (${(h.succeeded/h.attempts*100).toFixed(1)}%)`:"Not reported"}</dd></div><div><dt>Signal strength</dt><dd>{h?.signal_dbm!=null?`${h.signal_dbm} dBm`:"Android did not provide it"}</dd></div></dl><p className="fine">Signed application probes over Bungee’s tunnel. Counts reset with the phone process{h?` · since ${new Date(h.since*1000).toLocaleString()}`:""}. These are not ICMP packet-loss measurements; the last report can be stale while offline.</p>{h?.system_vpn&&<p className="notice">System VPN reported: GeoIP may describe its exit. Satellite GPS is unaffected by VPN routing.</p>}</section>})}{devices.length===0&&<p>Pair a phone to see tunnel measurements.</p>}</section>;
}
function CurrentTracking({device}:{device:Device}) {
 const [points,setPoints]=useState<Location[]>([]),[error,setError]=useState("");
 useEffect(()=>{const abort=new AbortController();const load=()=>{const to=Math.floor(Date.now()/1000)+120;api<{records:Location[]}>(`/devices/${device.id}/history?from=${to-720}&to=${to}&kind=locations&limit=200`,{signal:abort.signal}).then(r=>setPoints(r.records)).catch(e=>{if(!abort.signal.aborted)setError(e.message);});};load();const timer=setInterval(load,15000);return()=>{abort.abort();clearInterval(timer);};},[device.id]);
 const estimate=currentEstimate(points)||device.telemetry?.location;
 const h=device.management?.connection_health;
 return <section className="panel care-card"><h2>{device.name} · current best estimate</h2>{error&&<p role="alert">{error}</p>}<PrivateMap points={estimate?[estimate]:[]} selected={estimate} network={device.network} label={`${device.name} current estimate`}/>{estimate?<p>{estimate.latitude.toFixed(6)}, {estimate.longitude.toFixed(6)} · uncertainty ±{Math.round(estimate.accuracy??0)} m · observed {ago(estimate.observed_at??null)}{"samples" in estimate?` · ${estimate.samples} contributing samples`:""}</p>:<p>No saved GPS fix. Enable location sharing on the phone.</p>}<p className="fine">Recent stationary fixes use an accuracy-weighted average with an accuracy floor. Moving phones keep their latest position. Averaging reduces jitter; correlated GPS errors can still place the phone outside this estimate. Use Best guess on the device page to request a longer burst.</p>{h?.system_vpn&&<p className="notice">GeoIP confidence: low · system VPN reported. The IP area may be a VPN exit. VPN use does not reduce satellite GPS accuracy.</p>}</section>;
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
