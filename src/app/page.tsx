import Link from "next/link";

// Temporary home page (the public site is Stage 2).
export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 px-4 py-16 text-center">
      <h1 className="text-3xl font-semibold text-zinc-900">Transigo</h1>
      <p className="text-zinc-600">Trasporti, facchinaggio, imballaggio e deposito merci.</p>
      <div className="flex gap-3">
        <Link href="/accedi" className="rounded-md border border-zinc-300 px-4 py-2 font-medium text-zinc-800 hover:bg-zinc-50">Accedi</Link>
        <Link href="/registrati" className="rounded-md bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700">Registrati</Link>
      </div>
    </main>
  );
}
