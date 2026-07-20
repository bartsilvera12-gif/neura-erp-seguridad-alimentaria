-- ============================================================================
-- Migracion: notificaciones de stock bajo.
-- Schema: seguridadalimentariaerp
-- Fecha: 2026-07-16
--
-- La columna `producto_id` ya existia en `notificaciones` (quedo reservada al
-- crear la tabla). Solo falta el indice de deduplicado para que un producto no
-- genere un aviso nuevo en cada barrido.
--
-- Append-only, idempotente.
-- ============================================================================

SET search_path TO seguridadalimentariaerp, public;

-- Dedupe: un solo aviso NO leido por (empresa, producto, tipo). Si el usuario
-- lo marca leido y el stock sigue bajo, una proxima evaluacion lo regenera.
CREATE UNIQUE INDEX IF NOT EXISTS notificaciones_activa_producto
  ON seguridadalimentariaerp.notificaciones (empresa_id, producto_id, tipo)
  WHERE leida = false AND producto_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS notificaciones_producto_idx
  ON seguridadalimentariaerp.notificaciones (empresa_id, producto_id)
  WHERE producto_id IS NOT NULL;
