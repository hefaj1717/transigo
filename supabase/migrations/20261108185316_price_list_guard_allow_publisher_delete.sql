-- Fix: an admin who published a price list could not be deleted.
-- Deleting the account runs the FK action price_lists.published_by → null (on delete set null), which the
-- guard treated as an edit of a published list and rejected, aborting the whole account deletion.
-- The guard now lets exactly that change through (published_by → null, nothing else); every other edit
-- of an active/archived list is still rejected. API users have no column privilege on published_by,
-- so in practice only the FK action (or the server) can do it. Who published stays in audit_log (D65).

create or replace function public.guard_price_list()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception 'Only draft price lists can be deleted' using errcode = '42501';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'New price lists must start as draft' using errcode = '42501';
    end if;
    return new;
  end if;

  -- UPDATE
  if old.status = 'draft' and new.status = 'draft' then
    return new;
  end if;

  -- Publisher account deleted: only published_by is cleared.
  if new.status = old.status
     and old.published_by is not null and new.published_by is null
     and (to_jsonb(new) - array['published_by', 'updated_at']) = (to_jsonb(old) - array['published_by', 'updated_at']) then
    return new;
  end if;

  if not ((old.status = 'draft' and new.status = 'active')
          or (old.status = 'active' and new.status = 'archived')) then
    raise exception 'Price list status cannot change from % to %', old.status, new.status using errcode = '42501';
  end if;
  if (to_jsonb(new) - array['status', 'published_at', 'published_by', 'updated_at'])
     is distinct from (to_jsonb(old) - array['status', 'published_at', 'published_by', 'updated_at']) then
    raise exception 'Published price lists are read-only' using errcode = '42501';
  end if;
  return new;
end;
$$;
