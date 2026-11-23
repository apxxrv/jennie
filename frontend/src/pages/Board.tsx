import { useMemo, useState } from "react";
import { Link, Outlet } from "react-router-dom";
import { Play } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { JennyInbox } from "@/components/board/jenny-inbox";
import { ActivityRail } from "@/components/board/activity-rail";
import { formatUSD } from "@/lib/format";
import { PinnedAttack } from "@/components/board/pinned-attack";
import { RunHeader } from "@/components/board/run-header";
import { iconProps } from "@/components/shared/icon";
import { useCurrentRun } from "@/components/shared/run-context";
import { errorMessage } from "@/lib/api-error";
import { foldBoard } from "@/lib/board";
import { foldCalls } from "@/lib/calls";

export function Board() {
  const { runId, events, summary, startRun, runFailed, pinned, pinnedEvents, unpin } = useCurrentRun();
  const [starting, setStarting] = useState(false);
  const board = useMemo(() => foldBoard(events), [events]);
  const attack = useMemo(() => foldBoard(pinnedEvents, { attack: true }), [pinnedEvents]);
  const calls = useMemo(() => [...foldCalls(pinnedEvents), ...foldCalls(events)], [events, pinnedEvents]);
  // The pinned attack's lines join the run's, in time order, so the rail tells one story.
  const activity = useMemo(
    () => (attack.activity.length ? [...board.activity, ...attack.activity].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)) : board.activity),
    [board.activity, attack.activity],
  );
  const running = Boolean(runId) && !summary.completed && !runFailed;

  async function start() {
    setStarting(true);
    try {
      await startRun();
    } catch (err) {
      toast.error("Payment run not started", { description: errorMessage(err) });
    } finally {
      setStarting(false);
    }
  }

  const attention = board.rows.filter(row => row.status === "held" || row.stage === "calling");
  // Blocked payments need no decision (approve takes held payments only), but each one opens its evidence.
  const blocked = board.rows.filter(row => row.status === "blocked" && row.stage !== "calling");

  return (
    <div className="payment-board flex flex-col lg:h-[calc(100dvh/var(--present-zoom)-3rem)]">


      {runId || pinned ? <>
        {pinned && <PinnedAttack pinned={pinned} events={pinnedEvents} rows={attack.rows} onUnpin={unpin} />}

        <JennyInbox />
        {runId && <details className="review-queue-details"><summary>{attention.length} payment{attention.length === 1 ? "" : "s"} waiting for your decision{blocked.length ? ` · ${blocked.length} blocked` : ""}</summary><section className="decision-queue"><div className="queue-heading"><div><h2>{attention.length ? "A quick decision from you." : "You’re all caught up."}</h2><p>{attention.length ? "These payments are on hold. Open a request to review the evidence." : running ? "We’ll bring anything unusual here as we check your invoices." : "No payments are waiting for your approval."}</p></div><span className="queue-count">{attention.length} to review</span></div>{attention.map(row=><Link className="review-request" key={row.paymentId} to={`/payments/${row.paymentId}`}><span className="request-avatar">{row.vendor[0]}</span><div><strong>{row.vendor}</strong><p>{row.stage === "calling" ? "Calling the verified vendor contact" : row.callOutcome === "unclear" ? "Vendor’s answer was unclear. Your review is needed." : row.reason || "Payment details need a second look."}</p></div><span className="request-amount">{formatUSD(row.amount)}</span><span className="review-request-action">Review request</span></Link>)}{blocked.map(row=><Link className="review-request review-request-blocked" key={row.paymentId} to={`/payments/${row.paymentId}`}><span className="request-avatar">{row.vendor[0]}</span><div><strong>{row.vendor} <span className="review-blocked-tag">Blocked</span></strong><p>{row.reason || "Blocked. Nothing was paid."}</p></div><span className="request-amount">{formatUSD(row.amount)}</span><span className="review-request-action">See why</span></Link>)}</section></details>}
        <details className="workspace-audit"><summary>Verification calls & activity log <span>{calls.length} calls · {activity.length} events</span></summary><ActivityRail entries={activity} calls={calls} hasRun /></details>
      </> : <><StartPrompt starting={starting} onStart={start} /><JennyInbox /></>}

      <details className="workspace-run-settings" open><summary>Payment overview & invoice review</summary>
      <RunHeader
        rows={board.rows}
        invoiceCount={board.invoiceCount}
        startedAt={board.startedAt}
        hasRun={Boolean(runId)}
        running={running}
        starting={starting}
        onStart={start}
      />
      </details>

      {/* Payment detail drawer renders here at /payments/:paymentId. */}
      <Outlet />
    </div>
  );
}

function StartPrompt({ starting, onStart }: { starting: boolean; onStart: () => void }) {
  return (
    <div className="dashboard-start">
      <div className="start-emblem"><Play size={24} /></div>
      <span className="eyebrow">READY WHEN YOU ARE</span>
      <h2>A good day to pay with confidence.</h2>
      <p className="text-base">40 invoices are ready for review. We’ll check the details and verify suspicious changes before any payment is released.</p>
      <Button variant="primary" onClick={onStart} disabled={starting}>
        <Play {...iconProps} />
        {starting ? "Starting run…" : "Start payment run"}
      </Button>
      <div className="dashboard-assurances"><span>Invoice checks</span><span>Vendor verification</span><span>Complete audit trail</span></div>
    </div>
  );
}
