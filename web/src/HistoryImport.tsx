import {useEffect,useRef,useState} from "react";
import {api} from "./api";
import {parseGpsCsv,type ImportedPoint} from "./gpsCsv";
export function HistoryImport({deviceId,onImported}:{deviceId:string;onImported:(from:number,to:number)=>void}){
 const [rows,setRows]=useState<ImportedPoint[]>([]),[message,setMessage]=useState(""),[busy,setBusy]=useState(false);
 const cancel=useRef(false);
 useEffect(()=>{cancel.current=false;return()=>{cancel.current=true}},[deviceId]);
 const bounds=rows.reduce((a,p)=>[Math.min(a[0],p.observed_at),Math.max(a[1],p.observed_at)],[Infinity,0]);
 return <details className="history-import"><summary>Restore GPS history from CSV</summary><p>Restore an exported Bungee GPS CSV into this saved device. Original times and uncertainty are preserved. Existing timestamps are skipped, and restored rows are labelled as imports.</p>
 <input type="file" accept=".csv,text/csv" aria-label="GPS CSV to restore" disabled={busy} onChange={async e=>{setRows([]);setMessage("");try{const file=e.target.files?.[0];if(!file)return;if(file.size>25*1024**2)throw Error("Choose a CSV smaller than 25 MiB.");setRows(parseGpsCsv(await file.text()))}catch(error){setMessage((error as Error).message)}}}/>
 {rows.length>0&&<p>{rows.length.toLocaleString()} rows · {new Date(bounds[0]*1000).toLocaleString()} to {new Date(bounds[1]*1000).toLocaleString()}</p>}
 {busy?<button type="button" className="secondary" onClick={()=>{cancel.current=true}}>Stop import</button>:rows.length>0&&<button type="button" className="secondary" onClick={async()=>{setBusy(true);cancel.current=false;let added=0,skipped=0;try{for(let i=0;i<rows.length&&!cancel.current;i+=75){const r=await api<{added:number;skipped:number}>(`/devices/${deviceId}/history/import`,{method:"POST",body:JSON.stringify({records:rows.slice(i,i+75)})});added+=r.added;skipped+=r.skipped;setMessage(`${added} restored · ${skipped} existing rows skipped`)}if(!cancel.current){onImported(bounds[0],bounds[1]);setRows([])}else setMessage(`${added} restored · import stopped. Reimporting this CSV safely skips existing rows.`)}catch(error){setMessage(`${(error as Error).message} · ${added} rows restored. You can retry the same CSV safely.`)}finally{setBusy(false)}}}>Restore these rows</button>}
 {message&&<p role="status">{message}</p>}
 </details>;
}
