import {useEffect,useState} from "react";
import {Download,HardDrive,Map,RefreshCw,Trash2} from "lucide-react";
import {api} from "./api";
type Region={id:string;name:string;group:string;estimated_bytes:number;bytes?:number;planned_bytes?:number};
type State={enabled:boolean;message?:string;catalog?:Region[];installed?:Region[];legacy_map_bytes?:number;map_limit_bytes?:number;job?:{id:string;state:string;message:string};last_plan?:{id:string;planned_bytes:number;regions:Region[]};disk?:{total_bytes:number;free_bytes:number;available_bytes:number;reserve_bytes:number;swap_total_bytes:number;swap_used_bytes:number;swap_growth_reserve_bytes:number;backing_free_bytes:number;note:string}};
const size=(n:number)=>n>=1024**3?`${(n/1024**3).toFixed(2)} GiB`:`${Math.ceil(n/1024**2)} MiB`;
export function MapManager(){
 const [state,setState]=useState<State|null>(null),[error,setError]=useState(""),[loadError,setLoadError]=useState("");
 const [chosen,setChosen]=useState<string[]>([]),[search,setSearch]=useState(""),[group,setGroup]=useState("United States");
 const [sending,setSending]=useState(false),[queued,setQueued]=useState<string|null>(null);
 const load=()=>api<State>("/maps/manage").then(value=>{setState(value);setLoadError("");setChosen(old=>old.filter(id=>!value.installed?.some(item=>item.id===id)));if(value.job?.id===queued&&!["running","queued"].includes(value.job.state))setQueued(null);}).catch(e=>setLoadError(e.message));
 useEffect(()=>{void load();const timer=window.setInterval(load,3000);return()=>window.clearInterval(timer);},[queued]);
 const busy=sending||!!queued||["running","queued"].includes(state?.job?.state??"");
 const installed=new Set(state?.installed?.map(item=>item.id));
 const catalog=state?.catalog??[],groups=Array.from(new Set(catalog.map(item=>item.group)));
 const rough=catalog.filter(item=>chosen.includes(item.id)).reduce((sum,item)=>sum+item.estimated_bytes,0);
 const plan=state?.last_plan,plannedIds=plan?.regions.map(item=>item.id).sort().join(",");
 const currentPlan=!!plan&&plannedIds===chosen.slice().sort().join(",");
 async function job(action:string,regions:string[],planId?:string){
  setSending(true);setError("");
  try{const result=await api<{id:string}>("/maps/jobs",{method:"POST",body:JSON.stringify({action,regions,...(planId?{plan_id:planId}:{})})});setQueued(result.id);}
  catch(e){setError((e as Error).message);}finally{setSending(false);}
 }
 return <section className="panel map-manager" id="map-downloads">
  <div className="panel-heading"><h2><Map size={18}/>Maps &amp; storage</h2><button className="text-button" type="button" onClick={()=>void load()} aria-label="Refresh map status"><RefreshCw size={16}/></button></div>
  <p>Download regional street maps once; every tracking view uses them locally. Up to 24 regional archives can be installed. The world overview is included. Nearby street labels are approximate; these archives do not provide a complete postal-address database.</p>
  {loadError&&<p className="error" role="alert">{loadError}</p>}
  {error&&<p className="error" role="alert">{error}</p>}
  {!state&&!loadError&&<p role="status">Loading maps and capacity…</p>}
  {(loadError||state?.enabled===false)&&<div className="notice"><p>On the server, from its Bungee checkout, run the map repair. It preserves installed maps, pairing and history.</p><code>python3 scripts/bungee-host.py repair-maps</code><p>Then refresh this panel.</p></div>}
  {state&&!state.enabled&&<p className="notice">{state.message}</p>}
  {state?.disk&&<><div className="map-capacity"><div><HardDrive size={18}/><strong>{size(state.disk.available_bytes)}</strong><span>available for new maps after reserves</span></div><div><strong>{size(state.disk.free_bytes)} / {size(state.disk.total_bytes)}</strong><span>free / total Bungee storage</span></div><div><strong>{size(state.disk.reserve_bytes)}</strong><span>storage safety reserve</span></div><div><strong>{size(state.disk.swap_used_bytes)} / {size(state.disk.swap_total_bytes)}</strong><span>swap used / configured; growth headroom {size(state.disk.swap_growth_reserve_bytes)}</span></div><div><strong>{size(state.disk.backing_free_bytes)}</strong><span>free on the host backing filesystem</span></div></div><p className="fine">{state.disk.note} Space is checked before and during downloads. Existing maps stay available if a download fails. Installed street maps are limited to 25 GB in total.</p></>}
  <h3>Installed maps</h3>
  <ul className="installed-maps"><li><span><strong>World overview</strong><small>Included · countries and major places, no street detail</small></span><span>7.7 MB</span></li>
   {!!state?.legacy_map_bytes&&<li><span><strong>Imported street-map archive</strong><small>Existing dataset preserved</small></span><span>{size(state.legacy_map_bytes)}</span></li>}
   {state?.installed?.map(item=><li key={item.id}><span><strong>{item.name}</strong><small>{item.group}</small></span><span>{size(item.bytes??0)}</span><button className="text-button danger-text" type="button" disabled={busy} onClick={()=>{if(window.confirm(`Remove the downloaded ${item.name} map? Phone history stays saved.`))void job("remove",[item.id]);}}><Trash2 size={14}/>Remove</button></li>)}
  </ul>
  {state?.enabled&&<><h3>Add regional street maps</h3><div className="map-picker-filters"><label>Region group<select value={group} onChange={e=>setGroup(e.target.value)}><option value="">All regions</option>{groups.map(item=><option key={item}>{item}</option>)}</select></label><label>Find a region<input type="search" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Country or US region"/></label></div>
   <div className="map-checklist">{catalog.filter(item=>(!group||item.group===group)&&(!search||`${item.name} ${item.group}`.toLowerCase().includes(search.toLowerCase()))).map(item=><label key={item.id}><input type="checkbox" checked={chosen.includes(item.id)||installed.has(item.id)} disabled={busy||installed.has(item.id)||(!chosen.includes(item.id)&&chosen.length+installed.size>=24)} onChange={e=>setChosen(old=>e.target.checked?[...old,item.id]:old.filter(id=>id!==item.id))}/><span><strong>{item.name}</strong><small>{item.group}{installed.has(item.id)?" · installed":""}</small></span><span>{installed.has(item.id)?"Installed":`~${size(item.estimated_bytes)}`}</span></label>)}</div>
   <div className="map-plan"><p><strong>{chosen.length} regions selected · roughly {size(rough)}</strong></p><p className="fine">List sizes are rough guidance based on region size and population. Calculate the current extraction plan for this selection before downloading. The host refuses selections that exceed the map limit or safe free capacity.</p><button className="secondary" type="button" disabled={busy||!chosen.length} onClick={()=>void job("plan",chosen)}>Calculate download sizes</button>
    {currentPlan&&<><ul>{plan!.regions.map(item=><li key={item.id}>{item.name}: {size(item.planned_bytes??0)}</li>)}</ul><p><strong>Combined planned download: {size(plan!.planned_bytes)}</strong> · safe available space: {size(state.disk?.available_bytes??0)}</p><button className="primary" type="button" disabled={busy||plan!.planned_bytes>(state.disk?.available_bytes??0)} onClick={()=>void job("install",plan!.regions.map(item=>item.id),plan!.id)}><Download size={16}/>Download selected maps</button></>}
   </div></>}
  {state?.job&&<div className={`map-job ${state.job.state}`} role="status"><strong>{state.job.state==="running"?"Working":state.job.state==="failed"?"Map operation failed":state.job.state==="queued"?"Queued":"Map status"}</strong><p>{state.job.message}</p>{state.job.state==="running"&&state.job.message.startsWith("Downloading")&&<button className="secondary" type="button" onClick={async()=>{try{await api(`/maps/jobs/${state.job!.id}`,{method:"DELETE"});setError("Cancellation requested; existing maps stay installed.");}catch(e){setError((e as Error).message);}}}>Cancel download</button>}</div>}
  {queued&&state?.job?.id!==queued&&<p role="status">Map request queued for the host…</p>}
 </section>;
}
