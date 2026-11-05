import { useState } from "react";
import QRCode from "qrcode";
import { api } from "./api";

export type ProfileAgent = {
  id: string;
  name: string;
  enrolled: boolean;
  revoked: boolean;
  last_contact?: number | null;
  binding_released?: boolean;
  enrollment_state?: string;
  capabilities: string[];
  management?: null | {
    foreground_user?: boolean | null;
    screen_locked?: boolean;
    camera?: null | {
      armed: boolean;
      status: string;
      pending: number;
      failed_in_row?: number;
      reported_at: number;
    };
  };
};

export function ProfileCompanions({
  deviceId,
  deviceName,
  profiles,
}: {
  deviceId: string;
  deviceName: string;
  profiles: ProfileAgent[];
}) {
  const [name, setName] = useState(""),
    [key, setKey] = useState("");
  const [invitation, setInvitation] = useState(""),
    [qr, setQr] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [messages, setMessages] = useState<Record<string, string>>({});
  const [reconnect, setReconnect] = useState<ProfileAgent | null>(null),
    [setupOpen, setSetupOpen] = useState(false);
  async function disconnect(profile: ProfileAgent) {
    if (
      !window.confirm(
        `Disconnect ${profile.name}? Saved photos stay with ${deviceName}; its main installation keeps working.`,
      )
    )
      return;
    setBusy(true);
    setError("");
    try {
      await api(`/devices/${profile.id}/disconnect`, {
        method: "POST",
        body: "{}",
      });
      setNotice(`${profile.name} disconnected. Saved photos were kept.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function command(profile: ProfileAgent, kind: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api(`/devices/${profile.id}/commands`, {
        method: "POST",
        body: JSON.stringify({
          kind,
          ...(kind === "message"
            ? { message: messages[profile.id] || "" }
            : {}),
        }),
      });
      setNotice(
        `Request queued for ${profile.name}. Delivery requires that profile’s connection.`,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="panel care-card profile-companions"
      aria-label="Android profiles"
    >
      <div className="panel-heading">
        <h2>Android profiles</h2>
        <span>{profiles.filter((p) => !p.revoked).length}/8 linked</span>
      </div>
      <p>
        Phone status, GPS, battery, network history, sound and flash come from{" "}
        {deviceName}’s main installation. Linked companions handle photos and
        messages inside their own Android user.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {profiles.map((profile) => {
        const camera = profile.management?.camera;
        const recent =
          !!profile.last_contact &&
          Date.now() / 1000 - profile.last_contact < 90;
        return (
          <article className="profile-agent" key={profile.id}>
            <div className="panel-heading">
              <h3>{profile.name}</h3>
              <span>
                {profile.revoked
                  ? "Disconnected"
                  : !profile.enrolled
                    ? profile.enrollment_state === "expired"
                      ? "Invitation expired"
                      : "Awaiting pairing"
                    : recent
                      ? "Connected"
                      : "No recent contact"}
              </span>
            </div>
            <p className="fine">
              {profile.management?.foreground_user && recent
                ? "Foreground user at last report. "
                : ""}
              {camera?.status ||
                "Camera not reported yet. Enable protection locally inside this profile."}
            </p>
            {camera && (
              <p className="fine">
                {camera.failed_in_row || 0}/3 new failed PIN entries ·{" "}
                {camera.pending} pending photos · reported{" "}
                {new Date(camera.reported_at * 1000).toLocaleString()}
              </p>
            )}
            {profile.enrolled && !profile.revoked && (
              <>
                <label htmlFor={`profile-message-${profile.id}`}>
                  Message for {profile.name}
                </label>
                <textarea
                  id={`profile-message-${profile.id}`}
                  maxLength={240}
                  rows={2}
                  value={messages[profile.id] || ""}
                  onChange={(e) =>
                    setMessages({ ...messages, [profile.id]: e.target.value })
                  }
                />
                <div className="profile-actions">
                  <button
                    type="button"
                    className="secondary"
                    disabled={
                      busy ||
                      !messages[profile.id]?.trim() ||
                      !profile.capabilities.includes("message")
                    }
                    onClick={() => void command(profile, "message")}
                  >
                    Send to {profile.name}
                  </button>
                  <button
                    type="button"
                    className="text-button"
                    disabled={
                      busy || !profile.capabilities.includes("clear_message")
                    }
                    onClick={() => void command(profile, "clear_message")}
                  >
                    Clear profile message
                  </button>
                  <button
                    type="button"
                    className="danger-button"
                    disabled={busy}
                    onClick={() => void disconnect(profile)}
                  >
                    Disconnect profile
                  </button>
                </div>
              </>
            )}
            {!profile.enrolled && !profile.revoked && (
              <button
                type="button"
                className="danger-button"
                disabled={busy}
                onClick={() => void disconnect(profile)}
              >
                Cancel profile invitation
              </button>
            )}
            {profile.revoked && (
              <div className="profile-actions">
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => {
                    setReconnect(profile);
                    setName(profile.name);
                    setKey("");
                    setInvitation("");
                    setQr("");
                    setSetupOpen(true);
                  }}
                >
                  Reconnect profile · keep photos
                </button>
                {profile.binding_released && (
                  <button
                    type="button"
                    className="danger-button"
                    disabled={busy}
                    onClick={async () => {
                      if (
                        !window.confirm(
                          `Remove ${profile.name} and its saved photos? ${deviceName} and its other profiles stay intact.`,
                        )
                      )
                        return;
                      setBusy(true);
                      setError("");
                      try {
                        await api(`/devices/${profile.id}/archive`, {
                          method: "DELETE",
                        });
                        setNotice(
                          `${profile.name} and its saved photos were removed.`,
                        );
                      } catch (e) {
                        setError((e as Error).message);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    Remove profile &amp; photos
                  </button>
                )}
              </div>
            )}
          </article>
        );
      })}
      <details
        className="profile-setup"
        open={setupOpen}
        onToggle={(e) => setSetupOpen(e.currentTarget.open)}
      >
        <summary>
          {reconnect
            ? `Reconnect ${reconnect.name}`
            : "Add a profile companion"}
        </summary>
        <p className="fine">
          Use Bungee 1.1.18 or newer in the other Android user. Copy its phone
          public key here, create the invitation, then scan it inside that user.
          Approve profile messages and arm theft photos there. Protection begins
          after that user’s first unlock and stops when its session ends.
        </p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            setInvitation("");
            setQr("");
            try {
              const result = await api(
                reconnect
                  ? `/devices/${reconnect.id}/reconnect`
                  : "/enrollments",
                {
                  method: "POST",
                  body: JSON.stringify(
                    reconnect
                      ? { wg_public_key: key.trim() }
                      : {
                          name: name.trim(),
                          wg_public_key: key.trim(),
                          primary_device_id: deviceId,
                        },
                  ),
                },
              );
              const text = JSON.stringify(result);
              setInvitation(text);
              setQr(await QRCode.toDataURL(text, { width: 320, margin: 2 }));
              setNotice("Profile invitation ready. It expires in ten minutes.");
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label htmlFor="profile-name">Profile name</label>
          <input
            id="profile-name"
            value={name}
            maxLength={60}
            required
            disabled={!!reconnect}
            placeholder="Sandbox"
            onChange={(e) => setName(e.target.value)}
          />
          <label htmlFor="profile-key">
            Public key from that profile’s Bungee app
          </label>
          <input
            id="profile-key"
            value={key}
            required
            autoComplete="off"
            onChange={(e) => setKey(e.target.value)}
          />
          <button
            className="primary"
            disabled={
              busy ||
              (!reconnect && profiles.filter((p) => !p.revoked).length >= 8)
            }
          >
            {reconnect
              ? "Create reconnect invitation"
              : "Create profile invitation"}
          </button>
          {reconnect && (
            <button
              type="button"
              className="text-button"
              onClick={() => {
                setReconnect(null);
                setName("");
                setKey("");
                setInvitation("");
                setQr("");
              }}
            >
              Add a different profile instead
            </button>
          )}
        </form>
        {invitation && (
          <div className="profile-invitation">
            {qr && (
              <img
                src={qr}
                alt={`Private pairing invitation for ${name}`}
                width={320}
                height={320}
              />
            )}
            <p className="fine">
              Keep this invitation private. Scan it with Bungee in the named
              profile.
            </p>
            <label htmlFor="profile-invitation">Invitation text</label>
            <textarea
              id="profile-invitation"
              readOnly
              value={invitation}
              rows={4}
            />
            <button
              type="button"
              className="text-button"
              onClick={() => {
                setInvitation("");
                setQr("");
              }}
            >
              Hide invitation
            </button>
          </div>
        )}
      </details>
    </section>
  );
}
