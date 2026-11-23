import { useCallback, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { JennyAvatar } from '@/components/shared/jenny-avatar';
import { useCurrentRun } from '@/components/shared/run-context';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/api-error';
import { CARDS } from '@/lib/attack-cards';
import { Mail, Phone } from 'lucide-react';

// "Send a test scam email": the Attack console's "We changed banks" card, sent from the Jenny inbox. The attack runs as its own
// mini-run; with Twilio live the server really phones the vendor's verified number (which only reaches the allow-listed demo phone).

const CARD=CARDS.find(c=>c.id==='classic_bank_change');
export const TEST_ATTACKER='Jenny test';

/** The test attack this tab sent, as the server answered. */
export interface TestLaunch {runId:string;paymentId:string;queued:boolean;position:number}

export function useTestScam(){
 const {pinAttack}=useCurrentRun();
 const queryClient=useQueryClient();
 const [sending,setSending]=useState(false);
 const [error,setError]=useState<string|null>(null);
 const [launched,setLaunched]=useState<TestLaunch|null>(null);
 const send=useCallback(async()=>{
  if(!CARD){setError('The “We changed banks” card is missing from this build.');return;}
  setSending(true);setError(null);setLaunched(null);
  try{
   const p=CARD.payload;
   // The same request the Attack console builds from this card.
   const res=await api.launchAttack({attacker_name:TEST_ATTACKER,card:CARD.id,source:'console',payload:{thread_id:p.thread_id,from_addr:p.from_addr.trim(),...(p.reply_to.trim()?{reply_to:p.reply_to.trim()}:{}),subject:p.subject.trim()||'(no subject)',body:p.body}});
   pinAttack({runId:res.run_id,paymentId:res.payment_id,attackId:res.attack_id,attackerName:TEST_ATTACKER,card:CARD.id});
   setLaunched({runId:res.run_id,paymentId:res.payment_id,queued:res.queued,position:res.position});
   void queryClient.invalidateQueries({queryKey:['inbox','threads']});
  }catch(err){setError(errorMessage(err));}
  finally{setSending(false);}
 },[pinAttack,queryClient]);
 return {send,sending,error,launched};
}

/** The confirm step. Nothing is sent until "Send it". What it promises about the call comes from GET /api/system/status. */
export function TestScamConfirm({open,onOpenChange,onConfirm}:{open:boolean;onOpenChange:(value:boolean)=>void;onConfirm:()=>void}){
 const status=useQuery({queryKey:['system-status'],queryFn:api.systemStatus,enabled:open,staleTime:10_000,retry:false});
 const call=status.data?.find(c=>c.name.startsWith('Verification call'));
 const realCall=call?call.mode==='real':null;
 const callText=realCall===true
  ?'Jenny will then place a real phone call to the approved demo phone. Whoever answers should say whether Summit Concrete changed banks.'
  :realCall===false
   ?'The verification call will be simulated: nothing will be dialed, and the call’s answer is scripted.'
   :status.isPending?'Checking whether the verification call will be real…':'We could not check whether the verification call will be real or simulated.';
 return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="jenny-call-dialog jenny-test-confirm"><div className="call-overlay-head"><JennyAvatar/><div><DialogTitle>Send a test scam email?</DialogTitle><p>{realCall===true?'Live call':realCall===false?'Simulated call':'Verification call'}</p></div></div>
  <div className="jenny-test-confirm-body"><DialogDescription>This sends a fake “we changed banks” email from a lookalike Summit Concrete address ({CARD?.payload.from_addr}) into the payment inbox.</DialogDescription><p>{callText}</p>
   <div className="jenny-test-confirm-actions"><button className="jenny-test-scam" onClick={()=>onOpenChange(false)}>Cancel</button><button className="begin-jenny-call" disabled={status.isPending} onClick={onConfirm}><Mail size={17}/> Send it{realCall===true&&<> and call <Phone size={15}/></>}</button></div></div></DialogContent></Dialog>;
}
