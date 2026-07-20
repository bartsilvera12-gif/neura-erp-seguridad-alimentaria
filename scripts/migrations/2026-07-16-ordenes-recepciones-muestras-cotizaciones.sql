-- ============================================================================
-- Migracion integral — Seguridad Alimentaria
-- Schema: seguridadalimentariaerp  (EXCLUSIVO de esta instancia)
-- Fecha: 2026-07-16
--
-- Cubre:
--   1) Ordenes de compra con recepciones parciales (compras + 2 tablas nuevas)
--   2) Muestras / regalos en ventas (ventas_items + movimientos_inventario)
--   3) Snapshot de costo y ganancia en PYG por linea de venta
--   4) Cotizaciones de moneda (USD -> PYG) con fuente y auditoria
--   5) CRM: responsable_usuario_id + seed de etapas
--   6) Habilitar modulos presupuestos y crm para la empresa
--
-- Reglas: append-only, idempotente, re-ejecutable, compatible con datos
-- historicos. NO toca otros schemas ni otros clientes.
-- ============================================================================

SET search_path TO seguridadalimentariaerp, public;

-- ############################################################################
-- 1) ORDENES DE COMPRA + RECEPCIONES PARCIALES
-- ############################################################################

-- ---------------------------------------------------------------------------
-- 1.1 Campos de recepcion en `compras` (cada fila = una linea de la orden,
--     agrupadas por numero_control).
--     `estado` (financiero) NO se toca: la recepcion vive en su propio campo.
-- ---------------------------------------------------------------------------
ALTER TABLE seguridadalimentariaerp.compras
  ADD COLUMN IF NOT EXISTS cantidad_recibida        numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS estado_recepcion         text    NOT NULL DEFAULT 'pendiente',
  ADD COLUMN IF NOT EXISTS fecha_estimada_llegada   date    NULL,
  ADD COLUMN IF NOT EXISTS fecha_ultima_recepcion   timestamptz NULL,
  ADD COLUMN IF NOT EXISTS recepcion_completada_at  timestamptz NULL;

-- Snapshot de cotizacion usada (para compras en USD). Append-only.
ALTER TABLE seguridadalimentariaerp.compras
  ADD COLUMN IF NOT EXISTS cotizacion_fuente      text NULL,
  ADD COLUMN IF NOT EXISTS cotizacion_fecha       timestamptz NULL,
  ADD COLUMN IF NOT EXISTS cotizacion_es_manual   boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN seguridadalimentariaerp.compras.cantidad_recibida IS
  'Unidades efectivamente recibidas de esta linea. Solo la mueve el flujo de recepciones.';
COMMENT ON COLUMN seguridadalimentariaerp.compras.estado_recepcion IS
  'pendiente | parcial | completa | cancelada. Independiente de `estado` (financiero).';
COMMENT ON COLUMN seguridadalimentariaerp.compras.cotizacion_fuente IS
  'Origen de la cotizacion aplicada (ej. proveedor externo, manual). NULL en PYG.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'seguridadalimentariaerp.compras'::regclass
      AND conname = 'compras_estado_recepcion_check'
  ) THEN
    ALTER TABLE seguridadalimentariaerp.compras
      ADD CONSTRAINT compras_estado_recepcion_check
      CHECK (estado_recepcion IN ('pendiente', 'parcial', 'completa', 'cancelada'));
  END IF;

  -- No se puede recibir mas de lo pedido ni cantidades negativas.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'seguridadalimentariaerp.compras'::regclass
      AND conname = 'compras_cantidad_recibida_check'
  ) THEN
    ALTER TABLE seguridadalimentariaerp.compras
      ADD CONSTRAINT compras_cantidad_recibida_check
      CHECK (cantidad_recibida >= 0 AND cantidad_recibida <= cantidad);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1.2 `nro_timbrado` pasa a NULLABLE: una orden puede crearse ANTES de recibir
--     la factura del proveedor. Las filas historicas ya tienen valor, asi que
--     el cambio no las afecta ni rompe reportes fiscales.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'seguridadalimentariaerp' AND table_name = 'compras'
      AND column_name = 'nro_timbrado' AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE seguridadalimentariaerp.compras ALTER COLUMN nro_timbrado DROP NOT NULL;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1.4 Cabecera de recepcion
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS seguridadalimentariaerp.compras_recepciones (
  id                 uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  empresa_id         uuid NOT NULL,
  numero_control     text NOT NULL,
  fecha_recepcion    timestamptz NOT NULL DEFAULT now(),
  observaciones      text NULL,
  -- Fecha estimada declarada para el saldo pendiente al momento de recibir.
  proxima_entrega_estimada date NULL,
  created_by         uuid NULL,
  usuario_nombre     text NULL,
  -- Idempotencia: el cliente manda una clave; un reintento/doble clic no
  -- duplica la recepcion (unique parcial mas abajo).
  idempotency_key    text NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS compras_recepciones_empresa_idx
  ON seguridadalimentariaerp.compras_recepciones (empresa_id, numero_control, fecha_recepcion DESC);

CREATE UNIQUE INDEX IF NOT EXISTS compras_recepciones_idem_uq
  ON seguridadalimentariaerp.compras_recepciones (empresa_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 1.5 Detalle de recepcion
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS seguridadalimentariaerp.compras_recepciones_items (
  id                            uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  empresa_id                    uuid NOT NULL,
  recepcion_id                  uuid NOT NULL
                                REFERENCES seguridadalimentariaerp.compras_recepciones(id) ON DELETE CASCADE,
  compra_id                     uuid NOT NULL
                                REFERENCES seguridadalimentariaerp.compras(id) ON DELETE RESTRICT,
  producto_id                   uuid NOT NULL,
  producto_nombre               text NULL,
  cantidad_recibida             numeric NOT NULL CHECK (cantidad_recibida > 0),
  -- Costo con el que entro al inventario (ya convertido a PYG).
  costo_unitario_pyg_snapshot   numeric NOT NULL DEFAULT 0,
  movimiento_id                 uuid NULL,
  created_at                    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS compras_recepciones_items_recepcion_idx
  ON seguridadalimentariaerp.compras_recepciones_items (recepcion_id);
CREATE INDEX IF NOT EXISTS compras_recepciones_items_compra_idx
  ON seguridadalimentariaerp.compras_recepciones_items (compra_id);
CREATE INDEX IF NOT EXISTS compras_recepciones_items_empresa_idx
  ON seguridadalimentariaerp.compras_recepciones_items (empresa_id, created_at DESC);

-- Indices para el listado y el barrido de notificaciones.
CREATE INDEX IF NOT EXISTS compras_estado_recepcion_idx
  ON seguridadalimentariaerp.compras (empresa_id, estado_recepcion);
CREATE INDEX IF NOT EXISTS compras_fecha_estimada_idx
  ON seguridadalimentariaerp.compras (empresa_id, fecha_estimada_llegada)
  WHERE estado_recepcion IN ('pendiente', 'parcial');

-- ---------------------------------------------------------------------------
-- 1.6 Backfill historico (va DESPUES de crear las tablas de recepcion porque
--     consulta compras_recepciones_items).
--
--     Lo ya comprado YA impacto inventario: se marca como completamente
--     recibido. NO genera movimientos ni vuelve a tocar stock. Idempotente:
--     solo toca filas que siguen en el default (0 recibido / 'pendiente') y
--     nunca pisa una recepcion real ya registrada.
-- ---------------------------------------------------------------------------
UPDATE seguridadalimentariaerp.compras c
SET cantidad_recibida       = c.cantidad,
    estado_recepcion        = CASE WHEN c.anulada_at IS NOT NULL THEN 'cancelada' ELSE 'completa' END,
    recepcion_completada_at = COALESCE(c.recepcion_completada_at, c.created_at),
    fecha_ultima_recepcion  = COALESCE(c.fecha_ultima_recepcion, c.created_at)
WHERE c.cantidad_recibida = 0
  AND c.estado_recepcion = 'pendiente'
  AND NOT EXISTS (
    SELECT 1 FROM seguridadalimentariaerp.compras_recepciones_items ri
    WHERE ri.compra_id = c.id
  );

-- ############################################################################
-- 2) MUESTRAS Y REGALOS + SNAPSHOT DE COSTO/GANANCIA EN VENTAS
-- ############################################################################

ALTER TABLE seguridadalimentariaerp.ventas_items
  ADD COLUMN IF NOT EXISTS tipo_salida                 text NOT NULL DEFAULT 'venta',
  ADD COLUMN IF NOT EXISTS motivo_salida               text NULL,
  ADD COLUMN IF NOT EXISTS costo_unitario_snapshot_pyg numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS costo_total_snapshot_pyg    numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ganancia_pyg                numeric NOT NULL DEFAULT 0;

COMMENT ON COLUMN seguridadalimentariaerp.ventas_items.tipo_salida IS
  'venta | muestra | regalo. Muestra/regalo salen a precio 0 pero descuentan stock.';
COMMENT ON COLUMN seguridadalimentariaerp.ventas_items.costo_unitario_snapshot_pyg IS
  'Costo promedio del producto en PYG AL MOMENTO de la venta. Congelado: los reportes historicos no se recalculan con el costo de hoy.';
COMMENT ON COLUMN seguridadalimentariaerp.ventas_items.ganancia_pyg IS
  'total_linea - costo_total_snapshot_pyg. Negativa en muestras/regalos (ingreso 0, costo real).';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'seguridadalimentariaerp.ventas_items'::regclass
      AND conname = 'ventas_items_tipo_salida_check'
  ) THEN
    ALTER TABLE seguridadalimentariaerp.ventas_items
      ADD CONSTRAINT ventas_items_tipo_salida_check
      CHECK (tipo_salida IN ('venta', 'muestra', 'regalo'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ventas_items_tipo_salida_idx
  ON seguridadalimentariaerp.ventas_items (empresa_id, tipo_salida, created_at DESC)
  WHERE tipo_salida <> 'venta';

-- Trazabilidad en el movimiento de inventario (sin romper los historicos).
ALTER TABLE seguridadalimentariaerp.movimientos_inventario
  ADD COLUMN IF NOT EXISTS tipo_salida    text NULL,
  ADD COLUMN IF NOT EXISTS motivo_salida  text NULL,
  ADD COLUMN IF NOT EXISTS compra_id      uuid NULL,
  ADD COLUMN IF NOT EXISTS recepcion_id   uuid NULL;

CREATE INDEX IF NOT EXISTS movimientos_recepcion_idx
  ON seguridadalimentariaerp.movimientos_inventario (empresa_id, recepcion_id)
  WHERE recepcion_id IS NOT NULL;

-- ############################################################################
-- 3) COTIZACIONES DE MONEDA
-- ############################################################################

CREATE TABLE IF NOT EXISTS seguridadalimentariaerp.cotizaciones_moneda (
  id                uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  empresa_id        uuid NOT NULL,
  moneda_origen     text NOT NULL,
  moneda_destino    text NOT NULL DEFAULT 'PYG',
  cotizacion        numeric NOT NULL CHECK (cotizacion > 0),
  fecha_cotizacion  timestamptz NOT NULL DEFAULT now(),
  fuente            text NOT NULL DEFAULT 'manual',
  es_manual         boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid NULL
);

CREATE INDEX IF NOT EXISTS cotizaciones_moneda_lookup_idx
  ON seguridadalimentariaerp.cotizaciones_moneda
     (empresa_id, moneda_origen, moneda_destino, fecha_cotizacion DESC);

COMMENT ON TABLE seguridadalimentariaerp.cotizaciones_moneda IS
  'Historial de cotizaciones aplicadas. Permite fallback a la ultima valida y auditar las cargas manuales.';

-- ############################################################################
-- 4) CRM: responsable real + etapas
-- ############################################################################

ALTER TABLE seguridadalimentariaerp.crm_prospectos
  ADD COLUMN IF NOT EXISTS responsable_usuario_id uuid NULL;

COMMENT ON COLUMN seguridadalimentariaerp.crm_prospectos.responsable_usuario_id IS
  'FK logica a usuarios.id. Fuente real para el scope por rol; `responsable` queda como snapshot de nombre.';

CREATE INDEX IF NOT EXISTS crm_prospectos_responsable_idx
  ON seguridadalimentariaerp.crm_prospectos (empresa_id, responsable_usuario_id);
CREATE INDEX IF NOT EXISTS crm_prospectos_etapa_idx
  ON seguridadalimentariaerp.crm_prospectos (empresa_id, etapa);

-- Etapas iniciales (idempotente por (empresa_id, codigo)).
INSERT INTO seguridadalimentariaerp.crm_etapas (empresa_id, codigo, nombre, color, orden, activo)
SELECT e.id, x.codigo, x.nombre, x.color, x.orden, true
FROM seguridadalimentariaerp.empresas e
CROSS JOIN (VALUES
  ('LEAD',        'Lead',        '#64748B', 10),
  ('CONTACTADO',  'Contactado',  '#0EA5E9', 20),
  ('CHARLANDO',   'Charlando',   '#4FAEB2', 30),
  ('NEGOCIACION', 'Negociación', '#F59E0B', 40),
  ('GANADO',      'Ganado',      '#22C55E', 50),
  ('PERDIDO',     'Perdido',     '#EF4444', 60)
) AS x(codigo, nombre, color, orden)
WHERE NOT EXISTS (
  SELECT 1 FROM seguridadalimentariaerp.crm_etapas ce
  WHERE ce.empresa_id = e.id AND ce.codigo = x.codigo
);

-- ############################################################################
-- 5) RLS + GRANTS (mismo patron que las tablas existentes)
-- ############################################################################

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['compras_recepciones', 'compras_recepciones_items', 'cotizaciones_moneda']
  LOOP
    EXECUTE format('ALTER TABLE seguridadalimentariaerp.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON seguridadalimentariaerp.%I TO authenticated, service_role', t);

    -- Aislamiento por empresa, igual que compras/ventas_items.
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='seguridadalimentariaerp' AND tablename=t AND policyname=t||'_select') THEN
      EXECUTE format('CREATE POLICY %I ON seguridadalimentariaerp.%I FOR SELECT USING (seguridadalimentariaerp.puede_acceder_empresa(empresa_id))', t||'_select', t);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='seguridadalimentariaerp' AND tablename=t AND policyname=t||'_insert') THEN
      EXECUTE format('CREATE POLICY %I ON seguridadalimentariaerp.%I FOR INSERT WITH CHECK (seguridadalimentariaerp.puede_acceder_empresa(empresa_id))', t||'_insert', t);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='seguridadalimentariaerp' AND tablename=t AND policyname=t||'_update') THEN
      EXECUTE format('CREATE POLICY %I ON seguridadalimentariaerp.%I FOR UPDATE USING (seguridadalimentariaerp.puede_acceder_empresa(empresa_id))', t||'_update', t);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='seguridadalimentariaerp' AND tablename=t AND policyname=t||'_delete') THEN
      EXECUTE format('CREATE POLICY %I ON seguridadalimentariaerp.%I FOR DELETE USING (seguridadalimentariaerp.puede_acceder_empresa(empresa_id))', t||'_delete', t);
    END IF;
  END LOOP;
END $$;

-- ############################################################################
-- 6) MODULOS: presupuestos y CRM habilitados para la empresa
-- ############################################################################

-- Se registra la fila si falta, pero SIN forzar el estado: quien decide si el
-- modulo se ve es la empresa. `crm` queda desactivado a proposito hasta que se
-- termine de portar el Funnel; `presupuestos` si se habilita porque el modulo
-- ya esta completo y auditado.
INSERT INTO seguridadalimentariaerp.empresa_modulos (empresa_id, modulo_id, activo)
SELECT e.id, m.id, (m.slug = 'presupuestos')
FROM seguridadalimentariaerp.empresas e
CROSS JOIN seguridadalimentariaerp.modulos m
WHERE m.slug IN ('presupuestos', 'crm')
  AND NOT EXISTS (
    SELECT 1 FROM seguridadalimentariaerp.empresa_modulos em
    WHERE em.empresa_id = e.id AND em.modulo_id = m.id
  );

-- Solo presupuestos se fuerza a activo. NO se toca `crm`: re-ejecutar la
-- migracion no debe volver a mostrar un modulo a medio portar.
UPDATE seguridadalimentariaerp.empresa_modulos em
SET activo = true
FROM seguridadalimentariaerp.modulos m
WHERE m.id = em.modulo_id AND m.slug = 'presupuestos';
