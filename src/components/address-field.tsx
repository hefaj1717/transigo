"use client";

import { useEffect, useRef, useState } from "react";
import type { PlaceChoice } from "@/lib/booking/state";

type Suggestion = { placeId: string; text: string; mainText: string; secondaryText: string };

/**
 * Address with Google Places autocomplete through /api/maps/autocomplete (server key, Italy only — D61).
 * Only the place ID and the suggestion text are kept; the server resolves the place again for the quote.
 */
export function AddressField({
  id,
  label,
  value,
  onChange,
  externalError,
}: {
  id: string;
  label: string;
  value: Pick<PlaceChoice, "placeId" | "label"> | null;
  onChange: (place: Pick<PlaceChoice, "placeId" | "label"> | null) => void;
  /** Validation message from the parent form (shown under the field). */
  externalError?: string | null;
}) {
  const [text, setText] = useState(value?.label ?? "");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const session = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep the text in sync when the value changes from outside (e.g. restored state).
  const [lastLabel, setLastLabel] = useState(value?.label ?? "");
  if ((value?.label ?? "") !== lastLabel) {
    setLastLabel(value?.label ?? "");
    setText(value?.label ?? "");
  }

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  function search(input: string) {
    if (timer.current) clearTimeout(timer.current);
    if (input.trim().length < 3) {
      setSuggestions([]);
      return;
    }
    timer.current = setTimeout(async () => {
      session.current ??= crypto.randomUUID();
      try {
        const res = await fetch("/api/maps/autocomplete", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ input, sessionToken: session.current }),
        });
        const json = await res.json();
        if (!res.ok) {
          setError(json.message ?? "Servizio mappe non disponibile.");
          setSuggestions([]);
          return;
        }
        setError(null);
        setSuggestions(json.suggestions ?? []);
        setOpen(true);
      } catch {
        setError("Servizio mappe non disponibile. Riprova tra poco.");
      }
    }, 300);
  }

  return (
    <div className="relative">
      <label htmlFor={id} className="block text-sm font-medium text-zinc-800">
        {label} <span className="text-red-600">*</span>
      </label>
      <input
        id={id}
        type="text"
        autoComplete="off"
        value={text}
        placeholder="Via, numero civico, città"
        onChange={(e) => {
          setText(e.target.value);
          if (value) onChange(null); // typing invalidates the chosen place
          search(e.target.value);
        }}
        onFocus={() => suggestions.length && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-invalid={externalError ? true : undefined}
        className="mt-1 block w-full rounded-md border border-zinc-300 px-3 py-2 text-zinc-900 outline-none focus:ring-2 focus:ring-brand-500"
      />
      {value ? <p className="mt-1 text-xs text-accent-700">Indirizzo selezionato</p> : text.length >= 3 ? <p className="mt-1 text-xs text-zinc-500">Seleziona un indirizzo dall&apos;elenco.</p> : null}
      {error ? <p className="mt-1 text-sm text-red-600">{error}</p> : null}
      {externalError && !error ? <p className="mt-1 text-sm text-red-600">{externalError}</p> : null}
      {open && suggestions.length ? (
        <ul id={`${id}-list`} role="listbox" className="absolute z-10 mt-1 max-h-64 w-full overflow-auto rounded-md border border-zinc-200 bg-white shadow-lg">
          {suggestions.map((s) => (
            <li key={s.placeId} role="option" aria-selected={value?.placeId === s.placeId}>
              <button
                type="button"
                className="block w-full px-3 py-2 text-left text-sm hover:bg-brand-50"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onChange({ placeId: s.placeId, label: s.text });
                  setText(s.text);
                  setOpen(false);
                  session.current = null; // a selection ends the Places session
                }}
              >
                <span className="font-medium text-zinc-900">{s.mainText}</span> <span className="text-zinc-500">{s.secondaryText}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
