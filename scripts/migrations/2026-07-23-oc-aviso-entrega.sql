-- ============================================================================
-- Migracion: dias de aviso previo por orden de compra
-- Schema: seguridadalimentariaerp  (EXCLUSIVO de esta instancia)
-- Fecha: 2026-07-23
--
-- `ordenes_compra.fecha_estimada_llegada` ya existia y el evaluador de
-- notificaciones ya la leia, pero NINGUNA pantalla la escribia: quedaba
-- siempre NULL y los avisos de "por llegar" / "atrasada" nunca se disparaban.
-- Ahora la fecha se carga desde el alta de la orden y desde la recepcion
-- parcial (para el saldo que queda).
--
-- El umbral de aviso estaba fijo en 3 dias dentro del codigo. Se vuelve
-- configurable POR ORDEN, igual que en el modulo Documentos: un pedido por
-- courier no necesita el mismo anticipo que uno maritimo.
--
-- Append-only, idempotente. No toca otros schemas.
-- ============================================================================

SET search_path TO seguridadalimentariaerp, public;

ALTER TABLE seguridadalimentariaerp.ordenes_compra
  ADD COLUMN IF NOT EXISTS dias_aviso_previo integer NOT NULL DEFAULT 3;

COMMENT ON COLUMN seguridadalimentariaerp.ordenes_compra.dias_aviso_previo IS
  'Cuantos dias antes de la fecha estimada de llegada avisar por la campanita. Default 3.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'seguridadalimentariaerp.ordenes_compra'::regclass
      AND conname = 'ordenes_compra_dias_aviso_check'
  ) THEN
    ALTER TABLE seguridadalimentariaerp.ordenes_compra
      ADD CONSTRAINT ordenes_compra_dias_aviso_check
      CHECK (dias_aviso_previo >= 0 AND dias_aviso_previo <= 365);
  END IF;
END $$;

-- Indice para el evaluador de notificaciones: busca ordenes con saldo abierto.
CREATE INDEX IF NOT EXISTS ordenes_compra_pendientes_idx
  ON seguridadalimentariaerp.ordenes_compra (empresa_id, estado, fecha_estimada_llegada)
  WHERE cancelada_at IS NULL;
