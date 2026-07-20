-- ============================================================================
-- Migracion: notificaciones de ordenes de compra pendientes.
-- Schema: seguridadalimentariaerp
-- Fecha: 2026-07-16
--
-- Reutiliza la tabla `notificaciones` existente (la misma campanita) en vez de
-- crear un segundo sistema paralelo. Solo agrega el vinculo a la orden y su
-- indice de deduplicado, con la misma logica que ya tienen los documentos.
--
-- Append-only, idempotente.
-- ============================================================================

SET search_path TO seguridadalimentariaerp, public;

ALTER TABLE seguridadalimentariaerp.notificaciones
  ADD COLUMN IF NOT EXISTS numero_control text NULL;

COMMENT ON COLUMN seguridadalimentariaerp.notificaciones.numero_control IS
  'Orden de compra relacionada (COMP-XXXXXX). Se usa para deduplicar avisos de recepcion pendiente.';

-- Dedupe: un solo aviso NO leido por (empresa, orden, tipo). Si el usuario lo
-- marca leido y la orden sigue pendiente, una proxima evaluacion lo regenera.
CREATE UNIQUE INDEX IF NOT EXISTS notificaciones_activa_orden
  ON seguridadalimentariaerp.notificaciones (empresa_id, numero_control, tipo)
  WHERE leida = false AND numero_control IS NOT NULL;

CREATE INDEX IF NOT EXISTS notificaciones_orden_idx
  ON seguridadalimentariaerp.notificaciones (empresa_id, numero_control)
  WHERE numero_control IS NOT NULL;
