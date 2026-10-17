import { useState } from "react";
import { Fingerprint, LockKeyhole, MessageSquare } from "lucide-react";

/** Dashboard illustration; Android determines the actual notification layout. */
export function RecoveryMessagePreview({ message, lost = false }: { message: string; lost?: boolean }) {
  const [placement, setPlacement] = useState<"lock" | "banner">("lock");
  return (
    <figure className="recovery-preview" aria-label="Illustrative recovery notification preview">
      <figcaption>Phone preview</figcaption>
      <div className="preview-placement" role="group" aria-label="Preview placement">
        <button type="button" aria-pressed={placement === "lock"} onClick={() => setPlacement("lock")}>
          Lock screen
        </button>
        <button type="button" aria-pressed={placement === "banner"} onClick={() => setPlacement("banner")}>
          Heads-up
        </button>
      </div>
      <div className={`preview-phone ${placement}`}>
        <div className="preview-status"><LockKeyhole size={12} /><span>Notification preview</span></div>
        {placement === "lock" && <div className="preview-clock" aria-hidden="true">9:41<span>Your lock screen</span></div>}
        <div className="preview-notification">
          <div className="preview-app"><img src="/bungee-mark.png" width="23" height="23" alt="" /><strong>Bungee</strong><span>now</span></div>
          <div className="preview-notification-title"><MessageSquare size={14} />{lost ? "Lost phone · contact the household" : "A message from your household"}</div>
          <div className="preview-notification-body">{message.trim() ? message : "Your recovery message appears here."}</div>
        </div>
        {placement === "banner" && <div className="preview-home" aria-hidden="true"><span /><span /><span /><span /></div>}
        <div className="preview-unlock"><Fingerprint size={23} /><span>{placement === "lock" ? "Unlock as usual" : "Your app stays open"}</span></div>
      </div>
      <p className="preview-caveat">Illustration. Appearance depends on Android and notification settings. Messages use notifications and leave credential entry accessible.</p>
    </figure>
  );
}
