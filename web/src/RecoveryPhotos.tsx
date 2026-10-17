import { useEffect, useState } from "react";
import { Camera, RefreshCw, Trash2 } from "lucide-react";
import { api } from "./api";

type Photo = { id: string; captured_at: number; received_at: number; failed_attempts: number; reason: "failed_unlock" | "local_test" };
type Album = { photos: Photo[]; next_before: number | null };
export function RecoveryPhotos({ deviceId }: { deviceId: string }) {
  const [open, setOpen] = useState(false), [before, setBefore] = useState<number | null>(null);
  const [album, setAlbum] = useState<Album | null>(null), [reload, setReload] = useState(0);
  const [error, setError] = useState(""), [confirm, setConfirm] = useState(false), [busy, setBusy] = useState(false);
  const path = `/devices/${encodeURIComponent(deviceId)}/photos`;
  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    setAlbum(null); setError("");
    api<Album>(path + (before ? `?before=${before}` : ""), { signal: abort.signal })
      .then(setAlbum).catch(e => { if (!abort.signal.aborted) setError(e.message); });
    return () => abort.abort();
  }, [path, open, before, reload]);
  async function erase() {
    setBusy(true); setError("");
    try {
      await api(path, { method: "DELETE" });
      setAlbum({ photos: [], next_before: null }); setBefore(null); setConfirm(false); setReload(n => n + 1);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <section className="panel care-card recovery-photos">
    <div className="panel-heading"><h2><Camera size={18} />Recovery photos</h2>
      <button type="button" className="text-button" aria-expanded={open} onClick={() => setOpen(v => !v)}>{open ? "Hide saved photos" : "View saved photos"}</button>
    </div>
    <p className="fine">Enable theft photos on the phone before it is lost. While ready, three new failed PIN/password entries trigger one front-camera attempt. Android camera restrictions still apply.</p>
    {open && <>
      <div className="photo-tools"><button type="button" className="text-button" onClick={() => setReload(n => n + 1)}><RefreshCw size={14} /> Refresh photos</button>
        <button type="button" className="danger-button" onClick={() => setConfirm(true)} disabled={busy}><Trash2 size={14} /> Erase all recovery photos</button></div>
      {confirm && <div className="notice photo-confirm"><p>Erase all saved photos for this phone? Earlier queued photos will also be refused. Captures made after the phone learns of this erasure can still arrive while locally armed.</p>
        <button type="button" className="danger-button" disabled={busy} onClick={() => void erase()}>Confirm photo erasure</button>
        <button type="button" className="text-button" disabled={busy} onClick={() => setConfirm(false)}>Keep photos</button></div>}
      {error && <p className="error" role="alert">{error}</p>}
      {!album && !error && <p className="fine">Loading saved photos…</p>}
      {album && !album.photos.length && <p className="fine">No saved photos in this view.</p>}
      <div className="photo-grid">{album?.photos.map(photo => <figure key={photo.id}>
        <a href={`/api${path}/${encodeURIComponent(photo.id)}`} target="_blank" rel="noopener noreferrer">
          <img src={`/api${path}/${encodeURIComponent(photo.id)}`} loading="lazy" alt={photo.reason === "local_test" ? "Labelled local camera test" : `Recovery capture after ${photo.failed_attempts} failed credential entries`} />
        </a>
        <figcaption><strong>{photo.reason === "local_test" ? "Local camera test" : `${photo.failed_attempts} failed credential entries`}</strong>
          <span>Captured {new Date(photo.captured_at * 1000).toLocaleString()}</span><span>Received {new Date(photo.received_at * 1000).toLocaleString()}</span></figcaption>
      </figure>)}</div>
      <div className="photo-pagination">{before && <button type="button" className="text-button" onClick={() => setBefore(null)}>Newest photos</button>}
        {album?.next_before && <button type="button" className="text-button" onClick={() => setBefore(album.next_before)}>Older photos</button>}</div>
      <p className="fine">Photos stay on your server until erased or the phone is revoked. Images load only from this server and require your session. Use encrypted host storage and backups.</p>
    </>}
  </section>;
}
