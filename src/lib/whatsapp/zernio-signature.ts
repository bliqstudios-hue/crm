import crypto from 'node:crypto'

/**
 * Verify the HMAC-SHA256 signature Zernio attaches to webhook POSTs.
 *
 * Unlike Meta's `sha256=<hex>` header, Zernio's `X-Zernio-Signature` is the
 * bare lowercase hex digest with no prefix (per
 * https://docs.zernio.com/webhooks#signature-verification).
 *
 * Fails closed: a missing secret rejects every request rather than
 * accepting an unverifiable one.
 */
export function verifyZernioWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
): boolean {
  const secret = process.env.ZERNIO_WEBHOOK_SECRET
  if (!secret) {
    console.error(
      '[zernio-webhook] ZERNIO_WEBHOOK_SECRET is not set — rejecting request. ' +
        'Configure it to match the secret set on the webhook in the Zernio dashboard.',
    )
    return false
  }

  if (!signatureHeader) return false

  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex')

  const a = Buffer.from(signatureHeader)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}
