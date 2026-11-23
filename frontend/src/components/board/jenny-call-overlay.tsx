import { useEffect, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { JennyAvatar } from '@/components/shared/jenny-avatar';
import { API_URL } from '@/lib/api-url';
import { Mic, Pause, Phone, PhoneOff, Play, ShieldCheck, Volume2 } from 'lucide-react';

export const CALL_CASES=[
 {vendor:'Summit Concrete',contact:'Sarah',number:'Verified contact · •••• 0100',outcome:'Vendor denied the change',summary:'The suspicious request is blocked. The verified bank account stays unchanged.',lines:[
  {speaker:'Jenny',text:"Hi Sarah, it's Jenny, the automated verification assistant for Ridgeline Builders. We received a payment request from Summit Concrete with a different bank account. Did your team ask us to make that change?"},
  {speaker:'Sarah · Summit Concrete',text:"No, that wasn't us. We haven't changed our bank account. Please don't send anything to that new account."},
  {speaker:'Jenny',text:"Thank you, Sarah. I'll block the suspicious request and keep your verified bank details unchanged. I'll leave the full record for the owner to review."}
 ]},
 {vendor:'Northside Rentals',contact:'Northside accounts team',number:'Verified contact · •••• 0125',outcome:'The answer needs a human review',summary:'The payment stays on hold. An uncertain answer is never permission to pay.',lines:[
  {speaker:'Jenny',text:"Hi, this is Jenny, the automated verification assistant calling for Ridgeline Builders. A request for Northside Rentals asks us to pay a new bank account. Can you confirm whether your team requested that change?"},
  {speaker:'Northside Rentals',text:"I'm sorry, I'm not sure. I don't handle our banking details, and I can't confirm that request for you."},
  {speaker:'Jenny',text:"That's all right. I'll keep the payment on hold and ask the owner to review it. We won't use the new account until the change has been verified."}
 ]}
];
export function JennyCallOverlay({open,onOpenChange}:{open:boolean;onOpenChange:(value:boolean)=>void}) {
 const [caseIndex,setCaseIndex]=useState(0);
 const [line,setLine]=useState(0);
 const [playing,setPlaying]=useState(false);
 const [complete,setComplete]=useState(false);
 const [configured,setConfigured]=useState(false);
 const [provider,setProvider]=useState('Demo voice');
 const [loading,setLoading]=useState(false);
 const [error,setError]=useState('');
 const [audioElement,setAudioElement]=useState<HTMLAudioElement|null>(null);
 const generation=useRef(0);
 const scene=CALL_CASES[caseIndex];
 useEffect(()=>{if(!open)return;setLine(0);setComplete(false);setPlaying(true);setError('');void fetch(`${API_URL}/api/jenny/voice/status`).then(r=>r.ok?r.json():null).then(data=>setConfigured(Boolean(data?.configured))).catch(()=>setConfigured(false));},[open]);
 useEffect(()=>{
  const player=audioElement;
  if(!open||!playing||!player){player?.pause();return;}
  const id=++generation.current;
  const controller=new AbortController();
  let blob:string|undefined;
  setLoading(true);setError('');
  async function play(){
   let source=`/audio/inbox-${caseIndex}-${line}.mp3`;
   let voice='Demo voice';
   if(configured && scene.lines[line].speaker==='Jenny'){
    try{const response=await fetch(`${API_URL}/api/jenny/voice`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:scene.lines[line].text}),signal:controller.signal});if(!response.ok)throw new Error();blob=URL.createObjectURL(await response.blob());source=blob;voice='ElevenLabs';}catch{if(controller.signal.aborted)return;voice='Demo voice · ElevenLabs unavailable';}
   }
   if(controller.signal.aborted||generation.current!==id||!player)return;
   setProvider(voice);player.src=source;
   try{await player.play();setLoading(false);}catch{if(!controller.signal.aborted){setError('Audio could not start. Press play to try again.');setLoading(false);setPlaying(false);}}
  }
  void play();
  return ()=>{controller.abort();player.pause();if(blob)URL.revokeObjectURL(blob);};
 },[open,playing,line,caseIndex,configured,scene,audioElement]);
 function nextLine(){if(line<2)setLine(line+1);else{setPlaying(false);setComplete(true);}}
 function choose(value:number){setPlaying(false);setCaseIndex(value);setLine(0);setComplete(false);setError('');}
 return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="jenny-call-dialog" aria-describedby="jenny-call-description"><div className="call-overlay-head"><JennyAvatar/><div><DialogTitle>Jenny is checking a payment request</DialogTitle><p id="jenny-call-description">Voice demonstration over your inbox · No real phone call</p></div><span className="call-demo-pill">Demo</span></div><div className="inbox-call-layout"><div className="glass-call-phone"><div className="glass-phone-notch"/><div className="phone-top-clock"><span>9:41</span><span>▮▮▮ ▰</span></div><span className="glass-phone-label">{complete?'VERIFICATION COMPLETE':playing?'VERIFICATION IN PROGRESS':'READY TO VERIFY'}</span><h3>{scene.vendor}</h3><p>{scene.number}</p><div className={`jenny-calling-avatar ${playing?'is-talking':''}`}><JennyAvatar/></div><span className="calling-person">{complete?scene.outcome:playing?`Speaking with ${scene.contact}`:`Calling ${scene.contact}`}</span><div className={`overlay-wave ${playing?'is-speaking':''}`} aria-label={playing?'Speaking':'Ready'}>{Array.from({length:21},(_,i)=><i key={i} style={{height:10+(i*19%30),animationDelay:`${i*.06}s`}}/>)}</div><div className="glass-phone-controls"><button aria-label={playing?'Pause Jenny call':'Play Jenny call'} onClick={()=>{if(complete){setComplete(false);setLine(0);}setPlaying(!playing);}}>{playing?<Pause size={21}/>:<Play size={21}/>}</button><button className="end-jenny-call" aria-label="End Jenny demonstration" onClick={()=>onOpenChange(false)}><PhoneOff size={21}/></button><span><Volume2 size={19}/></span></div><span className="phone-audio-provider">{loading?'Preparing audio…':provider}</span><div className="phone-bottom-line"/></div><div className="call-overlay-conversation"><span className="eyebrow">VENDOR VERIFICATION</span><h3>A direct question.<br/>An answer on record.</h3><p>Jenny checks with the contact on file instead of trusting the replacement number in the email.</p><label className="call-vendor-picker">Choose an example<select value={caseIndex} onChange={e=>choose(Number(e.target.value))}>{CALL_CASES.map((item,i)=><option key={item.vendor} value={i}>{item.vendor}</option>)}</select></label><div className="call-transcript-card" aria-live="polite"><span><Mic size={14}/>{scene.lines[line].speaker}<small>{line+1} / 3</small></span><p>“{scene.lines[line].text}”</p></div><div className="call-line-controls">{scene.lines.map((_,i)=><button key={i} aria-label={`Play conversation turn ${i+1}`} aria-pressed={line===i} onClick={()=>{setLine(i);setComplete(false);setPlaying(true);}}/>)}</div>{complete?<div className="call-demo-result"><ShieldCheck size={19}/><div><strong>{scene.outcome}</strong><p>{scene.summary}</p><small>Illustrative outcome. This demo does not change payment records.</small></div></div>:<button className="begin-jenny-call" onClick={()=>setPlaying(value=>!value)}>{playing?<Pause size={17}/>:<Phone size={17}/>} {playing?'Pause conversation':'Start conversation'}</button>}{error&&<p role="status" className="call-audio-error">{error}</p>}<small className="elevenlabs-connection">{configured?'Jenny’s voice is connected to ElevenLabs.':'ElevenLabs integration is ready. This preview uses bundled voices until an account is connected.'}</small></div></div><audio ref={setAudioElement} onEnded={nextLine} preload="none"/></DialogContent></Dialog>;
}
