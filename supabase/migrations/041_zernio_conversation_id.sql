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
