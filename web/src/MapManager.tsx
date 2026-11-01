import {useEffect,useRef,useState} from "react";
import {ArrowDownToLine,Check,CheckCheck,ChevronDown,Download,HardDrive,LoaderCircle,Map,PackageCheck,RefreshCw,Search,ShieldCheck,Square,Trash2,X} from "lucide-react";
import {api} from "./api";

type Region={id:string;name:string;group:string;estimated_bytes:number;bytes?:number;planned_bytes?:number};
type MapJob={id:string;state:string;message:string;action?:string;completed?:number;total?:number};
type State={enabled:boolean;message?:string;catalog?:Region[];installed?:Region[];legacy_map_bytes?:number;map_limit_bytes?:number;job?:MapJob;last_plan?:{id:string;created_at?:number;planned_bytes:number;regions:Region[]};disk?:{total_bytes:number;free_bytes:number;available_bytes:number;reserve_bytes:number;swap_total_bytes:number;swap_used_bytes:number;swap_growth_reserve_bytes:number;backing_free_bytes:number;note:string}};
const size=(value=0)=>value>=1e9?`${(value/1e9).toFixed(2)} GB`:value>=1e6?`${(value/1e6).toFixed(1)} MB`:`${Math.ceil(value/1e3)} KB`;
const active=(state?:string)=>state==="queued"||state==="running";
const same=(a:string[],b:string[])=>a.slice().sort().join(",")===b.slice().sort().join(",");

export function MapManager(){
 const [state,setState]=useState<State|null>(null),[loadError,setLoadError]=useState(""),[error,setError]=useState("");
 const [view,setView]=useState<"browse"|"installed">("browse"),[chosen,setChosen]=useState<string[]>([]),[deleteChosen,setDeleteChosen]=useState<string[]>([]);
 const [search,setSearch]=useState(""),[group,setGroup]=useState("United States"),[sending,setSending]=useState(false),[queued,setQueued]=useState<string|null>(null),[stopping,setStopping]=useState(false);
 const [removal,setRemoval]=useState<Region[]|null>(null);
 const dialog=useRef<HTMLDialogElement>(null),review=useRef<HTMLDivElement>(null),latest=useRef(0),pending=useRef<string|null>(null);
 const load=async()=>{
  const request=++latest.current;
  try{
   const value=await api<State>("/maps/manage");if(request!==latest.current)return;
   setState(value);setLoadError("");
   const ids=new Set(value.installed?.map(item=>item.id));
   setChosen(old=>old.filter(id=>!ids.has(id)));setDeleteChosen(old=>old.filter(id=>ids.has(id)));
   if(value.job&&!active(value.job.state)&&(!pending.current||value.job.id===pending.current)){pending.current=null;setQueued(null);setStopping(false);}
  }catch(e){if(request===latest.current)setLoadError((e as Error).message);}
 };
 useEffect(()=>{void load();const timer=window.setInterval(load,3000);return()=>{window.clearInterval(timer);latest.current++};},[queued]);
 useEffect(()=>{const element=dialog.current;if(removal){setError("");element?.showModal();}return()=>{element?.close()};},[removal]);
 const downloaded=state?.installed??[],installed=new Set(downloaded.map(item=>item.id));
 const catalog=state?.catalog??[],groups=Array.from(new Set(catalog.map(item=>item.group)));
 const visible=catalog.filter(item=>(!group||item.group===group)&&`${item.name} ${item.group}`.toLowerCase().includes(search.trim().toLowerCase()));
 const available=visible.filter(item=>!installed.has(item.id)),availableIds=available.map(item=>item.id);
 const selected=catalog.filter(item=>chosen.includes(item.id)),rough=selected.reduce((sum,item)=>sum+item.estimated_bytes,0);
 const busy=sending||!!queued||active(state?.job?.state),enabled=!!state?.enabled&&!loadError;
 const used=downloaded.reduce((sum,item)=>sum+(item.bytes??0),state?.legacy_map_bytes??0),limit=state?.map_limit_bytes??25e9;
 const worldwide=!group&&!search.trim()&&catalog.reduce((total,item)=>total+item.estimated_bytes,0)>limit;
 const safeFree=Math.max(0,Math.min(state?.disk?.available_bytes??0,limit-used));
 const plan=state?.last_plan,currentPlan=!!plan&&same(plan.regions.map(item=>item.id),chosen)&&(!plan.created_at||Date.now()/1000-plan.created_at<3600);
 const fits=!!plan&&plan.planned_bytes<=safeFree;
 const selectedDownloaded=downloaded.filter(item=>deleteChosen.includes(item.id));
 const perMapProgress=state?.job?.message.match(/^Downloading (.+): ([\d.]+) \/ ([\d.]+) MiB$/);
 useEffect(()=>{if(currentPlan)review.current?.scrollIntoView({behavior:"smooth",block:"nearest"});},[currentPlan,plan?.id]);
 async function job(action:string,regions:string[],planId?:string){
  setSending(true);setError("");
  try{
   const result=await api<{id:string}>("/maps/jobs",{method:"POST",body:JSON.stringify({action,regions,...(planId?{plan_id:planId}:{})})});
   pending.current=result.id;setQueued(result.id);setStopping(false);return true;
  }catch(e){setError((e as Error).message);return false;}finally{setSending(false);}
 }
 function prepare(ids:string[]){if(!ids.length||busy)return;setChosen(ids);setView("browse");void job("plan",ids);}
 async function stop(){
  const id=queued??state?.job?.id;if(!id)return;setStopping(true);setError("");
  try{await api(`/maps/jobs/${id}`,{method:"DELETE"});}catch(e){setStopping(false);setError((e as Error).message);}
 }
 const task=state?.job,showTask=!!queued||!!task&&(["running","queued","failed","canceled"].includes(task.state)||task.state==="completed"&&["install","remove"].includes(task.action??""));
 return <section className="panel map-manager" id="map-downloads">
  <div className="map-library-heading"><div><span className="map-eyebrow"><Map size={15}/> OFFLINE MAP LIBRARY</span><h2>Maps &amp; storage</h2><p>Choose the places you need. Every tracking view uses your downloaded maps.</p></div><button className="map-button neutral" type="button" onClick={()=>void load()} aria-label="Refresh map status"><RefreshCw size={16}/><span>Refresh</span></button></div>
  {loadError&&<div className="map-feedback error" role="alert">{loadError}</div>}
  {error&&<div className="map-feedback error" role="alert">{error}</div>}
  {!state&&!loadError&&<p className="map-loading" role="status"><LoaderCircle size={18} className="map-spin"/>Loading your map library…</p>}
  {(loadError||state?.enabled===false)&&<div className="map-repair"><strong>Reconnect the map downloader</strong><p>From the Bungee checkout on your server, run the repair, then refresh this panel. Your downloaded maps and phone history are preserved.</p><code>python3 scripts/bungee-host.py repair-maps</code>{state?.message&&<p>{state.message}</p>}</div>}
  {state?.disk&&<div className="map-storage">
   <div className="map-storage-main"><span className="map-storage-icon"><HardDrive size={22}/></span><div><span className="map-kicker">AVAILABLE FOR DOWNLOADS</span><strong>{size(safeFree)}</strong><span>After storage reserves and the map budget</span></div></div>
   <div className="map-budget"><div><strong>{size(used)} downloaded</strong><span>{size(limit)} map budget</span></div><progress aria-label="Map storage used" max={limit} value={Math.min(used,limit)}/><small><ShieldCheck size={14}/>Backup, system and swap space stays reserved.</small></div>
   <details className="map-storage-details"><summary>Storage details<ChevronDown size={14}/></summary><dl><div><dt>Bungee storage free / total</dt><dd>{size(state.disk.free_bytes)} / {size(state.disk.total_bytes)}</dd></div><div><dt>Safety reserve</dt><dd>{size(state.disk.reserve_bytes)}</dd></div><div><dt>Swap used / configured</dt><dd>{size(state.disk.swap_used_bytes)} / {size(state.disk.swap_total_bytes)}</dd></div><div><dt>Swap growth reserve</dt><dd>{size(state.disk.swap_growth_reserve_bytes)}</dd></div><div><dt>Host backing storage free</dt><dd>{size(state.disk.backing_free_bytes)}</dd></div></dl><p>{state.disk.note} Capacity is checked again during downloading.</p></details>
  </div>}
  {showTask&&<div className={`map-task ${task?.state??"queued"}`} role="status"><div className="map-task-heading"><span className="map-task-icon">{active(task?.state)||queued?<LoaderCircle size={19} className="map-spin"/>:task?.state==="completed"?<Check size={19}/>:<Square size={18}/>}</span><div><strong>{stopping?"Stopping…":task?.state==="failed"?"Map operation needs attention":task?.state==="canceled"?"Operation stopped":task?.state==="completed"?task.action==="remove"?"Downloaded maps deleted":"Maps are ready offline":task?.action==="plan"?"Checking download sizes":task?.action==="remove"?"Deleting downloaded maps":task?.action==="install"?"Downloading maps":"Map request queued"}</strong><p>{queued&&task?.id!==queued?"The host will start this request shortly.":task?.message}</p></div>{(queued||active(task?.state))&&<button className="map-button neutral" type="button" disabled={stopping} onClick={()=>void stop()}><Square size={14}/>{stopping?"Stopping…":"Stop"}</button>}</div>{perMapProgress&&<progress aria-label="Current map download progress" max={Number(perMapProgress[3])||1} value={Number(perMapProgress[2])}/>}<small>{task?.action==="install"&&task.total?`${task.completed??0} of ${task.total} maps ready. `:""}{task?.action==="remove"?"Phone pairing and GPS history are preserved.":"Completed maps stay available if you stop. Downloads continue when you leave this screen."}</small></div>}
  <div className="map-library-tabs" role="group" aria-label="Map library views"><button type="button" aria-pressed={view==="browse"} onClick={()=>setView("browse")}><Map size={16}/>Browse &amp; download</button><button type="button" aria-pressed={view==="installed"} onClick={()=>setView("installed")}><PackageCheck size={16}/>Downloaded maps<span>{downloaded.length}</span></button></div>
  {view==="browse"&&state?.enabled&&<>
   <div className="map-picker-filters"><label>Region group<select value={group} onChange={e=>setGroup(e.target.value)}><option value="">All regions</option>{groups.map(item=><option key={item}>{item}</option>)}</select></label><label className="map-search">Find a place<span><Search size={17}/><input type="search" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search countries or US regions"/></span></label></div>
   <div className="map-list-toolbar"><div><strong>{group||"All regions"}</strong><span>{available.length} available{visible.length-available.length?` · ${visible.length-available.length} downloaded`:""}</span></div><div className="map-toolbar-actions"><button className="map-button neutral" type="button" disabled={busy||!available.length} onClick={()=>setChosen(old=>Array.from(new Set([...old,...availableIds])))}><CheckCheck size={16}/>Select all shown</button><button className="map-button download" type="button" disabled={!enabled||busy||!available.length||worldwide} title={worldwide?"Worldwide street detail exceeds the 25 GB map budget. Choose a region group.":undefined} onClick={()=>prepare(availableIds)} aria-label={`Download all ${available.length} ${group||"shown"} maps`}><Download size={16}/>Download all {available.length>0?`(${available.length})`:""}</button></div></div>
   {worldwide&&<p className="map-catalog-hint">Worldwide street detail exceeds the 25 GB budget. Browse by region or build a custom selection; exact sizes are checked before any download.</p>}
   <div className="map-checklist map-catalog">{visible.map(item=><div className={`map-catalog-row${installed.has(item.id)?" downloaded":""}`} key={item.id}>
    <label className="map-select"><input type="checkbox" aria-label={`Select ${item.name} map`} checked={chosen.includes(item.id)} disabled={busy||installed.has(item.id)} onChange={e=>setChosen(old=>e.target.checked?[...old,item.id]:old.filter(id=>id!==item.id))}/><span><strong>{item.name}</strong><small>{item.group}</small></span></label>
    <span className="map-region-size">{installed.has(item.id)?<span className="map-ready"><Check size={14}/>Downloaded</span>:<><strong>~{size(item.estimated_bytes)}</strong><small>estimated download</small></>}</span>
    {installed.has(item.id)?<button className="map-button delete" type="button" disabled={busy} onClick={()=>setRemoval(downloaded.filter(map=>map.id===item.id))} aria-label={`Delete ${item.name} map`}><Trash2 size={15}/>Delete</button>:<button className="map-button outline-download" type="button" disabled={!enabled||busy} onClick={()=>prepare([item.id])} aria-label={`Download ${item.name} map`}><ArrowDownToLine size={16}/>Download</button>}
   </div>)}{visible.length===0&&<div className="map-empty"><Search size={25}/><strong>No matching maps</strong><p>Try another region group or search term.</p><button className="map-button neutral" type="button" onClick={()=>{setGroup("");setSearch("")}}>Clear filters</button></div>}</div>
   <div className="map-selection"><div><strong>{chosen.length} {chosen.length===1?"map":"maps"} selected</strong><span>Estimated total: {size(rough)}{chosen.length>0?" · selected across all filters":""}</span></div><div className="map-toolbar-actions"><button className="map-button neutral" type="button" disabled={busy||!chosen.length} onClick={()=>setChosen([])}><X size={15}/>Clear selection</button><button className="map-button download" type="button" disabled={!enabled||busy||!chosen.length} onClick={()=>prepare(chosen)}>Calculate download sizes</button></div></div>
   {currentPlan&&<div className="map-review" ref={review}><span className="map-eyebrow">READY TO DOWNLOAD</span><h3>Review {plan!.regions.length===1?plan!.regions[0].name:`${plan!.regions.length} selected maps`}</h3><p>Current download sizes, checked by your server.</p><ul>{plan!.regions.map(item=><li key={item.id}><span>{item.name}</span><strong>{size(item.planned_bytes??0)}</strong></li>)}</ul><div className="map-review-total"><span>Total download<strong>{size(plan!.planned_bytes)}</strong></span><span>Safely available<strong>{size(safeFree)}</strong></span></div>{!fits&&<p className="map-capacity-warning" role="alert">This selection exceeds the available map space. Delete downloaded maps or select fewer places.</p>}<button className="map-button download" type="button" disabled={!enabled||busy||!fits} onClick={()=>void job("install",plan!.regions.map(item=>item.id),plan!.id)}><Download size={17}/>Download selected maps<span className="map-button-size">{size(plan!.planned_bytes)}</span></button></div>}
   <p className="map-footnote">List sizes are estimates. Every download uses a checked size plan and reserves space for the system. © OpenStreetMap contributors · Protomaps. Nearby street labels are approximate, not verified postal addresses.</p>
  </>}
  {view==="installed"&&<>
   <div className="map-list-toolbar"><div><strong>Your downloaded maps</strong><span>{downloaded.length} maps · {size(downloaded.reduce((sum,item)=>sum+(item.bytes??0),0))}</span></div><button className="map-button delete" type="button" disabled={busy||!downloaded.length||!enabled} onClick={()=>setRemoval(downloaded)}><Trash2 size={16}/>Delete all downloads</button></div>
   {downloaded.length>0?<><div className="map-delete-toolbar"><button className="map-button neutral" type="button" disabled={busy} onClick={()=>setDeleteChosen(downloaded.map(item=>item.id))}><CheckCheck size={16}/>Select all downloaded</button><button className="map-button neutral" type="button" disabled={busy||!deleteChosen.length} onClick={()=>setDeleteChosen([])}>Clear selection</button><button className="map-button delete" type="button" disabled={busy||!deleteChosen.length||!enabled} onClick={()=>setRemoval(selectedDownloaded)}><Trash2 size={16}/>Delete selected ({deleteChosen.length})</button></div><ul className="map-downloaded-list">{downloaded.map(item=><li key={item.id}><label className="map-select"><input type="checkbox" aria-label={`Select ${item.name} for deletion`} checked={deleteChosen.includes(item.id)} disabled={busy} onChange={e=>setDeleteChosen(old=>e.target.checked?[...old,item.id]:old.filter(id=>id!==item.id))}/><span><strong>{item.name}</strong><small>{item.group} · ready offline</small></span></label><strong className="map-region-size">{size(item.bytes??0)}</strong><button className="map-button delete" type="button" disabled={busy||!enabled} onClick={()=>setRemoval([item])} aria-label={`Delete ${item.name} map`}><Trash2 size={15}/>Delete</button></li>)}</ul></>:<div className="map-empty"><PackageCheck size={28}/><strong>No street maps downloaded yet</strong><p>Choose a region in Browse &amp; download to add street detail.</p><button className="map-button outline-download" type="button" onClick={()=>setView("browse")}><Download size={16}/>Browse maps</button></div>}
  </>}
  <div className="map-built-in"><span className="map-built-in-icon"><Map size={22}/></span><div><strong>World overview<span className="map-included">Included</span></strong><p>7.7 MB · Countries and major places. Always available for map context.</p></div></div>
  {!!state?.legacy_map_bytes&&<div className="map-built-in"><Map size={20}/><div><strong>Imported street-map archive</strong><p>{size(state.legacy_map_bytes)} · imported on this server; included in the storage budget.</p></div></div>}
  {removal&&<dialog className="map-delete-dialog" ref={dialog} aria-labelledby="map-delete-title" onCancel={()=>setRemoval(null)}><span className="map-delete-symbol"><Trash2 size={24}/></span><h3 id="map-delete-title">Delete {removal.length===1?removal[0].name:`${removal.length} downloaded maps`}?</h3><p>Frees {size(removal.reduce((sum,item)=>sum+(item.bytes??0),0))} on this server. Phone pairing, GPS history and the included world overview stay available. You can download these maps again.</p><ul>{removal.slice(0,6).map(item=><li key={item.id}>{item.name}</li>)}{removal.length>6&&<li>and {removal.length-6} more</li>}</ul>{error&&<p className="map-dialog-error" role="alert">{error}</p>}<div className="map-dialog-actions"><button className="map-button neutral" type="button" autoFocus onClick={()=>setRemoval(null)}>Keep maps</button><button className="map-button delete-solid" type="button" disabled={sending} onClick={async()=>{if(await job("remove",removal.map(item=>item.id)))setRemoval(null)}}><Trash2 size={16}/>Delete {removal.length===1?"map":`${removal.length} maps`}</button></div></dialog>}
 </section>;
}
