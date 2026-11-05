import { useEffect, useState } from "react";
import { Camera, RefreshCw, Trash2 } from "lucide-react";
import { api } from "./api";

type Photo = { id: string; device_id?: string; source_device_id?: string; profile_name?: string; device_name?: string; captured_at: number; received_at: number; failed_attempts: number; reason: "failed_unlock" | "local_test" };
type Album = { photos: Photo[]; next_before: number | null };
export function RecoveryPhotos({ deviceId }: { deviceId?: string }) {
  const [open, setOpen] = useState(true), [before, setBefore] = useState<number | null>(null);
  const [album, setAlbum] = useState<Album | null>(null), [reload, setReload] = useState(0);
  const [error, setError] = useState(""), [confirm, setConfirm] = useState(false), [busy, setBusy] = useState(false);
  const path = deviceId ? `/devices/${encodeURIComponent(deviceId)}/photos` : "/photos";
  const imagePath = (photo: Photo) => `/devices/${encodeURIComponent(photo.source_device_id || deviceId || photo.device_id || "")}/photos/${encodeURIComponent(photo.id)}`;
  useEffect(()=>{setAlbum(null);},[path,open,before]);
  useEffect(()=>{setBefore(null);},[path]);
  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    setError("");
    api<Album>(path + (before ? `?before=${before}` : ""), { signal: abort.signal })
      .then(setAlbum).catch(e => { if (!abort.signal.aborted) setError(e.message); });
    const timer = window.setInterval(() => setReload(n => n + 1), 10000);
    return () => { abort.abort(); window.clearInterval(timer); };
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
<p className="fine">Armed means waiting for a capture trigger, not that a picture was taken. Pending pictures are held only in phone memory, sent here and removed after acknowledgment. A stopped process loses unsent pictures. Android may refuse capture or failed-PIN callbacks.</p>
    {open && <>
      <div className="photo-tools"><button type="button" className="text-button" onClick={() => setReload(n => n + 1)}><RefreshCw size={14} /> Refresh photos</button>
        <button type="button" className="danger-button" onClick={() => setConfirm(true)} disabled={busy}><Trash2 size={14} /> Erase all recovery photos</button></div>
      {confirm && <div className="notice photo-confirm"><p>Erase all saved photos in this view? Earlier queued photos will also be refused. Captures made after the phone learns of this erasure can still arrive while locally armed.</p>
        <button type="button" className="danger-button" disabled={busy} onClick={() => void erase()}>Confirm photo erasure</button>
        <button type="button" className="text-button" disabled={busy} onClick={() => setConfirm(false)}>Keep photos</button></div>}
      {error && <p className="error" role="alert">{error}</p>}
      {!album && !error && <p className="fine">Loading saved photos…</p>}
      {album && !album.photos.length && <p className="fine">No saved photos in this view.</p>}
      <div className="photo-grid">{album?.photos.map(photo => <figure key={`${photo.source_device_id||deviceId||photo.device_id}-${photo.id}`}>
        <a href={`/api${imagePath(photo)}`} target="_blank" rel="noopener noreferrer">
          <img src={`/api${imagePath(photo)}`} loading="lazy" alt={photo.reason === "local_test" ? "Labelled local camera test" : `Recovery capture after ${photo.failed_attempts} failed credential entries`} />
        </a>
        <figcaption>{photo.device_name && <strong>{photo.device_name}</strong>}{photo.profile_name && <span>{photo.profile_name}</span>}<strong>{photo.reason === "local_test" ? "Local camera test" : `${photo.failed_attempts} failed credential entries`}</strong>
          <span>Captured {new Date(photo.captured_at * 1000).toLocaleString()}</span><span>Received {new Date(photo.received_at * 1000).toLocaleString()}</span><button type="button" className="danger-button" disabled={busy} onClick={async () => {
            if (!window.confirm("Erase this recovery photo? It cannot be restored by a retry from the phone.")) return;
            setBusy(true);
            try { await api(imagePath(photo), {method:"DELETE"}); setReload(n => n + 1); }
            catch(e) { setError((e as Error).message); }
            finally { setBusy(false); }
          }}>Erase this photo</button></figcaption>
      </figure>)}</div>
      <div className="photo-pagination">{before && <button type="button" className="text-button" onClick={() => setBefore(null)}>Newest photos</button>}
        {album?.next_before && <button type="button" className="text-button" onClick={() => setBefore(album.next_before)}>Older photos</button>}</div>
      <p className="fine">Photos stay on your server until erased or the phone is revoked. Images load only from this server and require your session. Use encrypted host storage and backups.</p>
    </>}
  </section>;
}
