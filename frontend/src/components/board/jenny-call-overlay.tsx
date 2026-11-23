import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { JennyAvatar } from '@/components/shared/jenny-avatar';
import { useCurrentRun } from '@/components/shared/run-context';
import { api } from '@/lib/api';
import { ApiError, errorMessage } from '@/lib/api-error';
import { API_URL } from '@/lib/api-url';
import { foldCalls, type CallView } from '@/lib/calls';
import { getDataMode } from '@/lib/data-mode';
import { formatRelativeTime } from '@/lib/format';
import { callSimulated, SEEDED_CALL_PAYMENTS, useServiceModes } from '@/lib/services';
import type { TestLaunch } from '@/components/board/jenny-test-call';
import type { CallOutcome, ContactSource, PaymentDetail, PaymentStatus, RunEvent } from '@/lib/types';
import { Mic, Pause, Phone, PhoneOff, Play, RotateCcw, ShieldCheck, Volume2 } from 'lucide-react';

// "Run Jenny": starts this week's real payment run (or follows the one already going, or shows the one already finished) and
// shows the run's real verification calls, read from the run's event stream and the payment records. Nothing here is scripted: a call the server
// simulated says so, and a call it dialed says that.

/**
 * Run Jenny. Live: if the server's latest run is going, follow it; if it completed, the week is already checked, so show that
 * run instead of starting an empty one over zero open invoices; only with no run, or a failed one, start a run.
 * runAgain resets the demo week (the top bar's reset, admin key and all) and then starts a fresh run.
 */
export function useRunJenny() {
 const {runId,summary,runFailed,startRun,followRun,forgetAfterReset,resetCount}=useCurrentRun();
 const [starting,setStarting]=useState(false);
 const [resetting,setResetting]=useState(false);
 const [error,setError]=useState<string|null>(null);
 const [resetError,setResetError]=useState<string|null>(null);
 const busy=useRef(false);
 const resets=useRef(resetCount);
 resets.current=resetCount;
 const start=useCallback(async()=>{
  try{await startRun();}
  catch(err){
   // 409: a run started elsewhere (another tab, a phone) is still going. Follow it instead of starting a second one.
   if(!(err instanceof ApiError&&err.status===409))throw err;
   const {run:latest}=await api.latestRun();
   if(!latest)throw err;
   followRun(latest.run_id);
  }
 },[startRun,followRun]);
 const run=useCallback(async()=>{
  if(busy.current)return;
  busy.current=true;setError(null);setResetError(null);
  try{
   if(getDataMode()==='live'){
    const {run:latest}=await api.latestRun();
    if(latest&&(latest.status==='running'||latest.status==='completed')){
     if(latest.run_id!==runId)followRun(latest.run_id);
     return;
    }
   }else if(runId&&!summary.completed&&!runFailed){
    const current=await api.run(runId).catch(()=>null);
    if(current?.status==='running')return;
   }
   setStarting(true);
   await start();
  }catch(err){setError(errorMessage(err));}
  finally{busy.current=false;setStarting(false);}
 },[runId,summary.completed,runFailed,start,followRun]);
 const runAgain=useCallback(async()=>{
  if(busy.current)return;
  busy.current=true;setError(null);setResetError(null);setResetting(true);
  const before=resets.current;
  try{
   try{await api.resetDemo(true);}
   catch(err){setResetError(errorMessage(err));return;} // refused or failed: nothing changed, the last run stays on screen
   setStarting(true);
   // The reset also arrives on the global channel, and the shell forgets the current run when it does. Wait for it (briefly), so
   // it cannot land after the new run starts and forget that one instead.
   for(let waited=0;resets.current===before&&waited<4000;waited+=100)await new Promise(r=>setTimeout(r,100));
   forgetAfterReset();
   await start();
  }catch(err){setError(errorMessage(err));}
  finally{busy.current=false;setResetting(false);setStarting(false);}
 },[forgetAfterReset,start]);
 return {run,runAgain,starting,resetting,error,resetError};
}

/** Server times from SQLite carry no zone; they are UTC. */
function serverTime(value:string):Date{
 return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(value)?value:`${value}Z`);
}

const OUTCOME_TEXT:Record<CallOutcome,{title:string;detail:string}>={
 confirmed:{title:'Vendor confirmed the change',detail:'The new account was verified by the call.'},
 denied:{title:'Vendor denied the change',detail:'The request is treated as fraud. The verified account stays unchanged.'},
 unclear:{title:'The answer was unclear',detail:'An uncertain answer is never permission to pay. A person reviews it.'},
 no_answer:{title:'No answer',detail:'The payment stays on hold. Nothing is paid to the new account.'},
};
const STATUS_TEXT:Record<PaymentStatus,string>={paid:'Payment released',held:'Payment on hold for your review',blocked:'Payment blocked',pending:'Payment pending'};
const PHASE_LABEL={queued:'WAITING TO CALL',dialing:'CALLING',live:'ON THE CALL',ended:'CALL ENDED'} as const;
const SOURCE_TEXT:Record<ContactSource,string>={website:'Number from the vendor’s own website',on_file:'Number on file from before the change',listing:'Number from a public business listing'};

interface VoiceStatus {provider:'elevenlabs'|'polly'|null;configured:boolean}

async function voiceStatus():Promise<VoiceStatus>{
 const r=await fetch(`${API_URL}/api/jenny/voice/status`);
 if(!r.ok)return {provider:null,configured:false};
 return await r.json() as VoiceStatus;
}

/** How the server placed this call. Null until it is known. */
function callKind(call:CallView,detail:PaymentDetail|undefined,simulatedNow:boolean|null):{pill:string;line:string;live:boolean}|null{
 const simulated=detail?.calls.at(-1)?.simulated??simulatedNow;
 if(simulated==null)return null;
 if(!simulated)return {pill:'Live call',line:'Live call to the vendor’s verified number',live:true};
 return SEEDED_CALL_PAYMENTS.includes(call.paymentId)
  ?{pill:'Demo call',line:'Demo call from the seeded run · nothing was dialed',live:false}
  :{pill:'Simulated call',line:'Simulated call · nothing was dialed',live:false};
}

/** "test": the overlay follows the test scam email this tab sent (its own mini-run and payment), not the weekly run. */
export interface TestFocus {sending:boolean;error:string|null;launched:TestLaunch|null}

export function JennyCallOverlay({open,onOpenChange,starting,resetting,error,resetError,onRetry,onRunAgain,test}:{open:boolean;onOpenChange:(value:boolean)=>void;starting:boolean;resetting:boolean;error:string|null;resetError:string|null;onRetry:()=>void;onRunAgain:()=>void;test:TestFocus|null}) {
 const current=useCurrentRun();
 const {summary,runFailed,pinned,pinnedEvents}=current;
 const launched=test?.launched??null;
 const testEvents=useMemo(()=>launched&&pinned?.paymentId===launched.paymentId?pinnedEvents:[],[launched,pinned?.paymentId,pinnedEvents]);
 const events=test?testEvents:current.events;
 const runId=test?(launched?.runId??null):current.runId;
 const modes=useServiceModes();
 const calls=useMemo(()=>{const all=foldCalls(events);return launched&&test?all.filter(c=>c.paymentId===launched.paymentId):all;},[events,launched,test]);
 // Each payment's latest status, from the same events the board reads, so the result shows as soon as the server decides.
 const statusOf=useMemo(()=>{const out=new Map<string,PaymentStatus>();for(const e of events){if(e.type==='payment.paid')out.set(e.payment_id,'paid');else if(e.type==='payment.held')out.set(e.payment_id,'held');else if(e.type==='payment.blocked')out.set(e.payment_id,'blocked');}return out;},[events]);
 const details=useQueries({queries:calls.map(c=>({
  queryKey:['payment',c.paymentId,'jenny-call',c.outcome??c.phase],
  queryFn:()=>api.payment(c.paymentId),
  enabled:open,
  retry:false,
 }))});
 const [picked,setPicked]=useState<string|null>(null);
 const index=Math.max(0,calls.findIndex(c=>c.paymentId===picked));
 const call:CallView|undefined=calls[index];
 const detail=details[index]?.data;
 const kind=call?callKind(call,detail,modes.known?callSimulated({paymentId:call.paymentId},modes):null):null;
 const contact=detail?.calls.at(-1)?.contact??null;
 const running=!test&&Boolean(runId)&&!summary.completed&&!runFailed;
 // A finished run: the last one the server has. Its time comes from the run's own run.completed event.
 const finishedAt=useMemo(()=>events.find(e=>e.type==='run.completed')?.at??null,[events]);
 const finished=!test&&Boolean(runId)&&summary.completed&&!starting;
 const runAgain=finished?<RunAgain resetting={resetting} error={resetError} onRunAgain={onRunAgain}/>:null;

 // Voice: the real transcript, line by line, through /api/jenny/voice. Text only when no voice is connected or it fails.
 const status=useQuery({queryKey:['jenny-voice-status'],queryFn:voiceStatus,enabled:open,staleTime:60_000,retry:false});
 // A live call is happening on the phone: the browser stays quiet (it would talk over the call) and shows the words as text.
 const voiceReady=Boolean(status.data?.configured)&&kind!=null&&!kind.live;
 const [playing,setPlaying]=useState(false);
 const [spoken,setSpoken]=useState(0);
 const [voiceError,setVoiceError]=useState('');
 const [loading,setLoading]=useState(false);
 const [audioElement,setAudioElement]=useState<HTMLAudioElement|null>(null);
 const generation=useRef(0);
 const callKey=call?`${call.paymentId}|${call.startedAt??''}`:'';
 const [manual,setManual]=useState<number|null>(null); // a line picked by hand when there is no voice
 useEffect(()=>{setSpoken(0);setManual(null);setVoiceError('');setPlaying(open&&voiceReady);},[callKey,open,voiceReady]);
 const lines=useMemo(()=>call?.lines??[],[call]);
 const last=Math.max(0,lines.length-1);
 // With a voice, the line being spoken. Text only: the newest line, unless one was picked.
 const shown=voiceReady&&!voiceError?Math.min(spoken,last):Math.min(manual??last,last);
 const line=lines[shown];
 // Keyed on the words, not the array: the run's other events rebuild the array and must not restart the line being spoken.
 const nextText=lines[spoken]?.text??null;
 const nextSpeaker=lines[spoken]?.speaker??'agent';
 useEffect(()=>{
  const player=audioElement;
  if(!open||!playing||!voiceReady||!player||nextText==null){player?.pause();setLoading(false);return;}
  const id=++generation.current;
  const controller=new AbortController();
  let blob:string|undefined;
  const target={text:nextText,speaker:nextSpeaker};
  setLoading(true);
  async function play(){
   try{
    const response=await fetch(`${API_URL}/api/jenny/voice`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:target.text,speaker:target.speaker}),signal:controller.signal});
    if(!response.ok)throw new Error(String(response.status));
    blob=URL.createObjectURL(await response.blob());
   }catch{
    if(controller.signal.aborted)return;
    setVoiceError('The voice is unavailable right now, so the call is shown as text.');setPlaying(false);setLoading(false);return;
   }
   if(controller.signal.aborted||generation.current!==id||!player)return;
   player.src=blob;
   try{await player.play();setLoading(false);}
   catch{if(!controller.signal.aborted){setVoiceError('Press play to hear the call.');setPlaying(false);setLoading(false);}}
  }
  void play();
  return ()=>{controller.abort();player.pause();if(blob)URL.revokeObjectURL(blob);};
 },[open,playing,voiceReady,spoken,nextText,nextSpeaker,audioElement]);

 const voiceLabel=status.data?.provider==='polly'?'AWS Polly voice':status.data?.provider==='elevenlabs'?'ElevenLabs voice':'Text only';
 const title=test?'Jenny is checking the test scam email':running||starting?'Jenny is checking this week’s payments':finished?'Jenny’s last payment run':'Jenny’s verification calls';
 const pill=kind?.pill??(test?'Test email':running||starting?'Payment run':finished?'Last run':'Results');
 const finishedLine=finished&&finishedAt?`Last run, finished ${formatRelativeTime(serverTime(finishedAt))}`:null;
 const subtitle=[finishedLine,kind?.line??(test?'The test attack, live from the server':running||starting?'The real payment run, live from the server':finishedLine?null:'From the latest payment run')].filter(Boolean).join(' · ');

 let phone:ReactNode;
 let panel:ReactNode;
 const testStarted=events.some(e=>e.type==='run.started');
 const testSettled=launched?statusOf.get(launched.paymentId):undefined;
 if(test&&!call){
  if(test.error){
   phone=<PhoneMessage label="NOT SENT" title="Test scam email" line="Nothing was sent"/>;
   panel=<Note title="The test email was not sent." text={`${test.error.replace(/\.?$/,'.')} Nothing was added to the inbox and no call was placed.`}/>;
  }else if(test.sending||!launched){
   phone=<PhoneMessage label="SENDING" title="Test scam email" line="Sending…"/>;
   panel=<Note title="Sending the test email." text="It goes into Summit Concrete’s thread in the payment inbox."/>;
  }else if(!testStarted&&launched.queued){
   phone=<PhoneMessage label="WAITING" title="Test scam email" line="In the inbox, waiting its turn"/>;
   panel=<Note title="Waiting for the run ahead of it to finish." text={`Another payment run, or an earlier test and its call, is still going. This email is checked right after${launched.position>1?`; it was number ${launched.position} in line when it was sent`:''}.`}/>;
  }else if(testSettled&&testSettled!=='pending'){
   phone=<PhoneMessage label="CHECKED" title="Test scam email" line={STATUS_TEXT[testSettled]}/>;
   panel=<Note title={STATUS_TEXT[testSettled]} text="Jenny decided without a verification call."><TestSteps events={events} paymentId={launched.paymentId} call={undefined}/></Note>;
  }else{
   phone=<PhoneMessage label="CHECKING" title="Test scam email" line={testStarted?'Email received':'Starting…'}/>;
   panel=<Note title={testStarted?'Email received. Jenny is checking it.':'The email is in the inbox.'} text="A call starts only if the email asks to send money to a new account."><TestSteps events={events} paymentId={launched.paymentId} call={undefined}/></Note>;
  }
 }else if(error){
  phone=<PhoneMessage label="RUN NOT STARTED" title="Jenny couldn’t start" line="No payment run is in progress."/>;
  panel=<Note title="The payment run did not start." text={error}><button className="begin-jenny-call" onClick={onRetry}><Phone size={17}/> Try again</button></Note>;
 }else if(!call&&(starting||(running&&!summary.completed))){
  const count=summary.invoiceCount;
  phone=<PhoneMessage label="PAYMENT RUN IN PROGRESS" title="This week’s payment run" line={count==null?'Starting…':`${summary.processed} of ${count} invoices checked`}/>;
  panel=<Note title="Jenny is checking invoices." text="A call starts only when a payment asks to send money to a new account. Calls appear here as soon as they begin."><RunCounts paid={summary.paid} held={summary.held} blocked={summary.blocked}/></Note>;
 }else if(!call&&runFailed){
  phone=<PhoneMessage label="RUN STOPPED" title="This week’s payment run" line="Stopped when the server restarted"/>;
  panel=<Note title="This run stopped before it finished." text="Start a new run to check the remaining invoices."><button className="begin-jenny-call" onClick={onRetry}><Phone size={17}/> Start a new run</button></Note>;
 }else if(!call&&runId&&summary.completed){
  const none=summary.invoiceCount===0;
  phone=<PhoneMessage label="RUN COMPLETE" title="This week’s payment run" line={none?'No open invoices':'No calls were needed'}/>;
  panel=<Note title={none?'There were no open invoices to check.':'This run needed no verification calls.'} text={none?'Every invoice this week was already handled by an earlier run.':'No payment asked to change where its money goes.'}><RunCounts paid={summary.paid} held={summary.held} blocked={summary.blocked}/>{runAgain}</Note>;
 }else if(!call){
  phone=<PhoneMessage label="READY" title="This week’s payment run" line="Not started"/>;
  panel=<Note title="No payment run yet." text="Run Jenny to check this week’s invoices."><button className="begin-jenny-call" onClick={onRetry}><Phone size={17}/> Run Jenny</button></Note>;
 }else{
  const outcome=call.outcome?OUTCOME_TEXT[call.outcome]:null;
  const settled=statusOf.get(call.paymentId)??detail?.payment.status;
  const paymentStatus=call.outcome&&settled?STATUS_TEXT[settled]:null;
  const source=call.contactSource?SOURCE_TEXT[call.contactSource]:null;
  const sourceUrl=call.finding?.sourceUrl??contact?.source_url??null;
  const speaking=playing&&!loading&&spoken<lines.length;
  phone=<div className="glass-call-phone"><div className="glass-phone-notch"/><div className="phone-top-clock"><span>{pill}</span><span>{call.phase==='ended'?'':'●'}</span></div><span className="glass-phone-label">{PHASE_LABEL[call.phase]}</span><h3>{call.vendor||'The vendor'}</h3><p>{contact?.phone?`Verified number ${contact.phone}`:source??'Finding the verified number'}</p><div className={`jenny-calling-avatar ${speaking?'is-talking':''}`}><JennyAvatar/></div><span className="calling-person">{outcome?outcome.title:call.phase==='live'?`Speaking with ${call.vendor}`:call.phase==='dialing'?`Calling ${call.vendor}`:'Queued for a verification call'}</span><div className={`overlay-wave ${speaking?'is-speaking':''}`} aria-label={speaking?'Speaking':'Quiet'}>{Array.from({length:21},(_,i)=><i key={i} style={{height:10+(i*19%30),animationDelay:`${i*.06}s`}}/>)}</div><div className="glass-phone-controls"><button aria-label={playing?'Pause the call audio':'Play the call audio'} disabled={!voiceReady||lines.length===0} onClick={()=>{setVoiceError('');if(spoken>=lines.length)setSpoken(0);setPlaying(!playing);}}>{playing?<Pause size={21}/>:<Play size={21}/>}</button><button className="end-jenny-call" aria-label="Close" onClick={()=>onOpenChange(false)}><PhoneOff size={21}/></button><span><Volume2 size={19}/></span></div><span className="phone-audio-provider">{kind?.live?'The audio is on the phone':loading?'Preparing audio…':voiceLabel}</span><div className="phone-bottom-line"/></div>;
  panel=<><span className="eyebrow">VENDOR VERIFICATION</span><h3>A direct question.<br/>An answer on record.</h3><p>{source?<>{source}{sourceUrl&&<> · <a href={sourceUrl} target="_blank" rel="noreferrer">see the page</a></>}</>:'Jenny calls a number found independently, never one from the email.'}</p>
   {calls.length>1&&<label className="call-vendor-picker">Choose a call<select value={call.paymentId} onChange={e=>setPicked(e.target.value)}>{calls.map(c=><option key={c.paymentId} value={c.paymentId}>{c.vendor||c.paymentId}</option>)}</select></label>}
   <div className="call-transcript-card" aria-live="polite">{line?<><span><Mic size={14}/>{line.speaker==='agent'?'Jenny':call.vendor}<small>{shown+1} / {lines.length}</small></span><p>“{line.text}”</p></>:<><span><Mic size={14}/>Transcript</span><p>{call.phase==='queued'?'The call has not started yet.':'Waiting for the first words.'}</p></>}</div>
   {test&&launched&&<TestSteps events={events} paymentId={launched.paymentId} call={call}/>}
   {lines.length>0&&<div className="call-line-controls">{lines.map((_,i)=><button key={i} aria-label={`Show line ${i+1}`} aria-pressed={shown===i} onClick={()=>{setManual(i);setSpoken(i);setPlaying(voiceReady&&!voiceError);}}/>)}</div>}
   {outcome?<div className="call-demo-result"><ShieldCheck size={19}/><div><strong>{outcome.title}</strong><p>{outcome.detail}</p>{paymentStatus&&<small>{paymentStatus}</small>}</div></div>:null}
   {voiceError&&<p role="status" className="call-audio-error">{voiceError}</p>}
   {runAgain}</>;
 }

 return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="jenny-call-dialog" aria-describedby="jenny-call-description"><div className="call-overlay-head"><JennyAvatar/><div><DialogTitle>{title}</DialogTitle><p id="jenny-call-description">{subtitle}</p></div><span className="call-demo-pill">{pill}</span></div><div className="inbox-call-layout">{phone}<div className="call-overlay-conversation">{panel}<small className="elevenlabs-connection">{test&&!kind?'A live call is heard on the phone and shown here as text. Jenny’s browser voice is used only for simulated calls.':kind?.live?'This call is happening on the phone, so its words are shown here as text and not spoken in the browser.':status.data?.configured?`Jenny speaks the real transcript with the ${voiceLabel}.`:'No voice is connected, so the transcript is shown as text.'}</small></div></div><audio ref={setAudioElement} onEnded={()=>setSpoken(value=>value+1)} preload="none"/></DialogContent></Dialog>;
}

/** The test email's stages so far, each from an event that has arrived. */
function TestSteps({events,paymentId,call}:{events:RunEvent[];paymentId:string;call:CallView|undefined}){
 const steps:string[]=[];
 if(events.some(e=>e.type==='run.started'||e.type==='invoice.parsed'))steps.push('Email received');
 if(events.some(e=>e.type==='payment.held'&&e.payment_id===paymentId))steps.push(call?'Held: it asks to pay a new bank account':'Held');
 if(call?.contactSource)steps.push(SOURCE_TEXT[call.contactSource]);
 if(call&&call.phase!=='queued')steps.push(call.phase==='dialing'?'Calling':call.phase==='live'?'On the call':'Call ended');
 if(call?.outcome)steps.push(OUTCOME_TEXT[call.outcome].title);
 const last=[...events].reverse().find(e=>(e.type==='payment.paid'||e.type==='payment.held'||e.type==='payment.blocked')&&e.payment_id===paymentId);
 // The status the call led to: one decided at or after the outcome (a denial blocks), or the hold that stays for an unclear answer.
 const after=last&&call?.outcome&&(call.outcome==='unclear'||call.outcome==='no_answer'||(call.endedAt!=null&&last.at>=call.endedAt));
 if(after&&last)steps.push(STATUS_TEXT[last.type==='payment.paid'?'paid':last.type==='payment.held'?'held':'blocked']);
 if(steps.length===0)return null;
 return <ol className="jenny-test-steps">{steps.map(s=><li key={s}>{s}</li>)}</ol>;
}

/** After a finished run: reset the demo week and run Jenny on it again, live. A refused reset changes nothing and says so. */
function RunAgain({resetting,error,onRunAgain}:{resetting:boolean;error:string|null;onRunAgain:()=>void}){
 return <><button className="begin-jenny-call" onClick={onRunAgain} disabled={resetting}><RotateCcw size={17}/> {resetting?'Resetting the week…':'Run the week again'}</button>
  <small className="elevenlabs-connection">Resets the demo to the seeded week (the leaderboard is kept), then Jenny checks it again, live.</small>
  {error&&<p role="status" className="call-audio-error">The demo was not reset, so nothing changed. {error.replace(/\.?$/,'.')}</p>}</>;
}

function PhoneMessage({label,title,line}:{label:string;title:string;line:string}){
 return <div className="glass-call-phone"><div className="glass-phone-notch"/><div className="phone-top-clock"><span>Jenny</span><span/></div><span className="glass-phone-label">{label}</span><h3>{title}</h3><p>{line}</p><div className="jenny-calling-avatar"><JennyAvatar/></div><div className="phone-bottom-line"/></div>;
}

function Note({title,text,children}:{title:string;text:string;children?:ReactNode}){
 return <><span className="eyebrow">VENDOR VERIFICATION</span><h3>{title}</h3><p>{text}</p>{children}</>;
}

function RunCounts({paid,held,blocked}:{paid:number;held:number;blocked:number}){
 return <div className="call-transcript-card"><span><ShieldCheck size={14}/>So far in this run</span><p>{paid} paid · {held} on hold · {blocked} blocked</p></div>;
}
