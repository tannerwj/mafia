// serverNow-corrected deadline countdown (D1 pin: "drift-tolerant to ±2s").
// Ticks once a second off `serverNow()` (store/gameStore.ts's clock-offset
// helper), never raw `Date.now()`.
import { useEffect, useState } from "react";
import { serverNow } from "../../store/gameStore";

export default function DeadlineCountdown({ deadlineAt }: { deadlineAt: number | null }) {
  const [, setTick] = useState(0);

  useEffect(() => {
    if (deadlineAt === null) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [deadlineAt]);

  if (deadlineAt === null) {
    return (
      <span data-testid="phase-countdown" data-untimed="true" className="text-smoke">
        untimed
      </span>
    );
  }

  const remainingMs = deadlineAt - serverNow();
  const remainingSec = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(remainingSec / 60);
  const seconds = remainingSec % 60;
  const label = `${minutes}:${seconds.toString().padStart(2, "0")}`;

  return (
    <span
      data-testid="phase-countdown"
      data-remaining-sec={remainingSec}
      className={`tabular-nums ${remainingSec <= 5 ? "text-blood-hi" : "text-brass-hi"}`}
    >
      {label}
    </span>
  );
}
