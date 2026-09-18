// Style: camelCase vars/fns, PascalCase types, SCREAMING_SNAKE constants
// Formatting: no semicolons, single quotes
// Docs: JSDoc on exports only | Flow: early returns

const MIN_AMOUNT_CENTS = 50
const MAX_AMOUNT_CENTS = 999_999_99

enum PaymentStatus {
  Pending = 'pending',
  Completed = 'completed',
  Failed = 'failed',
  Refunded = 'refunded',
}

enum Currency {
  USD = 'USD',
  EUR = 'EUR',
  GBP = 'GBP',
}

interface PaymentIntent {
  id: string
  amount: number
  currency: Currency
  status: PaymentStatus
  createdAt: Date
}

interface RefundRequest {
  paymentId: string
  reason: string
  amount?: number
}

/** Creates a validated payment intent from raw input. */
export function createPaymentIntent(
  amount: number,
  currency: Currency
): PaymentIntent {
  if (amount < MIN_AMOUNT_CENTS) {
    throw new PaymentError('amount_too_low', `Minimum is ${MIN_AMOUNT_CENTS} cents`)
  }

  if (amount > MAX_AMOUNT_CENTS) {
    throw new PaymentError('amount_too_high', `Maximum is ${MAX_AMOUNT_CENTS} cents`)
  }

  return {
    id: generatePaymentId(),
    amount,
    currency,
    status: PaymentStatus.Pending,
    createdAt: new Date(),
  }
}

/** Checks whether a payment can be refunded. */
export function isRefundable(payment: PaymentIntent): boolean {
  if (payment.status !== PaymentStatus.Completed) {
    return false
  }

  const ageMs = Date.now() - payment.createdAt.getTime()
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000
  return ageMs < thirtyDaysMs
}

function generatePaymentId(): string {
  return `pay_${Date.now().toString(36)}`
}
