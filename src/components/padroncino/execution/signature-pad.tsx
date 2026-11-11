"use client";

import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { isSignatureEnough, type Point } from "@/lib/carriers/execution-ui";

export type SignaturePadHandle = { toBlob: () => Promise<Blob | null>; clear: () => void };

const HEIGHT = 200; // CSS px

/**
 * Finger signature (own canvas, no library): pointer events (touch, pen, mouse — iPhone and Android),
 * `touch-action: none` so the page does not scroll while signing, sharp on high-DPI screens. Strokes are kept in
 * CSS pixels and redrawn after a resize / rotation. "Cancella" clears. Exported as PNG.
 */
export function SignaturePad({ ref, onChange, disabled }: { ref?: Ref<SignaturePadHandle>; onChange: (enough: boolean) => void; disabled?: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const strokes = useRef<Point[][]>([]);
  const drawing = useRef<number | null>(null);
  const [empty, setEmpty] = useState(true);

  /** 2D context in CSS pixels with the pen style (canvas resized to the screen first when needed). */
  const pen = useCallback((): { ctx: CanvasRenderingContext2D; width: number } | null => {
    const c = canvas.current;
    if (!c) return null;
    const dpr = window.devicePixelRatio || 1;
    const width = c.clientWidth;
    if (c.width !== Math.round(width * dpr) || c.height !== Math.round(HEIGHT * dpr)) {
      c.width = Math.round(width * dpr);
      c.height = Math.round(HEIGHT * dpr);
    }
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#111827";
    return { ctx, width };
  }, []);

  /** Full redraw — only on resize / rotation, clear and a new stroke; moves draw just the new segment. */
  const redraw = useCallback(() => {
    const p = pen();
    if (!p) return;
    const { ctx, width } = p;
    ctx.clearRect(0, 0, width, HEIGHT);
    for (const s of strokes.current) {
      ctx.beginPath();
      s.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      if (s.length === 1) ctx.lineTo(s[0].x + 0.1, s[0].y + 0.1);
      ctx.stroke();
    }
  }, [pen]);

  /** The points added to the current stroke since `from` (its previous last point) — constant work per move. */
  const drawSegment = useCallback((from: Point, added: readonly Point[]) => {
    const p = pen();
    if (!p || !added.length) return;
    p.ctx.beginPath();
    p.ctx.moveTo(from.x, from.y);
    for (const pt of added) p.ctx.lineTo(pt.x, pt.y);
    p.ctx.stroke();
  }, [pen]);

  useEffect(() => {
    redraw();
    const c = canvas.current;
    if (!c || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => redraw());
    ro.observe(c);
    return () => ro.disconnect();
  }, [redraw]);

  const changed = useCallback(() => {
    setEmpty(strokes.current.length === 0);
    onChange(isSignatureEnough(strokes.current));
  }, [onChange]);

  const clear = useCallback(() => {
    strokes.current = [];
    redraw();
    changed();
  }, [redraw, changed]);

  useImperativeHandle(ref, () => ({
    clear,
    toBlob: () => new Promise((resolve) => (canvas.current ? canvas.current.toBlob(resolve, "image/png") : resolve(null))),
  }), [clear]);

  const point = (e: React.PointerEvent<HTMLCanvasElement>): Point => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  return (
    <div>
      <div className="relative rounded-xl border-2 border-zinc-300 bg-white">
        <canvas
          ref={canvas}
          data-testid="signature-pad"
          aria-label="Riquadro per la firma del destinatario"
          role="img"
          className="block w-full touch-none select-none"
          style={{ height: HEIGHT }}
          onPointerDown={(e) => {
            if (disabled) return;
            e.preventDefault();
            e.currentTarget.setPointerCapture(e.pointerId);
            drawing.current = e.pointerId;
            strokes.current.push([point(e)]);
            redraw();
          }}
          onPointerMove={(e) => {
            if (drawing.current !== e.pointerId) return;
            const events = typeof e.nativeEvent.getCoalescedEvents === "function" ? e.nativeEvent.getCoalescedEvents() : [];
            const last = strokes.current[strokes.current.length - 1];
            const from = last[last.length - 1];
            const r = e.currentTarget.getBoundingClientRect();
            const added = events.length ? events.map((ev) => ({ x: ev.clientX - r.left, y: ev.clientY - r.top })) : [point(e)];
            last.push(...added);
            drawSegment(from, added);
          }}
          onPointerUp={(e) => {
            if (drawing.current !== e.pointerId) return;
            drawing.current = null;
            changed();
          }}
          onPointerCancel={() => {
            drawing.current = null;
            changed();
          }}
        />
        {empty ? (
          <span aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-zinc-400">
            Firma qui con il dito
          </span>
        ) : null}
        <span aria-hidden className="pointer-events-none absolute inset-x-6 bottom-8 border-b border-dashed border-zinc-300" />
      </div>
      <button type="button" onClick={clear} disabled={disabled || empty} className="mt-2 min-h-11 rounded-lg px-3 text-sm font-semibold text-[#0B3B8C] underline disabled:opacity-40">
        Cancella
      </button>
    </div>
  );
}
