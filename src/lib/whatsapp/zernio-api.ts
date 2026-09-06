/**
 * Zernio API helpers — WhatsApp send path only (v1 scope: free-form text
 * inside an existing conversation, used by the AI auto-reply path).
 *
 * See https://docs.zernio.com/platforms/whatsapp and
 * https://docs.zernio.com/messages/send-inbox-message.
 */

const ZERNIO_API_BASE = 'https://zernio.com/api/v1'

export interface ZernioSendResult {
  messageId: string
}

interface ZernioErrorResponse {
  error?: string
}

async function throwZernioError(response: Response, fallback: string): Promise<never> {
  let message = fallback
  try {
    const data = (await response.json()) as ZernioErrorResponse
    if (data.error) message = data.error
  } catch {
    // response body wasn't JSON — keep the fallback
  }
  throw new Error(message)
}

export interface SendZernioTextArgs {
  /** Zernio's own social account id (whatsapp_config.zernio_credentials.accountId). */
  accountId: string
  /** Zernio's internal conversation id (from the message.received webhook). */
  conversationId: string
  message: string
}

/**
 * Send a free-form WhatsApp text message into an existing Zernio
 * conversation. Only works inside the 24-hour customer service window —
 * same constraint as Meta's direct API.
 */
export async function sendZernioText(
  args: SendZernioTextArgs
): Promise<ZernioSendResult> {
  const { accountId, conversationId, message } = args
  const apiKey = process.env.ZERNIO_API_KEY
  if (!apiKey) {
    throw new Error('ZERNIO_API_KEY is not configured')
  }

  const url = `${ZERNIO_API_BASE}/inbox/conversations/${encodeURIComponent(conversationId)}/messages`
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ accountId, message }),
  })

  if (!response.ok) {
    await throwZernioError(response, `Zernio API error: ${response.status}`)
  }

  const data = await response.json()
  const messageId = data?.data?.messageId
  if (!messageId) {
    throw new Error('Zernio accepted the send but returned no messageId')
  }
  return { messageId: String(messageId) }
}
