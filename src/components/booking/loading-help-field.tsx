"use client";

import type { LoadingHelpChoice } from "@/lib/booking/state";
import { LOADING_HELP_MAX_HOURS } from "@/lib/pricing/types";

// D182: help at loading or at unloading — a checkbox; once ticked, persons (1–4) and hours (1–4, default 1 h).

const select = "mt-1 block w-32 rounded-md border border-zinc-300 px-3 py-2 text-sm text-zinc-900 outline-none focus:ring-2 focus:ring-blue-500";

export function LoadingHelpField({ id, label, value, onChange }: { id: string; label: string; value: LoadingHelpChoice | null; onChange: (v: LoadingHelpChoice | null) => void }) {
  return (
    <div className={`rounded-md border p-3 ${value ? "border-blue-600 bg-blue-50/50" : "border-zinc-200"}`}>
      <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-zinc-900">
        <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked ? { persons: 1, hours: 1 } : null)} />
        {label}
      </label>
      {value ? (
        <div className="mt-3 flex flex-wrap gap-4 pl-6">
          <div>
            <label htmlFor={`${id}-persons`} className="block text-sm text-zinc-700">Persone</label>
            <select id={`${id}-persons`} value={value.persons} onChange={(e) => onChange({ ...value, persons: Number(e.target.value) })} className={select}>
              {[1, 2, 3, 4].map((n) => (
                <option key={n} value={n}>{n === 1 ? "1 persona" : `${n} persone`}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={`${id}-hours`} className="block text-sm text-zinc-700">Ore</label>
            <select id={`${id}-hours`} value={value.hours} onChange={(e) => onChange({ ...value, hours: Number(e.target.value) })} className={select}>
              {Array.from({ length: LOADING_HELP_MAX_HOURS }, (_, i) => i + 1).map((h) => (
                <option key={h} value={h}>{h === 1 ? "1 ora" : `${h} ore`}</option>
              ))}
            </select>
          </div>
        </div>
      ) : null}
    </div>
  );
}
