-- ============================================================
-- 040_messaging_provider
--
-- Schema-only groundwork for the Zernio adapter (Fase 2 del
-- proyecto CRM híbrido — ver docs/superpowers/plans/
-- 2026-08-21-crm-whatsapp-hibrido.md). NADA de código lee estas
-- columnas todavía.
--
--   * messaging_provider — indica si el envío/recepción de una fila
--     de whatsapp_config se hace via la API directa de Meta
--     ('meta_direct', el caso actual/interino) o via Zernio
--     ('zernio', Fase 2, multi-dispositivo).
--
--   * zernio_credentials — JSONB flexible (no columnas fijas por
--     campo) porque a la fecha de esta migración todavía no hay
--     acceso a la documentación real de la API de Zernio. Cuando se
--     conozca el esquema real, una migración futura puede normalizar
--     campos específicos si hace falta.
--
-- Backfill: toda fila existente (creada via Meta directo) recibe
-- 'meta_direct' por el DEFAULT — no rompe nada.
--
-- Idempotente — seguro de re-ejecutar.
-- ============================================================

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS messaging_provider TEXT NOT NULL DEFAULT 'meta_direct'
    CHECK (messaging_provider IN ('meta_direct', 'zernio')),
  ADD COLUMN IF NOT EXISTS zernio_credentials JSONB;
