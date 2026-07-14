-- ============================================================================
-- Migracion: Cajas (turnos abrir/cerrar) + movimientos manuales + arqueo.
-- Schema: seguridadalimentariaerp
-- Fecha: 2026-07-14
--
-- Port del modulo de caja de ferreteriarepublica, consolidando en un solo
-- archivo lo que alla quedo repartido en cuatro migraciones:
--   2026-06-26-cajas.sql                  (tablas base + ventas.caja_id)
--   2026-06-26-otros-ingresos.sql         (anulacion soft de movimientos)
--   2026-07-08-caja-arqueo-denominaciones (arqueo json apertura/cierre)
--   2026-07-08-multi-caja.sql             (numero_caja + estado 'en_cierre')
--
-- Idempotente, no destructiva.
-- ============================================================================

SET search_path TO seguridadalimentariaerp, public;

-- ---------------------------------------------------------------------------
-- 1) Tabla cajas (cada fila = un TURNO: apertura -> [en_cierre] -> cerrada)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS seguridadalimentariaerp.cajas (
  id                          uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  empresa_id                  uuid NOT NULL,
  estado                      text NOT NULL DEFAULT 'abierta'
                              CHECK (estado IN ('abierta', 'en_cierre', 'cerrada')),
  numero_caja                 integer NOT NULL DEFAULT 1,
  abierta_por                 uuid NULL,
  cerrada_por                 uuid NULL,
  fecha_apertura              timestamp with time zone NOT NULL DEFAULT now(),
  fecha_cierre                timestamp with time zone NULL,
  monto_apertura              numeric NOT NULL DEFAULT 0,
  -- Al cerrar: lo que efectivamente conto el cajero.
  monto_cierre_contado        numeric NULL,
  -- Al cerrar: lo que el sistema calculo que deberia haber (verdad del arqueo).
  monto_esperado_efectivo     numeric NULL,
  -- contado - esperado (positivo = sobra, negativo = falta).
  diferencia                  numeric NULL,
  -- Detalle del conteo fisico por denominacion (no solo el total).
  arqueo_apertura_json        jsonb NULL,
  arqueo_cierre_json          jsonb NULL,
  observacion_apertura        text NULL,
  observacion_cierre          text NULL,
  created_at                  timestamp with time zone NOT NULL DEFAULT now(),
  updated_at                  timestamp with time zone NOT NULL DEFAULT now()
);

-- Columnas agregadas si la tabla ya existia de una corrida previa parcial.
ALTER TABLE seguridadalimentariaerp.cajas
  ADD COLUMN IF NOT EXISTS numero_caja          integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS arqueo_apertura_json jsonb,
  ADD COLUMN IF NOT EXISTS arqueo_cierre_json   jsonb;

ALTER TABLE seguridadalimentariaerp.cajas DROP CONSTRAINT IF EXISTS cajas_estado_check;
ALTER TABLE seguridadalimentariaerp.cajas
  ADD CONSTRAINT cajas_estado_check
  CHECK (estado IN ('abierta', 'en_cierre', 'cerrada'));

-- A lo sumo UN turno activo (abierta o en_cierre) por punto de caja. Permite
-- Caja 1 y Caja 2 simultaneas, pero no dos turnos sobre el mismo numero.
CREATE UNIQUE INDEX IF NOT EXISTS cajas_activa_por_numero
  ON seguridadalimentariaerp.cajas (empresa_id, numero_caja)
  WHERE estado IN ('abierta', 'en_cierre');

CREATE INDEX IF NOT EXISTS cajas_empresa_fecha_idx
  ON seguridadalimentariaerp.cajas (empresa_id, fecha_apertura DESC);

CREATE INDEX IF NOT EXISTS cajas_empresa_estado_idx
  ON seguridadalimentariaerp.cajas (empresa_id, estado);

-- ---------------------------------------------------------------------------
-- 2) Tabla caja_movimientos (ingresos / egresos / retiros / ajustes manuales)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS seguridadalimentariaerp.caja_movimientos (
  id              uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  empresa_id      uuid NOT NULL,
  caja_id         uuid NOT NULL,
  tipo            text NOT NULL CHECK (tipo IN ('ingreso','egreso','retiro','ajuste')),
  concepto        text NOT NULL,
  monto           numeric NOT NULL,
  medio_pago      text NOT NULL DEFAULT 'efectivo'
                  CHECK (medio_pago IN ('efectivo','tarjeta','transferencia','otro')),
  usuario_id      uuid NULL,
  usuario_email   text NULL,
  observacion     text NULL,
  created_at      timestamp with time zone NOT NULL DEFAULT now(),
  -- Anulacion soft: los anulados NO suman a caja.
  anulado_at      timestamp with time zone NULL,
  anulado_por_id  uuid NULL,
  anulado_motivo  text NULL,
  CONSTRAINT caja_movimientos_caja_fk
    FOREIGN KEY (caja_id) REFERENCES seguridadalimentariaerp.cajas(id) ON DELETE CASCADE
);

ALTER TABLE seguridadalimentariaerp.caja_movimientos
  ADD COLUMN IF NOT EXISTS anulado_at      timestamp with time zone NULL,
  ADD COLUMN IF NOT EXISTS anulado_por_id  uuid NULL,
  ADD COLUMN IF NOT EXISTS anulado_motivo  text NULL,
  ADD COLUMN IF NOT EXISTS usuario_email   text NULL;

CREATE INDEX IF NOT EXISTS caja_movimientos_caja_idx
  ON seguridadalimentariaerp.caja_movimientos (caja_id, created_at);

CREATE INDEX IF NOT EXISTS caja_movimientos_empresa_idx
  ON seguridadalimentariaerp.caja_movimientos (empresa_id, created_at DESC);

CREATE INDEX IF NOT EXISTS caja_movimientos_tipo_estado_fecha_idx
  ON seguridadalimentariaerp.caja_movimientos
    (empresa_id, tipo, (anulado_at IS NULL), created_at DESC);

-- ---------------------------------------------------------------------------
-- 3) ventas.caja_id (nullable, compat con ventas existentes)
-- ---------------------------------------------------------------------------
ALTER TABLE seguridadalimentariaerp.ventas
  ADD COLUMN IF NOT EXISTS caja_id uuid NULL;

COMMENT ON COLUMN seguridadalimentariaerp.ventas.caja_id IS
  'FK a cajas. NULL si la venta se hizo sin caja abierta (modo legacy o pre-funcionalidad). El cierre de caja agrupa ventas por este campo, no por fecha calendario.';

CREATE INDEX IF NOT EXISTS ventas_caja_idx
  ON seguridadalimentariaerp.ventas (empresa_id, caja_id);

-- ---------------------------------------------------------------------------
-- 4) Trigger touch updated_at
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION seguridadalimentariaerp.touch_cajas_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS cajas_touch ON seguridadalimentariaerp.cajas;
CREATE TRIGGER cajas_touch
  BEFORE UPDATE ON seguridadalimentariaerp.cajas
  FOR EACH ROW
  EXECUTE FUNCTION seguridadalimentariaerp.touch_cajas_updated_at();
