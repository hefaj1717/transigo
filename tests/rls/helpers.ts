import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { inject } from "vitest";
import { assertLocalTarget } from "./target";

// Connection data comes from tests/rls/global-setup.ts (local Supabase only, D64) — never from .env.local.
const { url: providedUrl, anonKey, serviceKey } = inject("supabase");
const url = assertLocalTarget(providedUrl); // second check, in every test worker

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

/**
 * Deletes all users created by this test run (cascades to profiles, customers, carriers, ...).
 * Fails loudly if a user cannot be deleted — a leftover user means a schema bug (e.g. a blocking FK action).
 */
export async function deleteCreatedUsers() {
  const failures: string[] = [];
  for (const id of created.splice(0)) {
    const { data: files } = await service.storage.from("carrier-documents").list(id);
    if (files?.length) {
      await service.storage.from("carrier-documents").remove(files.map((f) => `${id}/${f.name}`));
    }
    const { error } = await service.auth.admin.deleteUser(id);
    if (error) failures.push(`${id}: ${error.message}`);
  }
  if (failures.length) throw new Error(`Could not delete test users:\n${failures.join("\n")}`);
}

/** Deletes one test user now (and forgets it), throwing on failure. */
export async function deleteUserNow(user: TestUser) {
  const i = created.indexOf(user.id);
  if (i >= 0) created.splice(i, 1);
  const { error } = await service.auth.admin.deleteUser(user.id);
  if (error) throw error;
}

export async function profileRole(id: string) {
  const { data, error } = await service.from("profiles").select("role").eq("id", id).single();
  if (error) throw error;
  return data.role as string;
}
