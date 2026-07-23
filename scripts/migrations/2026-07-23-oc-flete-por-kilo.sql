-- ============================================================================
-- Migracion: costo de flete por kilo en la orden de compra
-- Schema: seguridadalimentariaerp  (EXCLUSIVO de esta instancia)
-- Fecha: 2026-07-23
--
-- El peso ya vive en `productos.peso_gramos`. Falta el otro dato de la formula
-- que pidio el cliente: cuanto cuesta el kilo de flete en ESE envio. Se guarda
-- en la orden y no en el producto porque cambia por embarque (courier, aereo,
-- maritimo), no por producto.
--
-- IMPORTANTE — que NO hace esto: el flete calculado es una ESTIMACION visible
-- al armar el pedido. NO se prorratea automaticamente al costo_promedio del
-- producto: eso es una decision contable (si el flete capitaliza al inventario
-- o va a gasto del periodo) que tiene que definir el contador de la cliente.
--
-- Append-only, idempotente. No toca otros schemas.
-- ============================================================================

SET search_path TO seguridadalimentariaerp, public;

ALTER TABLE seguridadalimentariaerp.ordenes_compra
  ADD COLUMN IF NOT EXISTS flete_por_kilo numeric NULL;

COMMENT ON COLUMN seguridadalimentariaerp.ordenes_compra.flete_por_kilo IS
  'Costo de flete por kilo pactado para este embarque, en la MONEDA de la orden. NULL = no se estimo flete. Solo referencia: no altera el costo del producto.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'seguridadalimentariaerp.ordenes_compra'::regclass
      AND conname = 'ordenes_compra_flete_por_kilo_check'
  ) THEN
    ALTER TABLE seguridadalimentariaerp.ordenes_compra
      ADD CONSTRAINT ordenes_compra_flete_por_kilo_check
      CHECK (flete_por_kilo IS NULL OR flete_por_kilo >= 0);
  END IF;
END $$;
