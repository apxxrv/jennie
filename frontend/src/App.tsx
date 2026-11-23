import { useEffect } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AppShell } from "@/components/shared/app-shell";
import { LANDING_ONLY } from "@/lib/landing";
import { About } from "@/pages/About";
import { AttackConsole } from "@/pages/AttackConsole";
import { CallView } from "@/pages/CallView";
import { Home } from "@/pages/Home";
import { Board } from "@/pages/Board";
import { DesignCheck } from "@/pages/DesignCheck";
import { Inbox } from "@/pages/Inbox";
import { Leaderboard } from "@/pages/Leaderboard";
import { NotFound } from "@/pages/NotFound";
import { PaymentDetail } from "@/pages/PaymentDetail";
import { RedTeam } from "@/pages/RedTeam";
import { SystemStatus } from "@/pages/SystemStatus";

function ScrollToLocation() {
 const {pathname,hash}=useLocation();
 useEffect(()=>{
  const frame=window.requestAnimationFrame(()=>{
   const target=hash ? document.getElementById(decodeURIComponent(hash.slice(1))) : null;
   if(target) target.scrollIntoView({block:'start',behavior:'instant'});
   else window.scrollTo({top:0,behavior:'instant'});
  });
  return ()=>window.cancelAnimationFrame(frame);
 },[pathname,hash]);
 return null;
}

export function App() {
  // The landing-only build (deploy/landing) is the project page alone, full screen, at every path.
  if (LANDING_ONLY) {
    return (
      <BrowserRouter>
        <ScrollToLocation />
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    );
  }
  return (
    <BrowserRouter>
        <ScrollToLocation />
      <Routes>
        <Route path="/" element={<Home />} />
        <Route element={<AppShell />}>
          <Route path="/dashboard" element={<Board />}>
            <Route path="payments/:paymentId" element={<PaymentDetail />} />
          </Route>
          <Route path="/payments/:paymentId" element={<Board />}><Route index element={<PaymentDetail />} /></Route>
          <Route path="/inbox" element={<Inbox />} />
          <Route path="/attack" element={<AttackConsole />} />
          <Route path="/red-team" element={<RedTeam />} />
          <Route path="/status" element={<SystemStatus />} />
          {/* The project page for judges and sponsors, inside the app like every other page (DESIGN.md, Project page). */}
          <Route path="/about" element={<About />} />
          <Route path="*" element={<NotFound />} />
        </Route>
        {/* Full screen, no shell: the verification call as a phone-sized live view, beside the board or in the video. */}
        <Route path="/call" element={<CallView />} />
        {/* Full screen, no shell: second display. */}
        <Route path="/leaderboard" element={<Leaderboard />} />
        {/* A developer page: the design tokens rendered. Not in the product build. */}
        {import.meta.env.DEV && <Route path="/design-check" element={<DesignCheck />} />}
      </Routes>
    </BrowserRouter>
  );
}
