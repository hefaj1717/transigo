-- Stage 3 / migration 1: new order status for payments that need an admin check.
-- Separate file: a new enum value cannot be used in the transaction that adds it.
--
-- payment_review ("Pagamento da verificare"): Stripe took money, but it does not match the order
-- (amount/currency mismatch, or a payment for an order that had already expired). Not "paid";
-- the admin decides in Stage 6 (mark paid or refund).
alter type public.order_status add value if not exists 'payment_review' after 'paid';
