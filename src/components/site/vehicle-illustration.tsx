// Side-view illustrations of the vehicle types for the public pages (owner feedback 2026-11-13: cards with
// text only looked bare). Pure inline SVG in the brand colours — no image files, no external requests.
//
// Picked by `size_rank` and not by vehicle code: the admin can add or rename vehicle types, so the
// rank (1 = smallest) is the only stable hint of the shape. Ranks above 5 reuse the truck.

type Kind = "car" | "van_small" | "van_medium" | "van_large" | "truck";

export function vehicleKind(sizeRank: number): Kind {
  if (sizeRank <= 1) return "car";
  if (sizeRank === 2) return "van_small";
  if (sizeRank === 3) return "van_medium";
  if (sizeRank === 4) return "van_large";
  return "truck";
}

const GROUND = 100;

function Wheel({ x, r = 11 }: { x: number; r?: number }) {
  const y = GROUND - r;
  return (
    <g>
      {/* wheel arch: same colour as the panel behind the drawing */}
      <circle cx={x} cy={y} r={r + 3} className="fill-brand-50" />
      <circle cx={x} cy={y} r={r} className="fill-zinc-800" />
      <circle cx={x} cy={y} r={r * 0.45} className="fill-zinc-300" />
    </g>
  );
}

function Shadow({ from, to }: { from: number; to: number }) {
  return <ellipse cx={(from + to) / 2} cy={GROUND + 1} rx={(to - from) / 2} ry={3} className="fill-brand-200" />;
}

function Car() {
  return (
    <>
      <Shadow from={28} to={210} />
      <path d="M32 88 L32 66 Q32 60 40 58 L52 42 Q55 38 62 38 L140 38 Q146 38 150 42 L170 60 L196 64 Q206 66 206 76 L206 88 Z" className="fill-brand-500" />
      <path d="M58 44 L102 44 L102 58 L50 58 Z" className="fill-brand-100" />
      <path d="M108 44 L140 44 Q143 44 146 47 L158 58 L108 58 Z" className="fill-brand-100" />
      <rect x="32" y="72" width="174" height="3" className="fill-accent-400" />
      <rect x="198" y="66" width="8" height="5" rx="2" className="fill-amber-200" />
      <rect x="32" y="62" width="4" height="6" rx="1" className="fill-red-400" />
      <Wheel x={64} />
      <Wheel x={172} />
    </>
  );
}

function VanSmall() {
  return (
    <>
      <Shadow from={30} to={212} />
      <path d="M34 88 L34 40 Q34 32 42 32 L150 32 Q158 32 162 38 L180 60 L200 66 Q208 68 208 78 L208 88 Z" className="fill-brand-500" />
      <path d="M150 40 L158 40 L174 60 L150 60 Z" className="fill-brand-100" />
      <path d="M118 40 L144 40 L144 60 L118 60 Z" className="fill-brand-100" />
      <path d="M114 36 L114 86" className="stroke-brand-700" strokeWidth="1.5" />
      <rect x="34" y="70" width="174" height="4" className="fill-accent-400" />
      <rect x="200" y="70" width="8" height="5" rx="2" className="fill-amber-200" />
      <rect x="34" y="40" width="4" height="10" rx="1" className="fill-red-400" />
      <Wheel x={66} />
      <Wheel x={178} />
    </>
  );
}

function VanMedium() {
  return (
    <>
      <Shadow from={16} to={226} />
      <path d="M20 88 L20 28 Q20 22 26 22 L170 22 Q178 22 182 30 L196 58 L214 64 Q222 66 222 76 L222 88 Z" className="fill-brand-500" />
      <path d="M172 32 L180 32 L190 58 L172 58 Z" className="fill-brand-100" />
      <path d="M140 28 L140 86 M166 28 L166 86" className="stroke-brand-700" strokeWidth="1.5" />
      <rect x="20" y="70" width="202" height="4" className="fill-accent-400" />
      <rect x="214" y="68" width="8" height="5" rx="2" className="fill-amber-200" />
      <rect x="20" y="30" width="4" height="12" rx="1" className="fill-red-400" />
      <Wheel x={54} />
      <Wheel x={190} />
    </>
  );
}

function VanLarge() {
  return (
    <>
      <Shadow from={10} to={228} />
      <rect x="12" y="84" width="212" height="5" className="fill-zinc-700" />
      <rect x="12" y="16" width="156" height="70" rx="4" className="fill-white stroke-brand-500" strokeWidth="3" />
      <rect x="12" y="66" width="156" height="5" className="fill-accent-400" />
      <path d="M172 88 L172 40 Q172 34 178 34 L198 34 Q204 34 206 40 L214 60 Q224 62 224 72 L224 88 Z" className="fill-brand-500" />
      <path d="M180 42 L198 42 L206 60 L180 60 Z" className="fill-brand-100" />
      <rect x="216" y="68" width="8" height="5" rx="2" className="fill-amber-200" />
      <Wheel x={46} />
      <Wheel x={196} />
    </>
  );
}

function Truck() {
  return (
    <>
      <Shadow from={4} to={234} />
      <rect x="24" y="80" width="208" height="7" className="fill-zinc-700" />
      <rect x="28" y="6" width="150" height="76" rx="4" className="fill-white stroke-brand-500" strokeWidth="3" />
      <rect x="28" y="62" width="150" height="5" className="fill-accent-400" />
      {/* tail lift, lowered */}
      <path d="M26 80 L12 94" className="stroke-zinc-500" strokeWidth="2" />
      <rect x="4" y="94" width="26" height="4" rx="1" className="fill-zinc-500" />
      <path d="M180 84 L180 26 Q180 18 188 18 L210 18 Q218 18 220 26 L226 52 Q234 54 234 64 L234 84 Z" className="fill-brand-500" />
      <path d="M188 26 L210 26 L218 50 L188 50 Z" className="fill-brand-100" />
      <rect x="226" y="66" width="8" height="6" rx="2" className="fill-amber-200" />
      <Wheel x={58} r={13} />
      <Wheel x={88} r={13} />
      <Wheel x={204} r={13} />
    </>
  );
}

const DRAWINGS: Record<Kind, () => React.ReactElement> = {
  car: Car,
  van_small: VanSmall,
  van_medium: VanMedium,
  van_large: VanLarge,
  truck: Truck,
};

export function VehicleIllustration({ sizeRank, className = "" }: { sizeRank: number; className?: string }) {
  const Drawing = DRAWINGS[vehicleKind(sizeRank)];
  return (
    <svg viewBox="0 0 240 106" className={className} aria-hidden="true" focusable="false">
      <Drawing />
    </svg>
  );
}
