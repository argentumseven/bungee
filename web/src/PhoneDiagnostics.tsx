import { useEffect, useState } from "react";
import { Activity, Check, CircleAlert, Info } from "lucide-react";
import { api } from "./api";

type Check = { label: string; status: "ok" | "attention" | "info"; detail: string };
type Report = {
  id: string; status: string; created: number; expires: number;
  received_at: number | null; result: string | null; checks: Check[] | null; profile_name: string;
};
export type DiagnosticRequest = Pick<Report, "id" | "expires"> & { phoneId: string; deviceId: string; profileName: string; created: number };

export function PhoneDiagnostics({ deviceId, request }: { deviceId: string; request?: DiagnosticRequest }) {
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    let active = false;
    const load = async () => {
      if (active) return;
      active = true;
      try {
        const data = await api<{ report: Report | null }>(`/devices/${encodeURIComponent(deviceId)}/diagnostics`, { signal: controller.signal });
        if (!controller.signal.aborted) { setReport(data.report); setError(""); }
      } catch (e) {
        if (!controller.signal.aborted) setError((e as Error).message);
      } finally { active = false; }
    };
    void load();
    const timer = setInterval(load, 5000);
    return () => { clearInterval(timer); controller.abort(); };
  }, [deviceId, request]);

  if (!report && !request && !error) return null;
  const displayed = request && report?.id !== request.id && (!report || report.created <= request.created)
    ? { ...request, profile_name: request.profileName, status: request.expires <= Date.now() / 1000 ? "expired" : "pending", received_at: null, result: null, checks: null } : report;
  const attention = displayed?.checks?.filter(check => check.status === "attention").length ?? 0;
  const waiting = displayed && ["pending", "delivered"].includes(displayed.status);
  return <section className="panel care-card diagnostics-report" id="phone-diagnostics" aria-labelledby="diagnostics-heading" tabIndex={-1}>
    <div className="panel-heading">
      <h2 id="diagnostics-heading"><Activity size={18} /> Phone diagnostics</h2>
      {displayed?.checks && <span className={`diagnostics-summary ${attention ? "attention" : "ok"}`}>{attention ? `${attention} ${attention === 1 ? "check needs" : "checks need"} attention` : "No issues flagged"}</span>}
    </div>
    {error && <p className="error" role="alert">{error}</p>}
    {displayed && <div role="status" className="diagnostics-status">
      {waiting ? <p>{displayed.status === "delivered" ? "The phone received the request. Waiting for its report." : `Waiting for ${displayed.profile_name} to connect and run the checks.`} Request expires at {new Date(displayed.expires * 1000).toLocaleTimeString()}.</p>
        : displayed.checks && displayed.received_at ? <p>{displayed.profile_name} reported in at <time dateTime={new Date(displayed.received_at * 1000).toISOString()}>{new Date(displayed.received_at * 1000).toLocaleString()}</time>.</p>
        : <p>{displayed.status === "expired" ? "The request expired before a report came back. Retry when the phone is connected." : displayed.result || "The phone did not return a report."}</p>}
    </div>}
    {!!displayed?.checks?.length && <ul className="diagnostics-checks">
      {displayed.checks.map((check, index) => <li key={`${check.label}-${index}`} className={check.status}>
        {check.status === "ok" ? <Check size={17} aria-hidden="true" /> : check.status === "attention" ? <CircleAlert size={17} aria-hidden="true" /> : <Info size={17} aria-hidden="true" />}
        <div><strong>{check.label}<span className="sr-only"> {check.status === "ok" ? "Passed" : check.status === "attention" ? "Needs attention" : "Information"}</span></strong><p>{check.detail}</p></div>
      </li>)}
    </ul>}
  </section>;
}
