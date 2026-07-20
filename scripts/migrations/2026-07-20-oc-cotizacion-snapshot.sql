-- ============================================================================
-- Migracion: snapshot de cotizacion en ordenes de compra
-- Schema: seguridadalimentariaerp  (EXCLUSIVO de esta instancia)
-- Fecha: 2026-07-20
--
-- `compras` ya guardaba de que fuente y de que fecha salio el tipo de cambio
-- usado (migracion 2026-07-16). Las ordenes de compra nacieron sin esas
-- columnas, asi que una OC en USD guardaba el tipo_cambio pero no de donde
-- salio: imposible auditar despues si alguien lo corrigio a mano.
--
-- Append-only, idempotente. No toca otros schemas.
-- ============================================================================

SET search_path TO seguridadalimentariaerp, public;

ALTER TABLE seguridadalimentariaerp.ordenes_compra
  ADD COLUMN IF NOT EXISTS cotizacion_fuente    text NULL,
  ADD COLUMN IF NOT EXISTS cotizacion_fecha     timestamptz NULL,
  ADD COLUMN IF NOT EXISTS cotizacion_es_manual boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN seguridadalimentariaerp.ordenes_compra.cotizacion_fuente IS
  'Proveedor de la cotizacion usada (o "manual"). NULL en ordenes en PYG.';
COMMENT ON COLUMN seguridadalimentariaerp.ordenes_compra.cotizacion_es_manual IS
  'true si el usuario corrigio a mano el tipo de cambio sugerido. Queda auditado.';

-- Historicas: las OC en PYG no tienen cotizacion que auditar; las que ya
-- existan en USD quedan con fuente NULL porque no hay dato para inventar.
