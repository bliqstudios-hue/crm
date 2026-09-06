# CRM Híbrido — Fase 2: Adapter de mensajería Zernio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hacer que el número de prueba de WhatsApp que ya conectamos a Zernio (`accountId` `6a9cafed77555aae01e2a7a2`) vuelva a recibir mensajes y a que la IA responda — pero ahora vía Zernio en vez de la API directa de Meta — sin romper el camino existente (`meta_direct`) que usarán los clientes que no pasen por Zernio.

**Architecture:** Zernio es un wrapper sobre la Cloud API de Meta, no un proveedor alternativo — envía y recibe los mismos WhatsApp, solo cambia el transporte. `whatsapp_config.messaging_provider` (ya existe desde la migración 040) decide qué camino toma cada cuenta. Se agrega una ruta de webhook nueva (`/api/zernio/webhook`) en vez de tocar la ruta de Meta existente (`/api/whatsapp/webhook`) — conectar un WABA a Zernio le quita a Meta el callback directo de forma exclusiva, así que ambos webhooks nunca reciben tráfico para el mismo número al mismo tiempo; no hace falta que coexistan en el mismo código. Siguiendo el precedente ya establecido en este mismo repo (ver el comentario de `engineSendText` en `src/lib/flows/meta-send.ts`: "ships this in isolation... the obvious extraction candidates into a shared base" una vez que ambos caminos estén probados), el webhook de Zernio se escribe como código nuevo e independiente, reutilizando solo las dos funciones genéricas de contacto/conversación (movidas a un módulo compartido) — no se extrae ni se toca la lógica de despacho (flows/automations/media/reacciones) del webhook de Meta, que sigue funcionando exactamente igual para todo cliente que no use Zernio.

**Alcance de esta Fase 2 (v1) — explícitamente acotado:**
- Solo mensajes de **texto** entrantes y salientes. Media, templates, interactivos, reacciones, broadcasts vía Zernio quedan FUERA — se resuelven en una fase posterior si Zernio prueba servir. El path Direct Meta ya cubre todo eso hoy y no se toca.
- Solo el envío de la **IA (auto-reply)** se bifurca a Zernio. El composer manual del inbox, el motor de automations y el motor de flows siguen llamando a Meta directo — si una cuenta con `messaging_provider='zernio'` usa esas rutas hoy van a fallar (no hay `access_token` de Meta que decodificar para esa cuenta). Esto es aceptable porque el único objetivo de esta fase es validar el camino de "inbox + IA responde + Kanban" — el mismo criterio de éxito que ya se probó en Fase 1 — no dar soporte completo a clientes reales todavía.
- El número usado es el número de PRUEBA de Meta ya compartido con ACP — esta fase es una prueba de concepto en la cuenta de Sebas, no un onboarding de cliente real.

**Tech Stack:** Next.js 16 App Router (route handlers), Supabase (Postgres + service-role client), Vitest, `fetch` nativo contra `https://zernio.com/api/v1`.

**Spec:** No hay spec de diseño separada — este plan se arma directo sobre los hallazgos de investigación de la API de Zernio (confirmados contra `https://docs.zernio.com/llms-full.txt`) documentados en la conversación que originó este plan, y sobre el plan de Fase 1 ya ejecutado: `docs/superpowers/plans/2026-08-21-crm-whatsapp-hibrido.md`.

## Global Constraints

- No modificar la lógica de negocio del webhook de Meta (`src/app/api/whatsapp/webhook/route.ts`) más allá de mover 2 funciones genéricas a un módulo compartido (Task 3) — cero cambio de comportamiento para cuentas `meta_direct`.
- `ZERNIO_API_KEY` y `ZERNIO_WEBHOOK_SECRET` son secretos de servidor — nunca en `NEXT_PUBLIC_*`, nunca commiteados, nunca transcritos en ningún plan/spec/doc (solo los NOMBRES de las variables, nunca el valor real).
- Node.js ≥ 20 (heredado de Fase 1). `npm run typecheck` y `npm test` deben quedar en verde después de cada tarea.
- Toda migración SQL es aditiva e idempotente (`ADD COLUMN IF NOT EXISTS`), igual que la 040.
- El accountId de Zernio conectado esta sesión (`6a9cafed77555aae01e2a7a2`) y el `profileId` (`6a9cac519b78e4ab804d4dd4`) son datos de la cuenta de prueba de Sebas — van en un `UPDATE` manual documentado en Task 4, NUNCA en un archivo de migración versionado (una migración es schema compartido por todo cliente futuro; los datos de una cuenta puntual no).

---

### Task 1: Verificación de firma de webhooks de Zernio

**Files:**
- Create: `src/lib/whatsapp/zernio-signature.ts`
- Test: `src/lib/whatsapp/zernio-signature.test.ts`
- Modify: `vitest.config.ts:14-18`

**Interfaces:**
- Consumes: nada (primera tarea).
- Produces: `verifyZernioWebhookSignature(rawBody: string, signatureHeader: string | null): boolean` — usada por Task 5 (ruta del webhook).

- [ ] **Step 1: Agregar el secreto de prueba a `vitest.config.ts`**

```typescript
// vitest.config.ts — dentro de test.env, junto a los ya existentes
    env: {
      ENCRYPTION_KEY:
        "0000000000000000000000000000000000000000000000000000000000000000",
      META_APP_SECRET: "test-meta-app-secret",
      ZERNIO_WEBHOOK_SECRET: "test-zernio-webhook-secret",
      ZERNIO_API_KEY: "test-zernio-api-key",
    },
```

- [ ] **Step 2: Escribir el test que falla**

```typescript
// src/lib/whatsapp/zernio-signature.test.ts
import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyZernioWebhookSignature } from "./zernio-signature";

const SECRET = process.env.ZERNIO_WEBHOOK_SECRET!;

function signedHeader(body: string, secret: string = SECRET): string {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

describe("verifyZernioWebhookSignature", () => {
  it("accepts a request signed with the correct secret", () => {
    const body = JSON.stringify({ event: "message.received" });
    expect(verifyZernioWebhookSignature(body, signedHeader(body))).toBe(true);
  });

  it("rejects a signature computed with a different secret", () => {
    const body = "{}";
    expect(verifyZernioWebhookSignature(body, signedHeader(body, "wrong"))).toBe(
      false,
    );
  });

  it("rejects when the body has been tampered with after signing", () => {
    const original = '{"event":"message.received"}';
    const header = signedHeader(original);
    const tampered = '{"event":"message.deleted"}';
    expect(verifyZernioWebhookSignature(tampered, header)).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(verifyZernioWebhookSignature("anything", null)).toBe(false);
  });

  it("rejects a header of the wrong length without throwing", () => {
    expect(verifyZernioWebhookSignature("{}", "tooshort")).toBe(false);
  });

  describe("fail-closed when secret is missing", () => {
    const originalSecret = process.env.ZERNIO_WEBHOOK_SECRET;
    beforeEach(() => {
      delete process.env.ZERNIO_WEBHOOK_SECRET;
    });
    afterEach(() => {
      process.env.ZERNIO_WEBHOOK_SECRET = originalSecret;
    });

    it("rejects even a correctly-formed signature when no secret is configured", () => {
      const body = "{}";
      const header = signedHeader(body, originalSecret!);
      expect(verifyZernioWebhookSignature(body, header)).toBe(false);
    });
  });
});
```

- [ ] **Step 3: Correr el test y confirmar que falla**

Run: `npx vitest run src/lib/whatsapp/zernio-signature.test.ts`
Expected: FAIL — `Cannot find module './zernio-signature'`

- [ ] **Step 4: Implementación**

```typescript
// src/lib/whatsapp/zernio-signature.ts
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
```

- [ ] **Step 5: Correr el test y confirmar que pasa**

Run: `npx vitest run src/lib/whatsapp/zernio-signature.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 6: Commit**

```bash
git add vitest.config.ts src/lib/whatsapp/zernio-signature.ts src/lib/whatsapp/zernio-signature.test.ts
git commit -m "feat(zernio): add webhook signature verification"
```

---

### Task 2: Cliente de envío de texto vía Zernio

**Files:**
- Create: `src/lib/whatsapp/zernio-api.ts`
- Test: `src/lib/whatsapp/zernio-api.test.ts`

**Interfaces:**
- Consumes: `process.env.ZERNIO_API_KEY` (server-only).
- Produces: `sendZernioText(args: SendZernioTextArgs): Promise<ZernioSendResult>` — usada por Task 6 (`engineSendText`).

- [ ] **Step 1: Escribir el test que falla**

```typescript
// src/lib/whatsapp/zernio-api.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendZernioText } from "./zernio-api";

describe("sendZernioText", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts to the conversation's messages endpoint with the accountId and message", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ success: true, data: { messageId: "wamid.ABC123" } }),
        { status: 200 },
      ),
    );

    const result = await sendZernioText({
      accountId: "acct-1",
      conversationId: "conv-1",
      message: "hola",
    });

    expect(result).toEqual({ messageId: "wamid.ABC123" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://zernio.com/api/v1/inbox/conversations/conv-1/messages",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer test-zernio-api-key",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({ accountId: "acct-1", message: "hola" }),
      }),
    );
  });

  it("throws with Zernio's error message on a non-2xx response", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "Conversation not found" }), {
        status: 404,
      }),
    );

    await expect(
      sendZernioText({ accountId: "a", conversationId: "c", message: "m" }),
    ).rejects.toThrow("Conversation not found");
  });

  it("throws when the response is 2xx but carries no messageId", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: {} }), { status: 200 }),
    );

    await expect(
      sendZernioText({ accountId: "a", conversationId: "c", message: "m" }),
    ).rejects.toThrow(/no messageId/);
  });

  it("throws when ZERNIO_API_KEY is not configured", async () => {
    const original = process.env.ZERNIO_API_KEY;
    delete process.env.ZERNIO_API_KEY;
    try {
      await expect(
        sendZernioText({ accountId: "a", conversationId: "c", message: "m" }),
      ).rejects.toThrow(/ZERNIO_API_KEY/);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      process.env.ZERNIO_API_KEY = original;
    }
  });
});
```

- [ ] **Step 2: Correr el test y confirmar que falla**

Run: `npx vitest run src/lib/whatsapp/zernio-api.test.ts`
Expected: FAIL — `Cannot find module './zernio-api'`

- [ ] **Step 3: Implementación**

```typescript
// src/lib/whatsapp/zernio-api.ts
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

  const url = `${ZERNIO_API_BASE}/inbox/conversations/${conversationId}/messages`
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
```

- [ ] **Step 4: Correr el test y confirmar que pasa**

Run: `npx vitest run src/lib/whatsapp/zernio-api.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/whatsapp/zernio-api.ts src/lib/whatsapp/zernio-api.test.ts
git commit -m "feat(zernio): add sendZernioText client"
```

---

### Task 3: Extraer contacto/conversación a un módulo compartido

**Files:**
- Create: `src/lib/whatsapp/contact-conversation.ts`
- Modify: `src/app/api/whatsapp/webhook/route.ts:1105-1244` (borrar `findOrCreateContact` y `findOrCreateConversation` de ahí, importarlas)
- Test: correr la suite existente `src/app/api/whatsapp/webhook/route.test.ts` sin cambios — debe seguir en verde.

**Interfaces:**
- Consumes: `SupabaseClient` (pasado explícito por el caller, no una closure).
- Produces: `findOrCreateContact(db, accountId, configOwnerUserId, phone, name)` y `findOrCreateConversation(db, accountId, configOwnerUserId, contactId)` — usadas por el webhook de Meta (sin cambio de comportamiento) y por el webhook de Zernio nuevo (Task 5).

Este es un refactor puro — mismo comportamiento, solo relocalizado. Next.js App Router no permite exports arbitrarios desde un `route.ts` (solo maneja HTTP + un puñado de exports especiales), así que estas dos funciones NO se pueden simplemente marcar `export` in situ — hay que moverlas a un módulo normal.

- [ ] **Step 1: Crear el módulo compartido con el código movido tal cual (adaptado a recibir `db`)**

```typescript
// src/lib/whatsapp/contact-conversation.ts
import type { SupabaseClient } from '@supabase/supabase-js'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ContactRow = any

export interface ContactOutcome {
  contact: ContactRow
  /** True when this call created the row. */
  wasCreated: boolean
}

/**
 * Find or create a contact by phone within an account. Shared by every
 * inbound webhook (Meta direct, Zernio) so "same number" logic agrees
 * everywhere (issue #212).
 */
export async function findOrCreateContact(
  db: SupabaseClient,
  accountId: string,
  configOwnerUserId: string,
  phone: string,
  name: string
): Promise<ContactOutcome | null> {
  const existingContact = await findExistingContact(db, accountId, phone)

  if (existingContact) {
    if (name && name !== existingContact.name) {
      await db
        .from('contacts')
        .update({ name, updated_at: new Date().toISOString() })
        .eq('id', existingContact.id)
    }
    return { contact: existingContact, wasCreated: false }
  }

  const { data: newContact, error: createError } = await db
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      phone,
      name: name || phone,
    })
    .select()
    .single()

  if (createError) {
    if (isUniqueViolation(createError)) {
      const raced = await findExistingContact(db, accountId, phone)
      if (raced) return { contact: raced, wasCreated: false }
    }
    console.error('Error creating contact:', createError)
    return null
  }

  return { contact: newContact, wasCreated: true }
}

/**
 * Find or create a conversation for a contact within an account,
 * oldest-first so pre-existing duplicates converge on one canonical row
 * (issue #363).
 */
export async function findOrCreateConversation(
  db: SupabaseClient,
  accountId: string,
  configOwnerUserId: string,
  contactId: string,
) {
  const { data: existingRows, error: findError } = await db
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: true })
    .limit(1)

  if (findError) {
    console.error('Error finding conversation:', findError)
    return null
  }

  if (existingRows && existingRows.length > 0) {
    return { conversation: existingRows[0], created: false }
  }

  const { data: newConv, error: createError } = await db
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      contact_id: contactId,
    })
    .select()
    .single()

  if (createError) {
    if (isUniqueViolation(createError)) {
      const { data: raced } = await db
        .from('conversations')
        .select('*')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .order('created_at', { ascending: true })
        .limit(1)
      if (raced && raced.length > 0) {
        return { conversation: raced[0], created: false }
      }
    }
    console.error('Error creating conversation:', createError)
    return null
  }

  return { conversation: newConv, created: true }
}
```

- [ ] **Step 2: Actualizar `route.ts` para importar y pasar `db` explícito**

En `src/app/api/whatsapp/webhook/route.ts`:

1. Agregar el import cerca de los demás:

```typescript
import { findOrCreateContact, findOrCreateConversation } from '@/lib/whatsapp/contact-conversation'
```

2. Borrar por completo las definiciones locales de `findOrCreateContact` (líneas 1115-1173 del archivo actual) y `findOrCreateConversation` (líneas 1175-1244), junto con el `interface ContactOutcome` y el `type ContactRow` locales (ya viven en el módulo nuevo) — también se puede borrar el import de `findExistingContact, isUniqueViolation` de `@/lib/contacts/dedupe` en este archivo si no se usa en ningún otro lado del route.

3. En `processMessage`, donde hoy dice:

```typescript
  const contactOutcome = await findOrCreateContact(
    accountId,
    configOwnerUserId,
    senderPhone,
    contactName
  )
```

cambiar a:

```typescript
  const contactOutcome = await findOrCreateContact(
    supabaseAdmin(),
    accountId,
    configOwnerUserId,
    senderPhone,
    contactName
  )
```

4. Donde hoy dice:

```typescript
  const convResult = await findOrCreateConversation(
    accountId,
    configOwnerUserId,
    contactRecord.id
  )
```

cambiar a:

```typescript
  const convResult = await findOrCreateConversation(
    supabaseAdmin(),
    accountId,
    configOwnerUserId,
    contactRecord.id
  )
```

- [ ] **Step 3: Correr el typecheck y la suite completa — debe seguir en verde sin cambios en los mocks**

Run: `npm run typecheck && npx vitest run src/app/api/whatsapp/webhook/route.test.ts`
Expected: ambos en verde. El mock de `route.test.ts` intercepta `@supabase/supabase-js` (la llamada `createClient`), no las funciones movidas — la cadena de llamadas a `db.from(...)` es idéntica a antes, así que el mock existente sigue sirviendo sin tocarlo.

- [ ] **Step 4: Commit**

```bash
git add src/lib/whatsapp/contact-conversation.ts src/app/api/whatsapp/webhook/route.ts
git commit -m "refactor(whatsapp): extract findOrCreateContact/Conversation to a shared module"
```

---

### Task 4: Migración de esquema + fila de prueba

**Files:**
- Create: `supabase/migrations/041_zernio_conversation_id.sql`
- (Documentado, NO versionado como migración): SQL manual para la fila de prueba de Sebas.

**Interfaces:**
- Consumes: proyecto Supabase de Sebas (mismo de Fase 1).
- Produces: `conversations.zernio_conversation_id` — usada por Task 5 (se escribe al recibir el primer inbound) y Task 6 (se lee al mandar por Zernio).

- [ ] **Step 1: Escribir la migración (schema-only, igual que la 040)**

```sql
-- supabase/migrations/041_zernio_conversation_id.sql
-- ============================================================
-- zernio_conversation_id: guarda el conversationId interno de Zernio
-- para una conversación, cuando esa cuenta usa messaging_provider =
-- 'zernio'. Se necesita porque el endpoint de envío libre de Zernio
-- (POST /v1/inbox/conversations/{conversationId}/messages) requiere
-- SU conversationId, no el nuestro — se recibe por primera vez en el
-- payload del webhook message.received y se persiste ahí.
--
-- Nullable y sin CHECK: las cuentas meta_direct nunca lo usan.
-- Idempotente — seguro de re-ejecutar.
-- ============================================================

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS zernio_conversation_id TEXT;

CREATE INDEX IF NOT EXISTS idx_conversations_zernio_conversation_id
  ON conversations (zernio_conversation_id)
  WHERE zernio_conversation_id IS NOT NULL;
```

- [ ] **Step 2: Aplicar la migración**

```bash
cd C:\Users\sebju\crm
npx supabase db push
```

- [ ] **Step 3: Verificar en Supabase SQL Editor**

```sql
SELECT column_name FROM information_schema.columns
WHERE table_name = 'conversations' AND column_name = 'zernio_conversation_id';
```

Expected: 1 fila.

- [ ] **Step 4: Commit de la migración**

```bash
git add supabase/migrations/041_zernio_conversation_id.sql
git commit -m "feat: add conversations.zernio_conversation_id (schema-only)"
```

- [ ] **Step 5: Flipear la fila de prueba (SQL manual, NO es una migración — correrlo una sola vez en el SQL Editor de Supabase, no versionarlo)**

```sql
UPDATE whatsapp_config
SET messaging_provider = 'zernio',
    zernio_credentials = '{"accountId": "6a9cafed77555aae01e2a7a2"}'::jsonb
WHERE phone_number_id = (
  -- reemplazar por el valor real de WHATSAPP_PHONE_ID de tu .env raíz
  -- (el número de prueba de Meta, el mismo que usa ACP)
  'PEGAR_AQUI_EL_PHONE_NUMBER_ID'
);
```

Verificar:

```sql
SELECT phone_number_id, messaging_provider, zernio_credentials FROM whatsapp_config;
```

Expected: la fila del número de prueba muestra `messaging_provider = 'zernio'` y `zernio_credentials = {"accountId": "6a9cafed77555aae01e2a7a2"}`.

---

### Task 5: Ruta del webhook de Zernio

**Files:**
- Create: `src/app/api/zernio/webhook/route.ts`
- Test: `src/app/api/zernio/webhook/route.test.ts`

**Interfaces:**
- Consumes: `verifyZernioWebhookSignature` (Task 1), `findOrCreateContact`/`findOrCreateConversation` (Task 3), `reopenClosedConversation` (ya existe en `@/lib/conversations/reopen`), `dispatchInboundToAiReply` (ya existe en `@/lib/ai/auto-reply`), columna `zernio_conversation_id` (Task 4).
- Produces: endpoint público `POST /api/zernio/webhook` — URL a registrar en Task 7.

- [ ] **Step 1: Escribir el test que falla**

```typescript
// src/app/api/zernio/webhook/route.test.ts
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
  },
}))

vi.mock('next/server', () => ({
  after: (cb: () => Promise<void> | void) => cb(),
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
            select: () => ({ eq: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) }),
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
})

describe('POST /api/zernio/webhook', () => {
  it('rejects a request with an invalid signature', async () => {
    const body = JSON.stringify(messageReceivedPayload())
    const req = new Request('http://test/api/zernio/webhook', {
      method: 'POST',
      body,
      headers: { 'x-zernio-signature': 'bad' },
    })
    const res = await POST(req)
    expect(res.init?.status).toBe(401)
  })

  it('processes a text message.received event: creates the conversation link and triggers AI auto-reply', async () => {
    const body = JSON.stringify(messageReceivedPayload())
    const req = new Request('http://test/api/zernio/webhook', {
      method: 'POST',
      body,
      headers: { 'x-zernio-signature': sign(body) },
    })
    const res = await POST(req)
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
    await POST(req)
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
    await POST(req)
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
    await POST(req)
    expect(h.dispatchInboundToAiReply).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Correr el test y confirmar que falla**

Run: `npx vitest run src/app/api/zernio/webhook/route.test.ts`
Expected: FAIL — `Cannot find module './route'`

- [ ] **Step 3: Implementación**

```typescript
// src/app/api/zernio/webhook/route.ts
import { NextResponse, after } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { verifyZernioWebhookSignature } from '@/lib/whatsapp/zernio-signature'
import { findOrCreateContact, findOrCreateConversation } from '@/lib/whatsapp/contact-conversation'
import { reopenClosedConversation } from '@/lib/conversations/reopen'
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'

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

  const senderPhone = payload.message.sender.phoneNumber
  if (!senderPhone) {
    // BSUID-only sender (Meta's April 2026+ rollout) — not supported in v1.
    console.warn('[zernio-webhook] message has no sender.phoneNumber; skipping:', payload.message.id)
    return
  }
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
```

- [ ] **Step 4: Correr el test y confirmar que pasa**

Run: `npx vitest run src/app/api/zernio/webhook/route.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Typecheck completo**

Run: `npm run typecheck`
Expected: sin errores.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/zernio/webhook/route.ts src/app/api/zernio/webhook/route.test.ts
git commit -m "feat(zernio): add inbound webhook route (text messages, v1 scope)"
```

---

### Task 6: Bifurcar el envío de la IA a Zernio

**Files:**
- Modify: `src/lib/flows/meta-send.ts:65-151` (función `engineSendText`, la única que usa `dispatchInboundToAiReply`)
- Create: `src/lib/flows/meta-send.test.ts` (no existe todavía — este archivo cubre `engineSendText` desde cero: el path `meta_direct` existente + el path `zernio` nuevo)

**Interfaces:**
- Consumes: `sendZernioText` (Task 2), `whatsapp_config.messaging_provider` / `.zernio_credentials` (migración 040), `conversations.zernio_conversation_id` (Task 4).
- Produces: comportamiento sin cambios para `meta_direct`; camino nuevo para `zernio`.

- [ ] **Step 1: Escribir el archivo de test completo (falla porque el branch de Zernio no existe todavía)**

```typescript
// src/lib/flows/meta-send.test.ts
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
      expect.objectContaining({ phoneNumberId: 'phone-1', to: '+59171234567', text: 'Hola' })
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
```

- [ ] **Step 2: Correr el test y confirmar que falla**

Run: `npx vitest run src/lib/flows/meta-send.test.ts`
Expected: FAIL — el branch de Zernio no existe todavía, así que `engineSendText` sigue derecho al path de Meta (`decrypt`/`sendTextMessage`) y los 3 tests del describe `zernio` fallan; el describe `meta_direct` debería pasar ya (es el comportamiento actual, confirma la línea base antes de tocar código).

- [ ] **Step 3: Implementación — agregar el branch ANTES del path existente de Meta**

En `src/lib/flows/meta-send.ts`, importar el nuevo cliente junto a los imports existentes:

```typescript
import { sendZernioText } from '@/lib/whatsapp/zernio-api'
```

Dentro de `engineSendText`, justo después de:

```typescript
  const { data: config, error: configErr } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', args.accountId)
    .single()
  if (configErr || !config) {
    throw new Error('WhatsApp not configured for this account')
  }
```

agregar el branch (antes de `const accessToken = decrypt(config.access_token)`, que solo hace falta en el path de Meta):

```typescript
  if (config.messaging_provider === 'zernio') {
    const { data: conversationRow, error: convErr } = await db
      .from('conversations')
      .select('zernio_conversation_id')
      .eq('id', args.conversationId)
      .single()
    if (convErr || !conversationRow?.zernio_conversation_id) {
      throw new Error(
        'conversation has no zernio_conversation_id yet — cannot send via Zernio before the contact has messaged in'
      )
    }
    const zernioAccountId = (config.zernio_credentials as { accountId?: string } | null)?.accountId
    if (!zernioAccountId) {
      throw new Error('whatsapp_config.zernio_credentials.accountId is missing')
    }

    const result = await sendZernioText({
      accountId: zernioAccountId,
      conversationId: conversationRow.zernio_conversation_id,
      message: args.text,
    })

    const { error: msgErr } = await db.from('messages').insert({
      conversation_id: args.conversationId,
      sender_type: 'bot',
      content_type: 'text',
      content_text: args.text,
      message_id: result.messageId,
      status: 'sent',
      ai_generated: args.aiGenerated ?? false,
    })
    if (msgErr) {
      throw new Error(`sent to Zernio but DB insert failed: ${msgErr.message}`)
    }

    await db
      .from('conversations')
      .update({
        last_message_text: args.text,
        last_message_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', args.conversationId)

    return { whatsapp_message_id: result.messageId }
  }

  const accessToken = decrypt(config.access_token)
```

El resto de la función (path `meta_direct`) queda exactamente igual, sin tocar una línea.

- [ ] **Step 4: Correr los tests y confirmar que todo pasa (branch nuevo + suite existente de Meta)**

Run: `npx vitest run src/lib/flows/meta-send.test.ts`
Expected: PASS, incluyendo los tests preexistentes del path `meta_direct` (deben seguir pasando sin cambios).

- [ ] **Step 5: Typecheck completo**

Run: `npm run typecheck`
Expected: sin errores.

- [ ] **Step 6: Commit**

```bash
git add src/lib/flows/meta-send.ts src/lib/flows/meta-send.test.ts
git commit -m "feat(zernio): branch AI auto-reply send on messaging_provider"
```

---

### Task 7: Registrar el webhook, configurar env vars, y probar end-to-end real

**Files:** Ninguno de código — configuración + prueba manual.

**Interfaces:**
- Consumes: todo lo de Tasks 1-6, desplegado en EasyPanel.
- Produces: el criterio de éxito de esta fase — mismo que Fase 1 pero vía Zernio.

- [ ] **Step 1: Generar `ZERNIO_WEBHOOK_SECRET`**

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Guardar el valor generado — se usa en los dos pasos siguientes.

- [ ] **Step 2: Configurar variables de entorno**

En `.env.local` (local) y en las variables de entorno del servicio `crm` en EasyPanel (producción), agregar:

```
ZERNIO_API_KEY=<tu API key de Zernio>
ZERNIO_WEBHOOK_SECRET=<el valor generado en el Step 1>
```

Ninguna de las dos es `NEXT_PUBLIC_*` — son server-only, igual que `META_APP_SECRET`.

- [ ] **Step 3: Registrar el webhook en Zernio**

```bash
curl -X POST "https://zernio.com/api/v1/webhooks/settings" \
  -H "Authorization: Bearer $ZERNIO_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "CRM inbox — WhatsApp",
    "url": "https://constructora-crm-crm.a2b1t3.easypanel.host/api/zernio/webhook",
    "secret": "'"$ZERNIO_WEBHOOK_SECRET"'",
    "events": ["message.received"],
    "isActive": true
  }'
```

Expected: `200` con el webhook creado. Guardar el `id` de la respuesta por si hace falta editarlo/borrarlo después.

- [ ] **Step 4: Correr el `UPDATE` manual de Task 4, Step 5** (si no se corrió todavía)

- [ ] **Step 5: Deploy**

```bash
cd C:\Users\sebju\crm
git push origin main
```

Esperar a que EasyPanel termine el build y el deploy del servicio `crm`.

- [ ] **Step 6: Verificar que el endpoint responde**

```bash
curl -s -o /dev/null -w "HTTP %{http_code}\n" -X POST https://constructora-crm-crm.a2b1t3.easypanel.host/api/zernio/webhook -d '{}'
```

Expected: `HTTP 401` (firma inválida, sin secret real) — confirma que la ruta existe y el guard de firma está activo, no que el evento se procesó.

- [ ] **Step 7: Prueba end-to-end real (mismo criterio de éxito que Fase 1, Task 3 Step 6)**

Desde un celular de prueba, enviar un WhatsApp al número de prueba (+1 555-649-0746) con el texto: `Hola, quiero información sobre materiales de construcción`.

Expected:
1. El mensaje aparece en el inbox del CRM en segundos.
2. La IA responde automáticamente — el envío ahora corre por `sendZernioText`, no por Meta directo.
3. El contacto aparece en Contactos y la conversación en el inbox (el Kanban no se puebla automáticamente en este alcance — eso depende de una automation con create_deal, fuera del alcance de esta fase).
4. En Supabase, la fila de `conversations` correspondiente tiene `zernio_conversation_id` poblado.

- [ ] **Step 8: Confirmar aislamiento del path `meta_direct`**

Si hay otra cuenta de prueba con `messaging_provider = 'meta_direct'` disponible, mandarle un mensaje y confirmar que sigue funcionando exactamente igual que antes (webhook de Meta directo, sin pasar por Zernio) — prueba de que el cambio es aditivo y no rompió nada.

---

## Cierre de esta Fase 2 (v1)

Al completar las Tasks 1-7, queda probado en la práctica si el diferencial real de Zernio (coexistencia con la app de WhatsApp Business del celular) funciona para el caso de uso del CRM — sobre el número de prueba, con el flujo mínimo (texto + IA + Kanban). Fuera de esta fase, explícitamente pendiente: conectar un número real de cliente vía el flujo de Embedded Signup con `onboarding=business_app` (coexistencia de verdad, requiere navegador — no es headless como el connect usado en esta fase), y dar soporte a Zernio en el composer manual, automations, flows, media y templates si el resultado de esta prueba justifica la inversión.
