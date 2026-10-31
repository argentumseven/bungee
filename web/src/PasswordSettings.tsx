import { useState, type FormEvent } from "react";
import { KeyRound } from "lucide-react";
import { api } from "./api";

export function PasswordSettings({ onChanged }: { onChanged: () => void }) {
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (password !== confirm) { setError("New passwords do not match."); return; }
    if ([...password].length < 16 || new TextEncoder().encode(password).length > 1024) {
      setError("Use at least 16 characters and at most 1024 UTF-8 bytes."); return;
    }
    setBusy(true);
    try {
      await api("/password", { method: "POST", body: JSON.stringify({ current_password: current, new_password: password }) });
      setCurrent(""); setPassword(""); setConfirm("");
      onChanged();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <section className="panel settings-card">
    <KeyRound size={26} />
    <h2>Administrator password</h2>
    <p>Choose a unique passphrase of at least 16 characters. Changing it signs out every browser, including this one.</p>
    <form onSubmit={submit}>
      <label htmlFor="current-admin-password">Current password</label>
      <input id="current-admin-password" type="password" autoComplete="current-password" required value={current} onChange={e => setCurrent(e.target.value)} />
      <label htmlFor="new-admin-password">New password</label>
      <input id="new-admin-password" type="password" autoComplete="new-password" required value={password} onChange={e => setPassword(e.target.value)} />
      <label htmlFor="confirm-admin-password">Confirm new password</label>
      <input id="confirm-admin-password" type="password" autoComplete="new-password" required value={confirm} onChange={e => setConfirm(e.target.value)} />
      {error && <div className="error" role="alert">{error}</div>}
      <button className="primary" disabled={busy}>{busy ? "Changing password…" : "Change password"}</button>
    </form>
  </section>;
}
