import { useEffect, useState } from "react";
import { Camera, RefreshCw, Trash2 } from "lucide-react";
import { api } from "./api";

type Photo = {
  id: string; captured_at: number; received_at: number; failed_attempts: number;
  reason?: string; device_id?: string; device_name?: string;
  source_device_id?: string; profile_name?: string;
};
const photoLabel = (photo: Photo) => photo.reason === "remote_manual" ? "Manually requested picture" : photo.reason === "local_test" ? "Local camera test" : `${photo.failed_attempts} failed credential entries`;
type Album = { photos: Photo[]; next_before: number | null };

export function RecoveryPhotos({ deviceId }: { deviceId?: string }) {
  const [before, setBefore] = useState<number | null>(null);
  const [album, setAlbum] = useState<Album | null>(null);
  const [reload, setReload] = useState(0);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const path = deviceId ? `/devices/${encodeURIComponent(deviceId)}/photos` : "/photos";
  const imagePath = (photo: Photo) => `/devices/${encodeURIComponent(photo.source_device_id || deviceId || photo.device_id || "")}/photos/${encodeURIComponent(photo.id)}`;

  useEffect(() => {
    const abort = new AbortController();
    let loading = false;
    const load = async () => {
      if (loading) return;
      loading = true;
      try {
        const result = await api<Album>(path + (before ? `?before=${before}` : ""), { signal: abort.signal, cache: "no-store" });
        if (!abort.signal.aborted) { setAlbum(result); setError(""); }
      } catch (e) {
        if (!abort.signal.aborted) setError((e as Error).message);
      } finally { loading = false; }
    };
    void load();
    const timer = before == null ? window.setInterval(load, 10000) : undefined;
    return () => { abort.abort(); window.clearInterval(timer); };
  }, [path, before, reload]);

  function paginate(cursor: number | null) {
    setAlbum(null);
    setError("");
    setBefore(cursor);
  }
  async function erase() {
    setBusy(true);
    setError("");
    try {
      await api(path, { method: "DELETE" });
      setAlbum({ photos: [], next_before: null });
      setBefore(null);
      setConfirm(false);
      setReload(n => n + 1);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <section className="panel care-card recovery-photos" aria-label="Recovery photo gallery">
    <div className="panel-heading">
      <h2><Camera size={18} /> Recovery photos</h2>
      <div className="photo-tools">
        <button type="button" className="secondary" onClick={() => setReload(n => n + 1)}><RefreshCw size={15} /> Refresh photos</button>
        <button type="button" className="danger-button" onClick={() => setConfirm(true)} disabled={busy}><Trash2 size={15} /> Erase all recovery photos</button>
      </div>
    </div>
    {confirm && <div className="notice photo-confirm">
      <p>Erase all saved photos in this view? The server also discards earlier queued photos. New captures can arrive while protection is armed.</p>
      <div className="photo-tools">
        <button type="button" className="danger-button" disabled={busy} onClick={() => void erase()}>Confirm photo erasure</button>
        <button type="button" className="secondary" disabled={busy} onClick={() => setConfirm(false)}>Keep photos</button>
      </div>
    </div>}
    {error && <p className="error" role="alert">{error}</p>}
    {!album && !error && <p className="gallery-feedback" role="status">Loading saved photos…</p>}
    {album?.photos.length === 0 && <p className="gallery-feedback">No saved photos in this view.</p>}
    {!!album?.photos.length && <div className="photo-grid">{album.photos.map((photo, index) => <figure key={`${photo.source_device_id || deviceId || photo.device_id}-${photo.id}`}>
      <a href={`/api${imagePath(photo)}`} target="_blank" rel="noopener noreferrer">
        <img src={`/api${imagePath(photo)}`} loading={index < 4 ? "eager" : "lazy"} alt={photo.reason === "local_test" ? "Labelled local camera test" : photoLabel(photo)} />
      </a>
      <figcaption>
        <strong>{photoLabel(photo)}</strong>
        {(photo.device_name || photo.profile_name) && <span>{[photo.device_name, photo.profile_name].filter(Boolean).join(" · ")}</span>}
        <span>Captured {new Date(photo.captured_at * 1000).toLocaleString()}</span>
        <span>Received {new Date(photo.received_at * 1000).toLocaleString()}</span>
        <button type="button" className="danger-button" disabled={busy} onClick={async () => {
          if (!window.confirm("Permanently erase this recovery photo?")) return;
          setBusy(true);
          try { await api(imagePath(photo), { method: "DELETE" }); setReload(n => n + 1); }
          catch (e) { setError((e as Error).message); }
          finally { setBusy(false); }
        }}>Erase this photo</button>
      </figcaption>
    </figure>)}</div>}
    {(before != null || album?.next_before != null) && <div className="history-pagination">
      {before != null && <button type="button" className="secondary" onClick={() => paginate(null)}>Newest photos</button>}
      {album?.next_before != null && <button type="button" className="secondary" onClick={() => paginate(album.next_before)}>Older photos</button>}
    </div>}
  </section>;
}
