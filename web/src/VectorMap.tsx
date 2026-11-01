import {useEffect,useRef,useState} from "react";
import maplibregl, {type LayerSpecification, type LngLatBoundsLike} from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-csp-worker.js?url";
import {Protocol} from "pmtiles";
import {layers,namedFlavor} from "@protomaps/basemaps";
import "maplibre-gl/dist/maplibre-gl.css";
import {gpsTrail,type GpsPoint} from "./gpsTrail";
import type {NetworkObservation} from "./PrivateMap";

maplibregl.setWorkerUrl(workerUrl);
maplibregl.addProtocol("pmtiles",new Protocol().tile);
export default function VectorMap({points,selected,network,label}:{points:GpsPoint[];selected?:GpsPoint|null;network?:NetworkObservation|null;label:string}) {
 const element=useRef<HTMLDivElement>(null),[error,setError]=useState("");
 const signature=JSON.stringify({points,selected,network});
 useEffect(()=>{
  if(!element.current)return;
  const base=layers("streets",namedFlavor("light"),{lang:"en"}).map(layer=>{
   if(layer.type==="symbol"&&layer.layout?.["text-field"]){return {...layer,layout:{...layer.layout,"text-font":["Noto Sans Regular"]}};}
   return layer;
  }) as LayerSpecification[];
  let m:maplibregl.Map;
  try {m=new maplibregl.Map({container:element.current,attributionControl:false,center:[-98,39],zoom:3,style:{version:8,glyphs:`${window.location.origin}/map-assets/fonts/{fontstack}/{range}.pbf`,sprite:`${window.location.origin}/map-assets/sprites/light`,sources:{streets:{type:"vector",url:`pmtiles://${window.location.origin}/api/maps/archive.pmtiles`}},layers:base}});}catch{setError("Street map rendering needs WebGL enabled in this browser.");return;}
  m.addControl(new maplibregl.NavigationControl(),"top-left");m.scrollZoom.disable();
  m.on("error",()=>setError("Some local map data could not be rendered. Check coverage and browser WebGL support."));
  m.on("load",()=>{
   const clean=gpsTrail(points);
   const features:GeoJSON.Feature[]=[];
   for(const segment of clean.segments)if(segment.length>1)features.push({type:"Feature",properties:{kind:"trail"},geometry:{type:"LineString",coordinates:segment.map(p=>[p.longitude,p.latitude])}});
   for(const p of clean.points)features.push({type:"Feature",properties:{kind:"gps"},geometry:{type:"Point",coordinates:[p.longitude,p.latitude]}});
   if(selected?.accuracy){const ring:number[][]=[];for(let i=0;i<=64;i++){const a=i/64*Math.PI*2;ring.push([selected.longitude+Math.cos(a)*selected.accuracy/(111320*Math.max(0.01,Math.cos(selected.latitude*Math.PI/180))),selected.latitude+Math.sin(a)*selected.accuracy/111320]);}features.push({type:"Feature",properties:{kind:"uncertainty"},geometry:{type:"Polygon",coordinates:[ring]}});}
   const geo=network?.geoip;
   if(geo?.latitude!=null&&geo.longitude!=null)features.push({type:"Feature",properties:{kind:"ip"},geometry:{type:"Point",coordinates:[geo.longitude,geo.latitude]}});
   m.addSource("observations",{type:"geojson",data:{type:"FeatureCollection",features}});
   m.addLayer({id:"uncertainty",type:"fill",source:"observations",filter:["==","kind","uncertainty"],paint:{"fill-color":"#4d8797","fill-opacity":0.15}});
   m.addLayer({id:"trail",type:"line",source:"observations",filter:["==","kind","trail"],paint:{"line-color":"#4d8797","line-width":3}});
   m.addLayer({id:"gps",type:"circle",source:"observations",filter:["==","kind","gps"],paint:{"circle-color":"#79b5c0","circle-radius":6,"circle-stroke-width":2,"circle-stroke-color":"#234d60"}});
   m.addLayer({id:"ip",type:"circle",source:"observations",filter:["==","kind","ip"],paint:{"circle-color":"#e8b76b","circle-radius":8,"circle-stroke-width":2,"circle-stroke-color":"#a46818"}});
   if(clean.points.length){const b=new maplibregl.LngLatBounds();for(const p of clean.points)b.extend([p.longitude,p.latitude]);m.fitBounds(b as LngLatBoundsLike,{padding:45,maxZoom:16,duration:0});}
   else if(geo?.latitude!=null&&geo.longitude!=null)m.jumpTo({center:[geo.longitude,geo.latitude],zoom:7});
  });
  const resize=new ResizeObserver(()=>m.resize());resize.observe(element.current);
  return()=>{resize.disconnect();m.remove();};
 },[signature]);
 return <div className="private-map-wrap"><div className="private-map" ref={element} role="img" aria-label={label}/><div className="private-map-key"><span className="gps-key">● GPS</span><span className="ip-key">● Approximate IP area</span></div><div className="private-map-status" role="status">{error||"Local street map · no external provider requests"}</div><div className="map-attribution">© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors</a> · Protomaps</div></div>;
}
