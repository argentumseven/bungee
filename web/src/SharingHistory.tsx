import { categories, contextLine, phoneKinds, type Detail } from "./activityText";
import { RecordDates, useRecordHistory } from "./RecordDates";

type Event = { id: string; sequence: number; kind: string; category: string; label: string; at: number | null; recorded_at: number; received_at: number; profile_name: string | null; detail?: Detail };
const date = (at: number) => new Date(at * 1000).toLocaleString();

export function SharingHistory({ deviceId }: { deviceId: string }) {
  const { page, error, before, navigate, apply, refresh, filtered } = useRecordHistory<Event>(
    `/devices/${encodeURIComponent(deviceId)}/sharing-history`, 15000
  );
  return <section className="panel care-card sharing-history" aria-label="Sharing start and stop history">
    <div className="panel-heading"><h2>Sharing start / stop history</h2><button type="button" className="secondary" onClick={refresh}>Refresh sharing history</button></div>
    <p className="fine">Manual actions, crashes, errors and Android stops are recorded separately. Events from a stopped or offline phone arrive after its next connection. Filter by event time. If the exact time is unknown, the filter uses the time the phone recorded it.</p>
    <RecordDates onApply={apply} />
    {error && <p className="error" role="alert">{error}</p>}
    {!page && !error && <p role="status">Loading sharing history…</p>}
    {page && page.events.length === 0 && <p>{filtered ? "No sharing events in this date range." : "No sharing events have been reported in this view."}</p>}
    {!!page?.dropped && <p className="notice">The phone reports {page.dropped} unacknowledged history events removed when its local queue filled. A server copy may exist if only its acknowledgement was lost.</p>}
    <ol className="sharing-event-list">{page?.events.map(event => <li key={event.sequence} className={`sharing-event sharing-event-${event.category}`}>
      <div><strong>{phoneKinds[event.kind] || "Sharing event"}</strong><span className="role-badge">{categories[event.category] || "Unknown"}</span>{event.profile_name && <span>{event.profile_name}</span>}</div>
      <p>{event.label}</p>
      {contextLine(event.detail) && <p className="fine">{contextLine(event.detail)}</p>}
      <p className="fine">{event.at === null ? `${event.kind === "stopped" ? "Stop time" : "Time"} unknown · detected on phone ${date(event.recorded_at)}` : date(event.at)} · received by server {date(event.received_at)}</p>
    </li>)}</ol>
    <div className="history-pagination">{before && <button type="button" className="secondary" onClick={() => navigate(null)}>Latest sharing events</button>}{page?.next_before && <button type="button" className="secondary" onClick={() => navigate(page.next_before)}>Older sharing events</button>}</div>
    <p className="fine">No manual stop is inferred from losing contact. Unknown means the phone could not establish the cause or exact time. A manual event does not identify who used the phone.</p>
  </section>;
}
