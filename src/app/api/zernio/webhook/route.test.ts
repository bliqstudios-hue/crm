import { describe, it, expect, vi, beforeEach } from 'vitest'
import crypto from 'node:crypto'

const h = vi.hoisted(() => ({
  dispatchInboundToAiReply: vi.fn(),
  state: {
    configRows: [
      { id: 'cfg-1', account_id: 'acc-1', user_id: 'user-1', messaging_provider: 'zernio', zernio_credentials: { accountId: 'zacct-1' } },
    ] as Record<string, unknown>[],
    conversation: { id: 'conv-1', account_id: 'acc-1', zernio_conversation_id: null as string | null },
    contact: { id: 'contact-1', account_id: 'acc-1', name: '+59171234567' },
    messageUpsertResult: [{ id: 'msg-1' }] as { id: string }[],
    updatedConversationRows: [] as Record<string, unknown>[],
    // `after()` in Next.js fires the callback without the caller awaiting
    // it, so POST's own promise resolves before the async DB chain inside
    // it does. Collect the callbacks here and drain them explicitly after
    // `await POST(req)` in each test — same pattern already used by
    // src/app/api/whatsapp/webhook/route.test.ts — instead of racing.
    afterCallbacks: [] as (() => Promise<void> | void)[],
  },
}))

vi.mock('next/server', () => ({
  after: (cb: () => Promise<void> | void) => {
    h.state.afterCallbacks.push(cb)
  },
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ body, init }),
  },
}))

vi.mock('@/lib/ai/auto-reply', () => ({
  dispatchInboundToAiReply: h.dispatchInboundToAiReply,
}))

vi.mock('@/lib/conversations/reopen', () => ({
  reopenClosedConversation: vi.fn(),
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from(table: string) {
      switch (table) {
        case 'whatsapp_config':
          return {
            select: () => ({
              eq: () => ({
                contains: () =>
                  Promise.resolve({ data: h.state.configRows, error: null }),
              }),
            }),
          }
        case 'contacts':
          return {
            // findExistingContact does select().eq().like(...)
            select: () => ({ eq: () => ({ like: () => Promise.resolve({ data: [], error: null }) }) }),
            insert: () => ({
              select: () => ({
                single: () => Promise.resolve({ data: h.state.contact, error: null }),
              }),
            }),
          }
        case 'conversations':
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  order: () => ({
                    limit: () => Promise.resolve({ data: [h.state.conversation], error: null }),
                  }),
                }),
              }),
            }),
            update: (row: Record<string, unknown>) => ({
              eq: () => {
                h.state.updatedConversationRows.push(row)
                return Promise.resolve({ data: null, error: null })
              },
            }),
          }
        case 'messages':
          return {
            upsert: () => ({
              select: () => Promise.resolve({ data: h.state.messageUpsertResult, error: null }),
            }),
          }
        default:
          throw new Error(`unexpected table in test: ${table}`)
      }
    },
    rpc: () => Promise.resolve({ data: null, error: null }),
  }),
}))

import { POST } from './route'

// Drains the after() callback exactly as the runtime would, so assertions
// on its side effects (DB writes, dispatch calls) see the finished state.
// The cast unwraps the mocked NextResponse.json() shape (`{ body, init }`)
// — tsc checks against the real next/server types, which don't have it.
async function postAndDrain(req: Request) {
  const res = (await POST(req)) as unknown as { body: unknown; init?: { status?: number } }
  for (const cb of h.state.afterCallbacks) await cb()
  return res
}

const SECRET = process.env.ZERNIO_WEBHOOK_SECRET!

function sign(body: string): string {
  return crypto.createHmac('sha256', SECRET).update(body).digest('hex')
}

function messageReceivedPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: 'evt-1',
    event: 'message.received',
    message: {
      id: 'internal-msg-1',
      conversationId: 'zconv-1',
      platform: 'whatsapp',
      platformMessageId: 'wamid.ABC',
      direction: 'incoming',
      text: 'Hola, quiero info',
      sender: { id: '59171234567', phoneNumber: '+59171234567' },
      sentAt: '2026-09-05T12:00:00.000Z',
    },
    conversation: {
      id: 'zconv-1',
      participantId: '59171234567',
      participantName: 'Juan',
    },
    account: { id: 'zacct-1', accountId: 'zacct-1', platform: 'whatsapp' },
    timestamp: '2026-09-05T12:00:00.000Z',
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  h.state.updatedConversationRows = []
  h.state.messageUpsertResult = [{ id: 'msg-1' }]
  h.state.conversation = { id: 'conv-1', account_id: 'acc-1', zernio_conversation_id: null }
  h.state.afterCallbacks = []
})

describe('POST /api/zernio/webhook', () => {
  it('rejects a request with an invalid signature', async () => {
    const body = JSON.stringify(messageReceivedPayload())
    const req = new Request('http://test/api/zernio/webhook', {
      method: 'POST',
      body,
      headers: { 'x-zernio-signature': 'bad' },
    })
    const res = await postAndDrain(req)
    expect(res.init?.status).toBe(401)
  })

  it('processes a text message.received event: creates the conversation link and triggers AI auto-reply', async () => {
    const body = JSON.stringify(messageReceivedPayload())
    const req = new Request('http://test/api/zernio/webhook', {
      method: 'POST',
      body,
      headers: { 'x-zernio-signature': sign(body) },
    })
    const res = await postAndDrain(req)
    expect(res.init?.status).toBe(200)

    expect(h.state.updatedConversationRows).toContainEqual({
      zernio_conversation_id: 'zconv-1',
    })
    expect(h.dispatchInboundToAiReply).toHaveBeenCalledWith({
      accountId: 'acc-1',
      conversationId: 'conv-1',
      contactId: 'contact-1',
      configOwnerUserId: 'user-1',
    })
  })

  it('ignores a non-text message (v1 scope)', async () => {
    const body = JSON.stringify(
      messageReceivedPayload({ message: { ...messageReceivedPayload().message, text: null } }),
    )
    const req = new Request('http://test/api/zernio/webhook', {
      method: 'POST',
      body,
      headers: { 'x-zernio-signature': sign(body) },
    })
    await postAndDrain(req)
    expect(h.dispatchInboundToAiReply).not.toHaveBeenCalled()
  })

  it('ignores an outgoing message (echo of our own send)', async () => {
    const body = JSON.stringify(
      messageReceivedPayload({ message: { ...messageReceivedPayload().message, direction: 'outgoing' } }),
    )
    const req = new Request('http://test/api/zernio/webhook', {
      method: 'POST',
      body,
      headers: { 'x-zernio-signature': sign(body) },
    })
    await postAndDrain(req)
    expect(h.dispatchInboundToAiReply).not.toHaveBeenCalled()
  })

  it('skips a duplicate delivery (idempotent replay)', async () => {
    h.state.messageUpsertResult = []
    const body = JSON.stringify(messageReceivedPayload())
    const req = new Request('http://test/api/zernio/webhook', {
      method: 'POST',
      body,
      headers: { 'x-zernio-signature': sign(body) },
    })
    await postAndDrain(req)
    expect(h.dispatchInboundToAiReply).not.toHaveBeenCalled()
  })
})
