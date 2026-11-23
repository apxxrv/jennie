import { Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatUSD } from "@/lib/format";
import type { BoardRow } from "@/lib/board";

export function RunHeader({rows,invoiceCount,hasRun,running,starting,onStart}:{rows:BoardRow[];invoiceCount:number|null;startedAt:string|null;hasRun:boolean;running:boolean;starting:boolean;onStart:()=>void}) {
 const held=rows.filter(r=>r.status==='held');
 const blocked=rows.filter(r=>r.status==='blocked');
 const paid=rows.filter(r=>r.status==='paid');
 const processed=rows.filter(r=>r.status!=='pending').length;
 const total=invoiceCount??40;
 const sum=(items:BoardRow[])=>items.reduce((t,r)=>t+r.amount,0);
 return <section className="workspace-overview"><div className="workspace-heading"><div><span className="eyebrow">RIDGELINE BUILDERS / PAYMENT DESK</span><h1>Your payment inbox. Jenny has it covered.</h1><p>{running?'Checking invoices and verifying payment details.':hasRun?'Jenny has finished checking your latest run. Open a flagged email to see what changed and what the vendor said.':'Jenny checks invoice history and calls verified vendor contacts when payment details change. Start a review to see what needs your attention.'}</p></div><Button variant="primary" onClick={onStart} disabled={starting||running}><Play size={16}/>{starting?'Starting…':running?'Review in progress':hasRun?'Run again':'Review 40 invoices'}</Button></div>
 <div className="workspace-metrics"><div><span>Needs your review</span><strong>{held.length}<small>payment{held.length===1?'':'s'}</small></strong><p>{held.length?`${formatUSD(sum(held))} on hold`:'Nothing waiting on you'}</p></div><div><span>Blocked & protected</span><strong>{formatUSD(sum(blocked))}</strong><p>{blocked.length} suspicious payment{blocked.length===1?'':'s'} stopped</p></div><div><span>Safely paid</span><strong>{formatUSD(sum(paid))}</strong><p>{paid.length} verified payments released</p></div><div><span>Review progress</span><strong>{processed}<small>/ {total} invoices</small></strong><div className="workspace-progress"><i style={{width:`${Math.min(100,processed/total*100)}%`}}/></div><p>{!hasRun?'Ready to start':running?'Working through your invoices':'Review complete'}</p></div></div></section>;
}
