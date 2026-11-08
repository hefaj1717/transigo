import { signOut } from "@/lib/auth/actions";

/** Signs out and goes to /accedi; with `next`, the sign-in page returns there afterwards. */
export function SignOutButton({ next, label = "Esci", className }: { next?: string; label?: string; className?: string }) {
  return (
    <form action={signOut}>
      {next ? <input type="hidden" name="next" value={next} /> : null}
      <button type="submit" className={className ?? "rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-50"}>
        {label}
      </button>
    </form>
  );
}
