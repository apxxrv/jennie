import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Mail, Paperclip, Search, ShieldAlert, Star, FileText } from "lucide-react";
import { JennyCallOverlay, useRunJenny } from "@/components/board/jenny-call-overlay";
import { JennyAvatar } from "@/components/shared/jenny-avatar";
import { Phone } from "lucide-react";
import { api } from "@/lib/api";
import { useDetections } from "@/components/inbox/use-detections";
import { formatRelativeTime } from "@/lib/format";

export function JennyInbox() {
  const {data:threads,isPending,isError,refetch}=useQuery({queryKey:['inbox','threads'],queryFn:api.threads,refetchInterval:10000});
  const detections=useDetections();
  const [callOpen,setCallOpen]=useState(false);
  const runJenny=useRunJenny();
  function openJenny(){setCallOpen(true);void runJenny.run();}
  const [query,setQuery]=useState('');
  const [filter,setFilter]=useState<'all'|'flagged'|'starred'|'invoices'>('all');
  const [page,setPage]=useState(0);
  const [params]=useSearchParams();
  useEffect(()=>{const value=params.get("filter");if(value==="flagged"||value==="starred"||value==="invoices"){setFilter(value);setPage(0);}},[params]);
  const [stars,setStars]=useState<Set<string>>(()=>new Set());
  const [read,setRead]=useState<Set<string>>(()=>new Set());
  const filtered=(threads??[]).filter(t=>{const flagged=detections.has(t.thread_id);return (filter==='all'||(filter==='flagged'?flagged:filter==='invoices'?(t.attachment_count??0)>0:stars.has(t.thread_id)))&&`${t.vendor?.name??''} ${t.subject} ${t.preview}`.toLowerCase().includes(query.toLowerCase());}).sort((a,b)=>Number(detections.has(b.thread_id))-Number(detections.has(a.thread_id)));
  const pages=Math.max(1,Math.ceil(filtered.length/12));
  const currentPage=Math.min(page,pages-1);
  const visible=filtered.slice(currentPage*12,currentPage*12+12);
  function toggleStar(id:string){setStars(previous=>{const next=new Set(previous);if(next.has(id))next.delete(id);else next.add(id);return next;});}
  return <section className="jenny-mailbox" aria-label="Payment email inbox"><JennyCallOverlay open={callOpen} onOpenChange={setCallOpen} starting={runJenny.starting} resetting={runJenny.resetting} error={runJenny.error} resetError={runJenny.resetError} onRetry={()=>void runJenny.run()} onRunAgain={()=>void runJenny.runAgain()}/><div className="mailbox-top"><div><span className="mailbox-eyebrow">YOUR PAYMENT INBOX</span><h2>Payment inbox</h2><p>Your incoming payment requests, checked by Jenny.</p></div><div className="jenny-presence"><JennyAvatar/><div><strong>Jenny</strong><small>Your verification assistant</small></div><button className="run-jenny" onClick={openJenny} disabled={runJenny.starting}><Phone size={17}/>Run Jenny</button></div></div><label className="mailbox-search"><Search size={20}/><input aria-label="Search payment emails" placeholder="Search vendors, subjects, or payment requests" value={query} onChange={e=>{setQuery(e.target.value);setPage(0);}}/><kbd>⌕</kbd></label><div className="mailbox-tools"><nav aria-label="Email filters">{(['all','flagged','starred','invoices'] as const).map(value=><button key={value} aria-pressed={filter===value} onClick={()=>{setFilter(value);setPage(0);}}>{value==='all'?<Mail size={17}/>:value==='flagged'?<ShieldAlert size={17}/>:value==='invoices'?<FileText size={17}/>:<Star size={17}/>} {value==='all'?'Primary':value==='flagged'?'Flagged by Jenny':value==='invoices'?'Invoices':'Starred'}{value==='flagged'&&<span>{detections.size}</span>}</button>)}</nav><span>{filtered.length?`${currentPage*12+1}–${Math.min((currentPage+1)*12,filtered.length)} of ${filtered.length}`:'0 emails'}</span><button aria-label="Previous email page" disabled={currentPage===0} onClick={()=>setPage(currentPage-1)}><ChevronLeft size={17}/></button><button aria-label="Next email page" disabled={currentPage>=pages-1} onClick={()=>setPage(currentPage+1)}><ChevronRight size={17}/></button></div>
  {isError?<div className="mailbox-empty"><p>We couldn’t load the payment inbox.</p><button onClick={()=>void refetch()}>Try again</button></div>:isPending?<div className="mailbox-empty">Loading your payment requests…</div>:visible.length===0?<div className="mailbox-empty"><Mail size={28}/><h3>{filter==='flagged'?'No flagged emails in this view.':'No emails match this view.'}</h3><p>{filter==='flagged'?'Run an invoice review to let Jenny check requests and surface anything suspicious.':'Try a different search or choose All requests.'}</p></div>:<ul className="mailbox-rows">{visible.map(thread=>{const detection=detections.get(thread.thread_id);const starred=stars.has(thread.thread_id);return <li key={thread.thread_id} className={`${detection?'mail-flagged ':''}${read.has(thread.thread_id)?'mail-read':''}`}><button className="mail-star" aria-label={`${starred?'Unstar':'Star'} ${thread.subject}`} aria-pressed={starred} onClick={()=>toggleStar(thread.thread_id)}><Star size={18} fill={starred?'currentColor':'none'}/></button><Link className="mail-row-link" to={`/inbox?thread=${encodeURIComponent(thread.thread_id)}`} onClick={()=>setRead(previous=>new Set(previous).add(thread.thread_id))}><span className="mail-sender">{thread.vendor?.name??'Unknown sender'}{thread.count>1&&<small>{thread.count}</small>}</span><span className="mail-subject"><strong>{thread.subject}</strong><span> — {thread.preview}</span>{(thread.attachment_count??0)>0&&<Paperclip size={15}/>}</span><span className="mail-end">{detection?<span className="jenny-flag" title={detection.reason}><ShieldAlert size={13}/>Flagged by Jenny</span>:null}<time dateTime={thread.last_received_at}>{formatRelativeTime(thread.last_received_at)}</time></span></Link></li>})}</ul>}
  <div className="mailbox-note"><JennyAvatar className="jenny-mini"/><p><strong>Jenny checks the request, not just the name on it.</strong> Flagged labels come from the current payment run. Open an email to see the original message and verification evidence.</p></div></section>;
}
