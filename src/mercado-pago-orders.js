export const orderIdPattern = /^ORD[A-Z0-9]{10,61}$/;

export function pixOrderPayload({ id, description, cents, dueDate, payer, now }) {
  const amount = (cents / 100).toFixed(2);
  const expiresAt = Date.parse(`${dueDate}T23:59:59-03:00`);
  const seconds = Math.floor((expiresAt - now) / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor(seconds / 3600) % 24;
  const minutes = Math.floor(seconds / 60) % 60;
  const expiration = `P${days}DT${hours}H${minutes}M${seconds % 60}S`;
  return {
    type: 'online', processing_mode: 'automatic', external_reference: id, description,
    total_amount: amount, payer,
    transactions: { payments: [{
      amount, expiration_time: expiration,
      payment_method: { id: 'pix', type: 'bank_transfer' },
    }] },
  };
}

function isAmount(value, cents) {
  return typeof value === 'string' && /^\d{1,10}(?:\.\d{1,2})?$/.test(value) &&
    Math.round(Number(value) * 100) === cents;
}

function orderStatus(order) {
  if (order.status === 'processed' && ['accredited', 'partially_refunded'].includes(order.status_detail)) return 'paid';
  if (['canceled', 'failed'].includes(order.status) && order.status_detail === 'expired') return 'expired';
  switch (order.status) {
    case 'canceled': return 'cancelled';
    case 'failed': return 'rejected';
    case 'refunded': return 'refunded';
    case 'charged_back': return 'charged_back';
    default: return 'pending';
  }
}

// Orders omits collector_id. The caller uses the token of the charge's original integration.
export function readPixOrder(order, charge) {
  const payments = order.transactions?.payments;
  const payment = payments?.[0];
  const method = payment?.payment_method;
  if (!orderIdPattern.test(order.id || '') || order.external_reference !== charge.id ||
      order.type !== 'online' || order.country_code !== 'BRA' ||
      !Array.isArray(payments) || payments.length !== 1 ||
      !isAmount(order.total_amount, charge.amount_cents) || !isAmount(payment?.amount, charge.amount_cents) ||
      method?.id !== 'pix' || method.type !== 'bank_transfer') {
    throw new Error('payment_provider_data_mismatch');
  }
  const status = orderStatus(order);
  if (status === 'paid' &&
      (payment.status !== 'processed' || !['accredited', 'partially_refunded'].includes(payment.status_detail) ||
        (order.status_detail === 'accredited' && !isAmount(order.total_paid_amount, charge.amount_cents)))) {
    throw new Error('payment_provider_data_mismatch');
  }
  const date = order.last_updated_date || order.created_date;
  return { id: order.id, status, date, paidAt: date, pix: method };
}
