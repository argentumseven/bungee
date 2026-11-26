import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, Database, MapPinOff, Plane, ShieldCheck, Smartphone, Trash2, TriangleAlert, Crosshair } from "lucide-react";
import { api } from "./api";
import { RecordDates } from "./RecordDates";
import { activityQuery, ageChoices, auditTitle, categories, contextLine, formatBytes, groups, lateDelivery, phoneKinds, purgeQuery, type Detail, type Filter } from "./activityText";

type Row = {
  source: "server" | "phone"; id: string; ts: number; device_id: string | null;
  action?: string; detail?: string | Detail;
  kind?: string; category?: string; label?: string; at?: number | null; recorded_at?: number; received_at?: number; phone_name?: string; profile_name?: string | null;
};
type Page = { events: Row[]; next_before: string | null };
type Retention = {
  gps_days: number; activity_days: number;
  limits: { audit: number; events_per_phone: number; history_per_phone: number };
  usage: { audit: number; phone_events: number; gps_points: number; checkins: number; ip_observations: number; database_bytes: number };
};
type Phone = { id: string; name: string; revoked: boolean; enrolled: boolean };
const when = (n: number) => new Date(n * 1000).toLocaleString();
const icon = (row: Row) => {
  const k = row.kind ?? "";
  if (k.startsWith("airplane")) return <Plane size={16} />;
  if (k.startsWith("location_") || k.startsWith("permission") || k.startsWith("gps_gap")) return <MapPinOff size={16} />;
  return row.source === "phone" ? <Smartphone size={16} /> : <ShieldCheck size={16} />;
};

export function ActivityLog({ phones, refreshKey }: { phones: Phone[]; refreshKey: number }) {
  const [filter, setFilter] = useState<Filter>({ device: "", group: "all" });
  const [rows, setRows] = useState<Row[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [loaded, setLoaded] = useState(false);
  const older = useRef(false); // once older pages are requested, background refresh stops so the view stays put
  const requestScope = useRef<AbortController | null>(null);
  const names = (id: string | null) => phones.find(p => p.id === id)?.name;
  const loadFirst = useCallback(async (signal?: AbortSignal) => {
    try {
      const page = await api<Page>(`/activity${activityQuery(filter, null)}`, { signal });
      if (signal?.aborted) return;
      setRows(page.events); setNext(page.next_before); setError(""); setLoaded(true); older.current = false;
    } catch (e) { if (!signal?.aborted) setError((e as Error).message); }
  }, [filter]);
  useEffect(() => {
    const abort = new AbortController();
    requestScope.current = abort;
    setBusy(false);
    setLoaded(false); void loadFirst(abort.signal);
    const timer = window.setInterval(() => { if (!older.current) void loadFirst(abort.signal); }, 15000);
    return () => { abort.abort(); window.clearInterval(timer); };
  }, [loadFirst, refreshKey]);
  async function loadOlder() {
    if (!next || busy) return;
    const signal = requestScope.current?.signal;
    setBusy(true);
    older.current = true;
    try {
      const page = await api<Page>(`/activity${activityQuery(filter, next)}`, { signal });
      if (signal?.aborted) return;
      setRows(old => { const seen = new Set(old.map(r => `${r.source}:${r.id}`)); return [...old, ...page.events.filter(r => !seen.has(`${r.source}:${r.id}`))]; });
      setNext(page.next_before); setError("");
    } catch (e) { if (!signal?.aborted) setError((e as Error).message); }
    finally { if (!signal?.aborted) setBusy(false); }
  }
  return <>
    <section className="panel audit-panel" aria-label="Household activity">
      <div className="panel-heading">
        <h2><Activity size={18} />Household activity</h2>
        <span className="subtle">{rows.length ? `${rows.length} SHOWN${next ? " · MORE AVAILABLE" : " · ALL LOADED"}` : "NEWEST FIRST"}</span>
      </div>
      <div className="audit-controls">
        <div className="activity-filters">
          <label>Phone<select value={filter.device} onChange={e => setFilter({ ...filter, device: e.target.value })}>
            <option value="">All phones</option>
            {phones.filter(p => p.enrolled && !p.revoked).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select></label>
          <label>Show<select value={filter.group} onChange={e => setFilter({ ...filter, group: e.target.value })}>
            {groups.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select></label>
        </div>
        <RecordDates onApply={range => setFilter(current => ({ ...current, from: range.from, to: range.to }))} />
      </div>
      {error && <p className="error audit-feedback" role="alert">{error}</p>}
      {!loaded && !error && <p className="audit-feedback" role="status">Loading activity…</p>}
      {loaded && !rows.length && <p className="audit-feedback">No activity matches this view.</p>}
      <ol className="activity-list">
        {loaded && rows.map(row => {
          const phone = row.device_id ? names(row.device_id) ?? row.phone_name : undefined;
          const late = row.source === "phone" && lateDelivery(row.at ?? null, row.recorded_at ?? row.ts, row.received_at ?? row.ts);
          const context = row.source === "phone" ? contextLine(row.detail as Detail) : "";
          return <li className={`audit-row activity-${row.source}${row.category ? ` activity-${row.category}` : ""}`} key={`${row.source}:${row.id}`}>
            <span className="icon-tile small">{icon(row)}</span>
            <div>
              <strong>{row.source === "phone" ? (phoneKinds[row.kind ?? ""] ?? "Phone event") : auditTitle(row.action ?? "")}
                {row.source === "phone" && row.category && <span className="role-badge">{categories[row.category] ?? "Unknown"}</span>}
                {late && <span className="role-badge">Reported after reconnecting</span>}</strong>
              <small>{row.source === "phone" ? row.label : (row.detail as string) || "Administrator access"}{(row.profile_name ? `profile ${row.profile_name}` : phone) && ` · ${row.profile_name ? `profile ${row.profile_name}` : phone}`}</small>
              {context && <small className="activity-context">{context}</small>}
              {late && <small>Received by the server {when(row.received_at!)}</small>}
            </div>
            <time>{row.source === "phone" && row.at === null ? `Time unknown · detected ${when(row.recorded_at ?? row.ts)}` : when(row.ts)}</time>
          </li>;
        })}
      </ol>
      <div className="history-pagination">
        {loaded && next && <button type="button" className="secondary" disabled={busy} onClick={() => void loadOlder()}>{busy ? "Loading…" : "Load older activity"}</button>}
        {loaded && older.current && <button type="button" className="secondary" disabled={busy} onClick={() => void loadFirst(requestScope.current?.signal)}>Back to newest</button>}
      </div>
      <p className="fine">Phone events are sent by the phone when it can connect; a phone in airplane mode reports them afterwards, so they appear at the time they happened. Android does not tell Bungee who or what changed a setting, so each entry shows the circumstances instead. These are phone-reported diagnostics, not proof of what a person did.</p>
    </section>
    <LogMaintenance phones={phones} onChanged={() => void loadFirst(requestScope.current?.signal)} />
  </>;
}

function LogMaintenance({ phones, onChanged }: { phones: Phone[]; onChanged: () => void }) {
  const [retention, setRetention] = useState<Retention | null>(null);
  const [error, setError] = useState(""), [message, setMessage] = useState(""), [busy, setBusy] = useState(false);
  const enrolled = phones.filter(p => p.enrolled && !p.revoked);
  // Activity and GPS purges are separate decisions with their own phone and age, so one cannot be mistaken for the other.
  const [activity, setActivity] = useState({ device: "", days: 0, scope: "all" });
  const [gps, setGps] = useState({ device: "", days: 0 });
  const gpsTarget = gps.device === "all" ? undefined : enrolled.find(p => p.id === gps.device) ?? enrolled[0];
  const gpsPath = gpsTarget ? `/devices/${encodeURIComponent(gpsTarget.id)}/location` : "/locations";
  const [confirm, setConfirm] = useState<"" | "activity" | "gps">("");
  const [auto, setAuto] = useState({ gps_days: 0, activity_days: 0 });
  const load = useCallback(async () => {
    try { const data = await api<Retention>("/retention"); setRetention(data); setAuto({ gps_days: data.gps_days, activity_days: data.activity_days }); setError(""); }
    catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const ageText = (days: number) => days ? `older than ${ageChoices.find(([d]) => d === days)?.[1]}` : "everything";
  async function run(kind: "activity" | "gps") {
    setBusy(true); setError(""); setMessage("");
    try {
      if (kind === "activity") {
        const r = await api<{ server_removed: number; phone_removed: number }>(`/activity${purgeQuery(activity)}`, { method: "DELETE" });
        setMessage(`Activity purged: ${r.server_removed} administrator entries and ${r.phone_removed} phone events removed.`);
      } else {
        const r = await api<{ removed?: number; cleared?: boolean }>(`${gpsPath}${purgeQuery({ days: gps.days })}`, { method: "DELETE" });
        const result = gpsTarget
          ? "The newest point was kept."
          : "Each phone’s newest point was kept.";
        const removed = r.removed ?? 0;
        setMessage(gps.days ? `${removed} saved GPS ${removed === 1 ? "point" : "points"} removed. ${result}`
          : gpsTarget ? "All saved GPS points erased. The phone stays paired." : "Saved GPS erased for all phones.");
      }
      setConfirm(""); await load(); onChanged();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function saveAuto() {
    setBusy(true); setError(""); setMessage("");
    try { await api("/retention", { method: "PUT", body: JSON.stringify(auto) }); setMessage("Automatic cleanup saved. It runs every few minutes."); await load(); onChanged(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const ageSelect = (label: string, value: number, onChange: (n: number) => void, zero: string) => <select aria-label={label} value={value} onChange={e => onChange(Number(e.target.value))}>
    <option value={0}>{zero}</option>{ageChoices.map(([d, text]) => <option key={d} value={d}>{text}</option>)}
  </select>;
  const u = retention?.usage;
  const confirmRow = (kind: "activity" | "gps", label: string, disabled = false) => confirm === kind
    ? <div className="record-confirm-actions"><button type="button" className="secondary" disabled={busy} onClick={() => setConfirm("")}>Cancel</button><button type="button" className="record-danger" disabled={busy || disabled} onClick={() => void run(kind)}>Confirm purge</button></div>
    : <button type="button" className="record-danger" disabled={busy || disabled} onClick={() => setConfirm(kind)}>{label}</button>;
  return <section className="panel log-maintenance" aria-label="Log storage and cleanup">
    <div className="panel-heading"><h2><Database size={18} />Log storage and cleanup</h2><span className="subtle">KEEPS THE SERVER HEALTHY</span></div>
    {error && <p className="error" role="alert">{error}</p>}
    {message && <p className="care-notice" role="status">{message}</p>}
    {u && <dl className="care-health storage-usage">
      <div><dt>Saved GPS points</dt><dd>{u.gps_points.toLocaleString()}</dd></div>
      <div><dt>Check-ins</dt><dd>{u.checkins.toLocaleString()}</dd></div>
      <div><dt>IP observations</dt><dd>{u.ip_observations.toLocaleString()}</dd></div>
      <div><dt>Phone events</dt><dd>{u.phone_events.toLocaleString()}</dd></div>
      <div><dt>Administrator entries</dt><dd>{u.audit.toLocaleString()}</dd></div>
      <div><dt>Database on disk</dt><dd>{formatBytes(u.database_bytes)}</dd></div>
    </dl>}
    <p className="fine">The server trims itself so logs cannot grow without limit: administrator entries stay under {retention?.limits.audit.toLocaleString() ?? "20,000"}, phone events under {retention?.limits.events_per_phone.toLocaleString() ?? "10,000"} per phone, and GPS points, check-ins and IP observations under {retention?.limits.history_per_phone.toLocaleString() ?? "2,000,000"} each per phone. The oldest go first, and a phone's newest GPS point is never removed by age.</p>

    <h3 className="delivery-heading">Automatic cleanup</h3>
    <div className="activity-filters">
      <label>Delete saved GPS points older than {ageSelect("Automatic GPS cleanup age", auto.gps_days, n => setAuto({ ...auto, gps_days: n }), "Never (keep everything)")}</label>
      <label>Delete activity older than {ageSelect("Automatic activity cleanup age", auto.activity_days, n => setAuto({ ...auto, activity_days: n }), "Never (keep everything)")}</label>
      <button type="button" className="secondary" disabled={busy || (auto.gps_days === retention?.gps_days && auto.activity_days === retention?.activity_days)} onClick={() => void saveAuto()}>Save automatic cleanup</button>
    </div>

    <h3 className="delivery-heading">Purge now</h3>
    <div className="record-action-grid">
      <div className="record-action record-destructive"><Trash2 size={20} /><h3>Purge activity log</h3>
        <div className="activity-filters">
          <label>Phone<select aria-label="Phone whose activity to purge" value={activity.device} onChange={e => { setActivity({ ...activity, device: e.target.value }); setConfirm(""); }}>
            <option value="">All phones</option>{enrolled.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select></label>
          <label>Remove {ageSelect("Activity age to purge", activity.days, n => { setActivity({ ...activity, days: n }); setConfirm(""); }, "Everything")}</label>
          <label>Include<select aria-label="Activity kinds to purge" value={activity.scope} onChange={e => { setActivity({ ...activity, scope: e.target.value }); setConfirm(""); }}>
            <option value="all">Administrator entries and phone events</option><option value="admin">Administrator entries only</option><option value="phone">Phone events only</option>
          </select></label>
        </div>
        <p>Removes {ageText(activity.days)} from the activity list. The purge itself is recorded. Events still queued on a phone cannot bring purged entries back.</p>
        {confirmRow("activity", "Purge activity…")}
      </div>
      <div className="record-action record-destructive"><Crosshair size={20} /><h3>Purge saved GPS</h3>
        {phones.length ? <>
          <div className="activity-filters">
            <label>Phone<select aria-label="Phone whose GPS to purge" value={gpsTarget?.id ?? "all"} onChange={e => { setGps({ ...gps, device: e.target.value }); setConfirm(""); }}>
              <option value="all">All phones</option>
              {enrolled.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select></label>
            <label>Remove {ageSelect("GPS age to purge", gps.days, n => { setGps({ ...gps, days: n }); setConfirm(""); }, "Everything")}</label>
          </div>
          <p>Removes {ageText(gps.days)} of saved GPS points for <strong>{gpsTarget?.name ?? "all phones"}</strong>. {gps.days ? "Each phone’s newest point is kept, and its offline backlog can still upload." : "Pairing is kept and earlier queued fixes are discarded."}</p>
          {confirmRow("gps", "Purge GPS…")}
        </> : <p>Pair a phone to manage its saved GPS.</p>}
      </div>
    </div>
    <p className="fine"><TriangleAlert size={13} /> Purges cannot be undone. Photos, check-ins and IP observations are not touched here; use <strong>Pairing &amp; history</strong> to erase everything for a phone.</p>
  </section>;
}
