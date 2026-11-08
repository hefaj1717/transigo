-- audit_log keeps its author forever (D65).
--   * actor_id: no foreign key any more, so deleting an account no longer nulls it (it was on delete set null).
--   * actor_email: e-mail of the author at the time of the action, written by the server.
--   * append-only: UPDATE, DELETE and TRUNCATE are rejected for everyone, including the service role.
-- GDPR (D35, D65): actor_id and actor_email stay in the log after anonymisation of the account.
-- [DO POTWIERDZENIA Z PRAWNIKIEM – Etap 8]

alter table public.audit_log drop constraint audit_log_actor_id_fkey;

alter table public.audit_log add column actor_email text;

create index audit_log_actor_idx on public.audit_log (actor_id, created_at);

create or replace function public.audit_log_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'audit_log is append-only' using errcode = '42501';
end;
$$;

create trigger audit_log_append_only
  before update or delete on public.audit_log
  for each row execute function public.audit_log_append_only();

create trigger audit_log_no_truncate
  before truncate on public.audit_log
  for each statement execute function public.audit_log_append_only();
