import { LEG_STEPS, STEP_DONE_LABEL, type ExecLeg, type StepRecord } from "@/lib/carriers/execution";
import { romeTime } from "@/lib/carriers/jobs";

/** Steps of every leg: done (with the database time, Europe/Rome) or still to do. */
export function StepTimeline({ legs, steps }: { legs: readonly ExecLeg[]; steps: readonly StepRecord[] }) {
  const multi = legs.length > 1;
  return (
    <div className="space-y-4">
      {legs.map((leg) => (
        <div key={leg.legIndex}>
          {multi ? <p className="mb-1 text-sm font-semibold text-zinc-900">Tratta {leg.legIndex + 1}</p> : null}
          <ol className="space-y-1">
            {LEG_STEPS.map((s) => {
              const done = steps.find((r) => r.legIndex === leg.legIndex && r.step === s);
              return (
                <li key={s} className="flex items-center gap-2 text-sm">
                  <span aria-hidden className={`flex size-5 shrink-0 items-center justify-center rounded-full text-xs ${done ? "bg-green-700 text-white" : "border border-zinc-300 bg-white"}`}>
                    {done ? "✓" : ""}
                  </span>
                  <span className={done ? "text-zinc-900" : "text-zinc-500"}>{STEP_DONE_LABEL[s]}</span>
                  {done ? <span className="ml-auto text-zinc-600 tabular-nums">{romeTime(done.createdAt)}</span> : null}
                  <span className="sr-only">{done ? "fatto" : "da fare"}</span>
                </li>
              );
            })}
          </ol>
        </div>
      ))}
    </div>
  );
}
