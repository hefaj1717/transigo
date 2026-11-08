import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

try {
  process.loadEnvFile(".env.local");
} catch {
  // env may already be provided by the shell
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!url || !anonKey || !serviceKey) {
  throw new Error("RLS tests need NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY");
}

const noSession = { auth: { persistSession: false, autoRefreshToken: false } };

/** Service-role client: bypasses RLS. Test setup/cleanup only. */
export const service = createClient(url, serviceKey, noSession);

/** Anonymous (not signed in) client. */
export const anon = createClient(url, anonKey, noSession);

export type TestUser = { id: string; email: string; client: SupabaseClient };

const created: string[] = [];

/** Creates a confirmed user (metadata goes through the same auth.users trigger as sign-up) and signs in. */
export async function createUser(metadata: Record<string, unknown> = {}): Promise<TestUser> {
  const email = `rls-test-${randomUUID().slice(0, 8)}@example.com`;
  const password = `T!${randomUUID()}`;
  const { data, error } = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: metadata,
  });
  if (error) throw error;
  created.push(data.user.id);

  const client = createClient(url, anonKey, noSession);
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw signInError;
  return { id: data.user.id, email, client };
}

/** Deletes all users created by this test run (cascades to profiles, customers, carriers, ...). */
export async function deleteCreatedUsers() {
  for (const id of created.splice(0)) {
    const { data: files } = await service.storage.from("carrier-documents").list(id);
    if (files?.length) {
      await service.storage.from("carrier-documents").remove(files.map((f) => `${id}/${f.name}`));
    }
    await service.auth.admin.deleteUser(id);
  }
}

export async function profileRole(id: string) {
  const { data, error } = await service.from("profiles").select("role").eq("id", id).single();
  if (error) throw error;
  return data.role as string;
}
