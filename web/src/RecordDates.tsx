import { useEffect, useState } from "react";
import { api } from "./api";

type DateRange = { from?: number; to?: number };
type Page<T> = { events: T[]; next_before: number | null; dropped?: number };

export function RecordDates({ onApply }: { onApply: (range: DateRange) => void }) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [error, setError] = useState("");
  return <form className="record-dates" aria-label="Filter records by date and time" onSubmit={event => {
    event.preventDefault();
    const start = from ? new Date(from).getTime() / 1000 : undefined;
    // A datetime-local input has minute precision. Include the whole final minute.
    const end = to ? new Date(to).getTime() / 1000 + 59 : undefined;
    if (start !== undefined && end !== undefined && start > end) {
      setError("The end of the range must be on or after its start.");
      return;
    }
    setError("");
    onApply({ from: start, to: end });
  }}>
    <label>From (local time)<input type="datetime-local" value={from} onChange={e => setFrom(e.target.value)} /></label>
    <label>To (local time)<input type="datetime-local" value={to} onChange={e => setTo(e.target.value)} /></label>
    <div className="filter-actions">
      <button type="submit" className="secondary">Apply filter</button>
      <button type="button" className="secondary" onClick={() => { setFrom(""); setTo(""); setError(""); onApply({}); }}>Clear filter</button>
    </div>
    {error && <p className="error" role="alert">{error}</p>}
  </form>;
}

export function useRecordHistory<T>(path: string, interval: number) {
  const [page, setPage] = useState<Page<T> | null>(null);
  const [error, setError] = useState("");
  const [range, setRange] = useState<DateRange>({});
  const [before, setBefore] = useState<number | null>(null);
  const [reload, setReload] = useState(0);
  const query = new URLSearchParams();
  if (range.from != null) query.set("from", String(range.from));
  if (range.to != null) query.set("to", String(range.to));
  if (before != null) query.set("before", String(before));
  const request = `${path}${query.size ? `?${query}` : ""}`;

  useEffect(() => {
    const abort = new AbortController();
    let pending = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        const result = await api<Page<T>>(request, { signal: abort.signal });
        if (!abort.signal.aborted) { setPage(result); setError(""); }
      } catch (error) {
        if (!abort.signal.aborted) setError((error as Error).message);
      } finally {
        pending = false;
      }
    };
    void load();
    const timer = before == null ? window.setInterval(load, interval) : undefined;
    return () => { abort.abort(); window.clearInterval(timer); };
  }, [request, before, interval, reload]);

  const navigate = (cursor: number | null) => {
    if (cursor === before) return;
    setPage(null);
    setError("");
    setBefore(cursor);
  };
  const apply = (value: DateRange) => {
    setPage(null);
    setError("");
    setRange(value);
    setBefore(null);
    setReload(n => n + 1);
  };
  const refresh = () => setReload(n => n + 1);
  return { page, error, before, navigate, apply, refresh, filtered: range.from != null || range.to != null };
}
