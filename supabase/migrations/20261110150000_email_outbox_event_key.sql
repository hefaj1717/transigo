-- One e-mail per template, order AND event (D129). Until now the key was (template_code, order_id): a second
-- carrier assignment after "Rinuncia" / "Rimuovi padroncino" sent the customer no new order_assigned, and
-- carrier_released_job had to be queued without order_id. event_key names the event: '' for one-per-order
-- e-mails (order_paid, order_delivered — webhook retries stay deduplicated), the assignment time for
-- order_assigned, the release time for carrier_released_job. Rows without an order are never deduplicated
-- (NULL order_id is distinct), as before.

alter table public.email_outbox
  add column event_key text not null default '' check (length(event_key) <= 200);

alter table public.email_outbox
  drop constraint email_outbox_template_code_order_id_key;

alter table public.email_outbox
  add constraint email_outbox_template_order_event_key unique (template_code, order_id, event_key);
