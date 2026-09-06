import { NextResponse, after } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { verifyZernioWebhookSignature } from '@/lib/whatsapp/zernio-signature'
import { findOrCreateContact, findOrCreateConversation } from '@/lib/whatsapp/contact-conversation'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { reopenClosedConversation } from '@/lib/conversations/reopen'
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'

// The `after()` callback in POST runs within this route's max duration.
// It awaits an AI auto-reply call, so give it headroom beyond the
// platform default (Vercel clamps this to the plan's ceiling).
export const maxDuration = 60

// Lazy-initialized to avoid build-time crash when env vars are missing —
// same pattern as src/app/api/whatsapp/webhook/route.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return _adminClient
}

interface ZernioMessageReceivedPayload {
  id: string
  event: string
  message: {
    id: string
    conversationId: string
    platform: string
    platformMessageId: string
    direction: 'incoming' | 'outgoing'
    text: string | null
    sender: {
      id: string
      phoneNumber?: string | null
    }
    sentAt: string
  }
  conversation: {
    id: string
    participantName?: string
  }
  account: {
    id: string
    accountId: string
    platform: string
  }
}

// v1 scope: only WhatsApp text messages. Media, templates, interactive,
// reactions, and every non-WhatsApp platform are logged and skipped —
// see the plan's "Alcance" section for why.
export async function POST(request: Request) {
  const rawBody = await request.text()
  const signature = request.headers.get('x-zernio-signature')

  if (!verifyZernioWebhookSignature(rawBody, signature)) {
    console.warn('[zernio-webhook] rejected request with invalid signature')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  let payload: ZernioMessageReceivedPayload
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  after(async () => {
    try {
      await processZernioEvent(payload)
    } catch (error) {
      console.error('[zernio-webhook] error processing event:', error)
    }
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}

async function processZernioEvent(payload: ZernioMessageReceivedPayload) {
  if (payload.event !== 'message.received') {
    console.info(`[zernio-webhook] ignoring event "${payload.event}" (v1 handles message.received only)`)
    return
  }
  if (payload.message.platform !== 'whatsapp') {
    console.info(`[zernio-webhook] ignoring platform "${payload.message.platform}" (v1 is WhatsApp-only)`)
    return
  }
  if (payload.message.direction !== 'incoming') return
  if (!payload.message.text) {
    console.info('[zernio-webhook] ignoring non-text message (v1 handles text only):', payload.message.id)
    return
  }

  const db = supabaseAdmin()

  const { data: configRows, error: configError } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('messaging_provider', 'zernio')
    .contains('zernio_credentials', { accountId: payload.account.accountId })

  if (configError) {
    console.error('[zernio-webhook] error fetching whatsapp_config:', configError)
    return
  }
  if (!configRows || configRows.length === 0) {
    console.error('[zernio-webhook] no config found for Zernio accountId:', payload.account.accountId)
    return
  }
  if (configRows.length > 1) {
    console.error(
      `[zernio-webhook] multiple configs (${configRows.length}) for Zernio accountId:`,
      payload.account.accountId
    )
    return
  }
  const config = configRows[0]

  const rawSenderPhone = payload.message.sender.phoneNumber
  if (!rawSenderPhone) {
    // BSUID-only sender (Meta's April 2026+ rollout) — not supported in v1.
    console.warn('[zernio-webhook] message has no sender.phoneNumber; skipping:', payload.message.id)
    return
  }
  const senderPhone = normalizePhone(rawSenderPhone)
  const contactName = payload.conversation.participantName || senderPhone

  const contactOutcome = await findOrCreateContact(db, config.account_id, config.user_id, senderPhone, contactName)
  if (!contactOutcome) return
  const contact = contactOutcome.contact

  const convResult = await findOrCreateConversation(db, config.account_id, config.user_id, contact.id)
  if (!convResult) return
  const conversation = convResult.conversation

  if (conversation.zernio_conversation_id !== payload.message.conversationId) {
    await db
      .from('conversations')
      .update({ zernio_conversation_id: payload.message.conversationId })
      .eq('id', conversation.id)
  }

  // Idempotent insert — same (conversation_id, message_id) unique index
  // (migration 037) the Meta webhook already relies on. platformMessageId
  // is the underlying WhatsApp wamid (Zernio is a pass-through), so ids
  // stay comparable if this number ever moves back to meta_direct.
  const { data: insertedRows, error: msgError } = await db
    .from('messages')
    .upsert(
      {
        conversation_id: conversation.id,
        sender_type: 'customer',
        content_type: 'text',
        content_text: payload.message.text,
        message_id: payload.message.platformMessageId,
        status: 'delivered',
        created_at: payload.message.sentAt,
      },
      { onConflict: 'conversation_id,message_id', ignoreDuplicates: true }
    )
    .select('id')

  if (msgError) {
    console.error('[zernio-webhook] error inserting message:', msgError)
    return
  }
  if (!insertedRows || insertedRows.length === 0) {
    console.info('[zernio-webhook] duplicate inbound message ignored:', payload.message.platformMessageId)
    return
  }

  const { error: convError } = await db.rpc('bump_conversation_on_inbound', {
    p_conversation_id: conversation.id,
    p_last_message_text: payload.message.text,
  })
  if (convError) {
    console.error('[zernio-webhook] error updating conversation:', convError)
  }

  await reopenClosedConversation(db, conversation)

  await dispatchInboundToAiReply({
    accountId: config.account_id,
    conversationId: conversation.id,
    contactId: contact.id,
    configOwnerUserId: config.user_id,
  })
}
