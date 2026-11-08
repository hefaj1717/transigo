// Italian labels of order statuses (spec section 4).
export const ORDER_STATUS_LABEL: Record<string, string> = {
  draft: "Bozza",
  pending_payment: "In attesa di pagamento",
  expired: "Scaduto",
  paid: "Pagato",
  assigned: "Assegnato",
  picked_up: "Ritirato",
  in_transit: "In viaggio",
  delivered: "Consegnato",
  completed: "Completato",
  cancellation_review: "Annullamento in revisione",
  cancelled: "Annullato",
  refunded: "Rimborsato",
};
