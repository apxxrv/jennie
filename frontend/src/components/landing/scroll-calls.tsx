import { useEffect, useRef, useState } from "react";
import { JennyAvatar } from "@/components/shared/jenny-avatar";
import { Check, Pause, Phone, Play, Volume2 } from "lucide-react";

const CALLS = [
  { name: "Sarah at Summit", type: "VENDOR VERIFICATION", lines: [
    { who: "Jenny", text: "Hi Sarah, this is Jenny, the automated verification assistant calling for Ridgeline Builders. We received a request with new bank details for Summit Concrete. Did your team request that change?" },
    { who: "Sarah · Summit Concrete", text: "No, that's not from us. We haven't changed our bank account. Please don't pay that request." },
    { who: "Jenny", text: "Thanks, Sarah. I'll block that request and leave your verified account exactly as it is." },
  ] },
  { name: "Jonathan · Business owner", type: "OWNER BRIEFING", lines: [
    { who: "Jenny", text: "Hi Jonathan, it's Jenny. I checked the new request from Summit against the invoice history. The bank account and contact number were different from the details on file." },
    { who: "Jenny", text: "I called Sarah at their verified number. She confirmed they never requested a change. I've blocked the twenty thousand, one hundred and eighty-nine dollar payment." },
    { who: "Jonathan · Business owner", text: "Good catch. Thanks for checking with them first. I'll review the record in the dashboard." },
  ] },
];

export function ScrollCalls() {
  const root = useRef<HTMLElement>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const activeStage = useRef(0);
  const scrollLockUntil = useRef(0);
  const [stage, setStage] = useState(0);
  const [line, setLine] = useState(0);
  const [listening, setListening] = useState(false);
  const [audioError, setAudioError] = useState(false);

  useEffect(() => {
    const section = root.current;
    if (!section) return;
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        if (Date.now() < scrollLockUntil.current) return;
        const sections = Array.from(section.querySelectorAll<HTMLElement>('[data-step]'));
        const center = window.innerHeight * .5;
        const active = sections.find(el => { const rect=el.getBoundingClientRect(); return rect.top <= center && rect.bottom > center; });
        if (!active) return;
        const next = Number(active.dataset.step);
        if (activeStage.current !== next) { activeStage.current=next; setStage(next); setLine(0); setListening(false); }
        const rect=active.getBoundingClientRect();
        const progress = Math.max(0,Math.min(.999,(center-rect.top)/rect.height));
        if (audio.current?.paused !== false) setLine(Math.floor(progress*3));
      });
    };
    window.addEventListener('scroll',onScroll,{passive:true});
    onScroll();
    return () => { window.removeEventListener('scroll',onScroll); window.cancelAnimationFrame(frame); };
  }, []);

  useEffect(() => {
    const player = audio.current;
    if (!player) return;
    if (!listening) { player.pause(); return; }
    setAudioError(false);
    void player.play().catch(() => { setListening(false); setAudioError(true); });
    return () => player.pause();
  }, [stage, line, listening]);


  function toggleAudio() { setListening(value => !value); }
  function advance() { if (line < 2) setLine(line + 1); else setListening(false); }
  function select(next: number, play = false) { scrollLockUntil.current = Date.now() + 1600; activeStage.current = next; setStage(next); setLine(0); setListening(play); document.getElementById(`call-step-${next}`)?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'center' }); }
  const current = CALLS[stage];
  return <section ref={root} className="scroll-call-story" id="verification" aria-label="How verification works">
    <div className="call-story-heading"><span className="eyebrow">TWO CALLS. NOTHING LEFT TO CHANCE.</span><h2>Jenny makes the call.<br />You get the full story.</h2><p>Scroll through the example to hear how Jenny checks with the vendor and explains the outcome to the owner.</p></div>
    <div className="call-story-grid">
      <div className="call-story-steps">
        <article data-step="0" id="call-step-0"><span className="story-step-number">01 / VERIFY</span><h3>Jenny checks the change with someone you already trust.</h3><p>A request arrives under a familiar vendor name, but the bank details have changed. Jenny compares it with the invoice history and calls Sarah through a verified contact, rather than the new number supplied in the email.</p><blockquote>“We haven’t changed our bank account.”</blockquote><span className="story-outcome"><Check size={15} /> Vendor denies the change</span><button className="story-listen" onClick={() => { select(0, true); }}><Volume2 size={17} /> Listen to the vendor call</button></article>
        <article data-step="1" id="call-step-1"><span className="story-step-number">02 / INFORM</span><h3>Jenny calls Jonathan to explain what happened and how she protected the payment.</h3><p>In this example, Jenny informs Jonathan, the business owner, about the suspicious request. She explains which details changed, what Sarah confirmed, and why she blocked the payment. Jonathan can review the complete record in his inbox.</p><blockquote>“I checked with Sarah. They never requested it.”</blockquote><span className="story-outcome"><Check size={15} /> Suspicious request blocked</span><button className="story-listen" onClick={() => { select(1, true); }}><Volume2 size={17} /> Hear Jenny inform Jonathan</button></article>
      </div>
      <div className="call-story-visual"><div className="sticky-call-stage">
        <div className="call-step-switch" aria-label="Choose a call"><button aria-pressed={stage === 0} onClick={() => select(0)}>01 Vendor</button><span /><button aria-pressed={stage === 1} onClick={() => select(1)}>02 Inform Jonathan</button></div>
        <div className="call-dialogue"><div className="dialogue-meta"><span className={listening ? 'live-wave-dot' : ''} />{listening ? 'Playing conversation' : 'Conversation preview'}<span>{String(line + 1).padStart(2,'0')} / 03</span></div><div className="dialogue-bars" aria-hidden>{Array.from({length:23},(_,i)=><i key={i} style={{height:12+(i*17%23),animationDelay:`${i*.06}s`}} />)}</div><div className={`gloss-dialogue ${line === 1 && stage === 0 ? 'vendor-speaking' : ''}`} aria-live="polite"><span>{current.lines[line].who}</span><p>“{current.lines[line].text}”</p></div><div className="dialogue-footer"><div>{current.lines.map((_,i)=><button key={i} aria-label={`Conversation part ${i+1}`} aria-pressed={i === line} onClick={()=>setLine(i)} />)}</div><button className="audio-toggle" onClick={toggleAudio} aria-label={listening ? 'Pause conversation audio' : 'Play conversation audio'}>{listening ? <Pause size={16}/> : <Play size={16}/>} {listening ? 'Pause' : 'Listen'}</button></div>{audioError && <p role="status" className="audio-error">Audio could not start. Tap Listen to try again.</p>}</div>
        <div className="half-phone-crop"><div className="half-phone"><div className="half-phone-island"/><div className="half-phone-top"><span>9:41</span><span>▮▮▮ ▰</span></div><span className="phone-caption">{current.type}</span><h4>{current.name}</h4><span className="half-phone-connected"><Phone size={12}/> Verified contact</span>{stage === 1 ? <img className="owner-call-photo" src="/images/jonathan-owner.png" alt="Jonathan, the business owner in this example"/> : <JennyAvatar className="story-jenny-avatar"/>}<span className="phone-brand">Jenny / Countersign</span></div></div>
        <p className="call-demo-note">Illustrative conversations · No real calls placed.<br />Owner briefing is a proposed experience.</p>
        <audio ref={audio} src={`/audio/jenny-${stage}-${line}.mp3`} onEnded={advance} preload="auto" />
      </div></div>
    </div>
  </section>;
}
