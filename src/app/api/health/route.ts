import { NextResponse } from "next/server";
import { getSupabaseEnv } from "@/lib/supabase/env";

// Simple connectivity check: verifies that the Supabase URL and anon key are valid.
export async function GET() {
  const { url, anonKey } = getSupabaseEnv();
  try {
    const res = await fetch(`${url}/auth/v1/health`, {
      headers: { apikey: anonKey },
      cache: "no-store",
    });
    return NextResponse.json(
      { ok: res.ok, supabase: res.ok ? "connected" : `error ${res.status}` },
      { status: res.ok ? 200 : 502 },
    );
  } catch (e) {
    return NextResponse.json(
      { ok: false, supabase: `unreachable: ${(e as Error).message}` },
      { status: 502 },
    );
  }
}
