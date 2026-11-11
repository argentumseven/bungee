import { useEffect, useState } from "react";
import { api } from "./api";

type Event = { id: string; sequence: number; kind: string; category: string; label: string; at: number | null; recorded_at: number; received_at: number; profile_name: string | null };
type Page = { events: Event[]; next_before: number | null; dropped?: number };
const date = (at: number) => new Date(at * 1000).toLocaleString();
const categories: Record<string, string> = { manual: "Manual", automatic: "Automatic", system: "Android / system", crash: "Crash", error: "Error", unknown: "Unknown" };
const kinds: Record<string, string> = { started: "Sharing started", stopped: "Sharing stopped", gps_enabled: "GPS enabled", gps_disabled: "GPS disabled", error: "Error", locate_started: "Temporary GPS started", locate_finished: "Temporary GPS finished" };

export function SharingHistory({ deviceId }: { deviceId: string }) {
  const [page, setPage] = useState<Page | null>(null), [before, setBefore] = useState<number | null>(null);
  const [reload, setReload] = useState(0), [error, setError] = useState("");
  useEffect(() => { setBefore(null); setPage(null); }, [deviceId]);
  useEffect(() => {
    const abort = new AbortController();
    let loading = false;
    const load = async () => {
      if (loading) return;
      loading = true;
      try {
        const data = await api<Page>(`/devices/${encodeURIComponent(deviceId)}/sharing-history${before ? `?before=${before}` : ""}`, { signal: abort.signal });
        if (!abort.signal.aborted) { setPage(data); setError(""); }
      } catch (e) { if (!abort.signal.aborted) setError((e as Error).message); }
      finally { loading = false; }
    };
    void load();
    const timer = before ? undefined : window.setInterval(load, 15000);
    return () => { abort.abort(); window.clearInterval(timer); };
  }, [deviceId, before, reload]);
  return <section className="panel care-card sharing-history" aria-label="Sharing start and stop history">
    <div className="panel-heading"><h2>Sharing start / stop history</h2><button type="button" className="text-button" onClick={() => setReload(n => n + 1)}>Refresh sharing history</button></div>
    <p className="fine">Manual actions, crashes, errors and Android stops are recorded separately. Events from a stopped or offline phone arrive after its next connection. Newest received events appear first.</p>
    {error && <p className="error" role="alert">{error}</p>}
    {!page && !error && <p role="status">Loading sharing history…</p>}
    {page && page.events.length === 0 && <p>No sharing events have been reported in this view. Earlier app versions did not record this history.</p>}
    {!!page?.dropped && <p className="notice">The phone reports {page.dropped} unacknowledged history events removed when its local queue filled. A server copy may exist if only its acknowledgement was lost.</p>}
    <ol className="sharing-event-list">{page?.events.map(event => <li key={event.sequence} className={`sharing-event sharing-event-${event.category}`}>
      <div><strong>{kinds[event.kind] || "Sharing event"}</strong><span className="role-badge">{categories[event.category] || "Unknown"}</span>{event.profile_name && <span>{event.profile_name}</span>}</div>
      <p>{event.label}</p>
      <p className="fine">{event.at === null ? `Stop time unknown · detected on phone ${date(event.recorded_at)}` : date(event.at)} · received by server {date(event.received_at)}</p>
    </li>)}</ol>
    <div className="photo-pagination">{before && <button type="button" className="text-button" onClick={() => setBefore(null)}>Latest sharing events</button>}{page?.next_before && <button type="button" className="text-button" onClick={() => setBefore(page.next_before)}>Older sharing events</button>}</div>
    <p className="fine">No manual stop is inferred from losing contact. Unknown means the phone could not establish the cause or exact time. A manual event does not identify who used the phone.</p>
  </section>;
}
