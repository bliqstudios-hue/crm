import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  sendTextMessage: vi.fn(),
  sendZernioText: vi.fn(),
  state: {
    contact: { id: 'contact-1', phone: '+59171234567' } as Record<string, unknown> | null,
    config: {
      phone_number_id: 'phone-1',
      access_token: 'encrypted-token',
      messaging_provider: 'meta_direct',
      zernio_credentials: null as { accountId?: string } | null,
    } as Record<string, unknown>,
    conversationRow: null as { zernio_conversation_id: string | null } | null,
    insertedMessages: [] as Record<string, unknown>[],
    updatedConversations: [] as Record<string, unknown>[],
  },
}))

vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendTextMessage: h.sendTextMessage,
}))
vi.mock('@/lib/whatsapp/zernio-api', () => ({
  sendZernioText: h.sendZernioText,
}))
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => `decrypted:${v}`,
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from(table: string) {
      switch (table) {
        case 'contacts':
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: () =>
                    Promise.resolve({ data: h.state.contact, error: null }),
                }),
              }),
            }),
          }
        case 'whatsapp_config':
          return {
            select: () => ({
              eq: () => ({
                single: () => Promise.resolve({ data: h.state.config, error: null }),
              }),
            }),
          }
        case 'conversations':
          return {
            select: () => ({
              eq: () => ({
                single: () =>
                  Promise.resolve({
                    data: h.state.conversationRow,
                    error: h.state.conversationRow ? null : { message: 'not found' },
                  }),
              }),
            }),
            update: (row: Record<string, unknown>) => ({
              eq: () => {
                h.state.updatedConversations.push(row)
                return Promise.resolve({ error: null })
              },
            }),
          }
        case 'messages':
          return {
            insert: (row: Record<string, unknown>) => {
              h.state.insertedMessages.push(row)
              return Promise.resolve({ error: null })
            },
          }
        default:
          throw new Error(`unexpected table in test: ${table}`)
      }
    },
  }),
}))

import { engineSendText } from './meta-send'

beforeEach(() => {
  vi.clearAllMocks()
  h.state.contact = { id: 'contact-1', phone: '+59171234567' }
  h.state.config = {
    phone_number_id: 'phone-1',
    access_token: 'encrypted-token',
    messaging_provider: 'meta_direct',
    zernio_credentials: null,
  }
  h.state.conversationRow = null
  h.state.insertedMessages = []
  h.state.updatedConversations = []
})

describe('engineSendText — meta_direct (existing behavior, unchanged)', () => {
  it('sends via Meta and returns the wamid', async () => {
    h.sendTextMessage.mockResolvedValue({ messageId: 'wamid.META1' })

    const result = await engineSendText({
      accountId: 'acc-1',
      userId: 'user-1',
      conversationId: 'conv-1',
      contactId: 'contact-1',
      text: 'Hola',
    })

    expect(result).toEqual({ whatsapp_message_id: 'wamid.META1' })
    expect(h.sendTextMessage).toHaveBeenCalledWith(
      // sanitizePhoneForMeta strips all non-digit chars, including the
      // leading "+" — this is the real, unchanged Meta-path behavior.
      expect.objectContaining({ phoneNumberId: 'phone-1', to: '59171234567', text: 'Hola' })
    )
    expect(h.sendZernioText).not.toHaveBeenCalled()
  })
})

describe('engineSendText — zernio', () => {
  it('sends via Zernio when the account is messaging_provider=zernio', async () => {
    h.state.config = {
      messaging_provider: 'zernio',
      zernio_credentials: { accountId: 'zacct-1' },
    }
    h.state.conversationRow = { zernio_conversation_id: 'zconv-1' }
    h.sendZernioText.mockResolvedValue({ messageId: 'wamid.XYZ' })

    const result = await engineSendText({
      accountId: 'acc-1',
      userId: 'user-1',
      conversationId: 'conv-1',
      contactId: 'contact-1',
      text: 'Hola',
    })

    expect(result).toEqual({ whatsapp_message_id: 'wamid.XYZ' })
    expect(h.sendZernioText).toHaveBeenCalledWith({
      accountId: 'zacct-1',
      conversationId: 'zconv-1',
      message: 'Hola',
    })
    expect(h.sendTextMessage).not.toHaveBeenCalled()
    expect(h.state.insertedMessages).toEqual([
      expect.objectContaining({
        conversation_id: 'conv-1',
        content_text: 'Hola',
        message_id: 'wamid.XYZ',
        status: 'sent',
      }),
    ])
  })

  it('throws when a zernio account has no zernio_conversation_id yet', async () => {
    h.state.config = {
      messaging_provider: 'zernio',
      zernio_credentials: { accountId: 'zacct-1' },
    }
    h.state.conversationRow = null

    await expect(
      engineSendText({
        accountId: 'acc-1',
        userId: 'user-1',
        conversationId: 'conv-1',
        contactId: 'contact-1',
        text: 'Hola',
      })
    ).rejects.toThrow(/zernio_conversation_id/)
    expect(h.sendZernioText).not.toHaveBeenCalled()
  })

  it('throws when zernio_credentials.accountId is missing', async () => {
    h.state.config = {
      messaging_provider: 'zernio',
      zernio_credentials: null,
    }
    h.state.conversationRow = { zernio_conversation_id: 'zconv-1' }

    await expect(
      engineSendText({
        accountId: 'acc-1',
        userId: 'user-1',
        conversationId: 'conv-1',
        contactId: 'contact-1',
        text: 'Hola',
      })
    ).rejects.toThrow(/zernio_credentials/)
  })
})
