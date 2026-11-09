import Link from "next/link";

/**
 * Text logo: navy "TRANSi" + green "GO" (brand/accent tokens in globals.css).
 * `onDark` for navy backgrounds (footer): "TRANSi" turns white, "GO" stays green.
 */
export function Logo({ onDark = false, className = "" }: { onDark?: boolean; className?: string }) {
  return (
    <span className={`inline-flex items-baseline text-2xl font-extrabold leading-none tracking-tight select-none ${className}`}>
      <span className={onDark ? "text-white" : "text-brand-800"}>TRANSi</span>
      <span className={onDark ? "text-accent-400" : "text-accent-500"}>GO</span>
    </span>
  );
}

export function LogoLink({ onDark = false }: { onDark?: boolean }) {
  return (
    <Link href="/" aria-label="Transigo – pagina iniziale" className="rounded focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent-500">
      <Logo onDark={onDark} />
    </Link>
  );
}
