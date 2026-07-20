-- ============================================================================
-- Migracion: Ordenes de compra (modelo de ferreteria-republica-erp)
-- Schema: seguridadalimentariaerp  (EXCLUSIVO de esta instancia)
-- Fecha: 2026-07-16
--
-- Porta el modelo de OC de Ferreteria Republica, consolidando en un solo
-- archivo lo que alla quedo en dos migraciones (2026-07-05 + 2026-07-08):
-- la tabla nace directamente con los estados finales y con `cantidad_recibida`.
--
-- Modelo (igual que `compras`): PLANO. N filas agrupadas por `numero_oc`, una
-- por producto; los campos de cabecera se repiten en cada fila y se actualizan
-- juntas. La OC NO impacta inventario: al recibir se MATERIALIZAN filas en
-- `compras`, que son las que mueven stock.
--
-- Diferencias intencionales respecto del original (mejoras):
--   · `idempotency_key`: la recepcion de FR no la tiene y un doble clic crea
--     dos compras y duplica stock. Aca se deduplica.
--
-- Append-only, idempotente. No toca otros schemas.
-- ============================================================================

SET search_path TO seguridadalimentariaerp, public;

-- ---------------------------------------------------------------------------
-- 1) Ordenes de compra
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS seguridadalimentariaerp.ordenes_compra (
  id                        uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  empresa_id                uuid NOT NULL,
  numero_oc                 text NOT NULL,            -- OC-000001 (agrupador; NO unico por fila)

  proveedor_id              uuid NOT NULL,
  proveedor_nombre          text NOT NULL DEFAULT '',

  producto_id               uuid NOT NULL,
  producto_nombre           text NOT NULL DEFAULT '',

  cantidad                  numeric NOT NULL DEFAULT 0,
  cantidad_recibida         numeric NOT NULL DEFAULT 0,

  moneda                    text NOT NULL DEFAULT 'PYG' CHECK (moneda IN ('PYG', 'USD')),
  tipo_cambio               numeric NOT NULL DEFAULT 1,
  costo_unitario_original   numeric NOT NULL DEFAULT 0,   -- en la moneda elegida
  costo_unitario            numeric NOT NULL DEFAULT 0,   -- siempre PYG

  iva_tipo                  text NOT NULL DEFAULT '10' CHECK (iva_tipo IN ('exenta', '5', '10')),
  subtotal                  numeric NOT NULL DEFAULT 0,
  monto_iva                 numeric NOT NULL DEFAULT 0,
  total                     numeric NOT NULL DEFAULT 0,

  precio_venta              numeric NOT NULL DEFAULT 0,   -- venta sugerida (pactada)
  margen_venta              numeric NULL,

  -- Condiciones pactadas (informativas en la OC; se confirman al recibir).
  tipo_pago                 text NOT NULL DEFAULT 'contado' CHECK (tipo_pago IN ('contado', 'credito')),
  plazo_dias                integer NULL,

  -- Estado del turno de la OC (mismo valor en todas las filas del numero_oc).
  estado                    text NOT NULL DEFAULT 'pendiente'
                            CHECK (estado IN ('pendiente', 'recibida_parcial', 'recibida_total', 'cancelada')),
  observacion               text NULL,

  -- Fecha estimada de llegada (alimenta los avisos de la campanita).
  fecha_estimada_llegada    date NULL,

  -- Trazabilidad de la recepcion / cancelacion.
  compra_numero_control     text NULL,                -- ULTIMO COMP-XXXXXX generado al recibir
  recibida_at               timestamptz NULL,
  cancelada_at              timestamptz NULL,
  cancelada_motivo          text NULL,

  fecha                     timestamptz NOT NULL DEFAULT now(),
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  created_by                uuid NULL,
  usuario_nombre            text NULL
);

-- Por si la tabla ya existia de una corrida parcial previa.
ALTER TABLE seguridadalimentariaerp.ordenes_compra
  ADD COLUMN IF NOT EXISTS cantidad_recibida      numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fecha_estimada_llegada date NULL;

ALTER TABLE seguridadalimentariaerp.ordenes_compra DROP CONSTRAINT IF EXISTS ordenes_compra_estado_check;
ALTER TABLE seguridadalimentariaerp.ordenes_compra
  ADD CONSTRAINT ordenes_compra_estado_check
  CHECK (estado IN ('pendiente', 'recibida_parcial', 'recibida_total', 'cancelada'));

-- No se puede recibir mas de lo pedido ni cantidades negativas.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'seguridadalimentariaerp.ordenes_compra'::regclass
      AND conname = 'ordenes_compra_cantidad_recibida_check'
  ) THEN
    ALTER TABLE seguridadalimentariaerp.ordenes_compra
      ADD CONSTRAINT ordenes_compra_cantidad_recibida_check
      CHECK (cantidad_recibida >= 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_ordenes_compra_empresa   ON seguridadalimentariaerp.ordenes_compra (empresa_id);
CREATE INDEX IF NOT EXISTS idx_ordenes_compra_numero    ON seguridadalimentariaerp.ordenes_compra (empresa_id, numero_oc);
CREATE INDEX IF NOT EXISTS idx_ordenes_compra_proveedor ON seguridadalimentariaerp.ordenes_compra (proveedor_id);
CREATE INDEX IF NOT EXISTS idx_ordenes_compra_estado    ON seguridadalimentariaerp.ordenes_compra (empresa_id, estado);
CREATE INDEX IF NOT EXISTS idx_ordenes_compra_fecha     ON seguridadalimentariaerp.ordenes_compra (fecha);
CREATE INDEX IF NOT EXISTS idx_ordenes_compra_estimada  ON seguridadalimentariaerp.ordenes_compra (empresa_id, fecha_estimada_llegada)
  WHERE estado IN ('pendiente', 'recibida_parcial');

-- ---------------------------------------------------------------------------
-- 2) Compras: numero de factura del proveedor + link a la OC de origen
-- ---------------------------------------------------------------------------
ALTER TABLE seguridadalimentariaerp.compras
  ADD COLUMN IF NOT EXISTS numero_factura       text NULL,
  ADD COLUMN IF NOT EXISTS orden_compra_numero  text NULL,
  ADD COLUMN IF NOT EXISTS orden_compra_item_id uuid NULL
                           REFERENCES seguridadalimentariaerp.ordenes_compra(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS observacion          text NULL;

CREATE INDEX IF NOT EXISTS idx_compras_orden_compra
  ON seguridadalimentariaerp.compras (empresa_id, orden_compra_numero);
CREATE INDEX IF NOT EXISTS idx_compras_orden_compra_item
  ON seguridadalimentariaerp.compras (orden_compra_item_id);

-- ---------------------------------------------------------------------------
-- 3) Idempotencia de recepciones (mejora sobre el original)
--    FR no deduplica: dos POST identicos con cantidad pendiente disponible
--    crean dos compras y suman stock dos veces. `FOR UPDATE` serializa pero no
--    deduplica. Con esto, un reintento devuelve la compra ya registrada.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS seguridadalimentariaerp.ordenes_compra_recepciones (
  id                    uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  empresa_id            uuid NOT NULL,
  numero_oc             text NOT NULL,
  numero_control_compra text NOT NULL,          -- COMP-XXXXXX generado
  idempotency_key       text NULL,
  created_by            uuid NULL,
  usuario_nombre        text NULL,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ordenes_compra_recepciones_idem_uq
  ON seguridadalimentariaerp.ordenes_compra_recepciones (empresa_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS ordenes_compra_recepciones_oc_idx
  ON seguridadalimentariaerp.ordenes_compra_recepciones (empresa_id, numero_oc, created_at DESC);

-- ---------------------------------------------------------------------------
-- 4) RLS + grants (mismo patron que el resto del schema)
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ordenes_compra', 'ordenes_compra_recepciones']
  LOOP
    EXECUTE format('ALTER TABLE seguridadalimentariaerp.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON seguridadalimentariaerp.%I TO authenticated, service_role', t);

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

-- ---------------------------------------------------------------------------
-- 5) Modulo en el sidebar
-- ---------------------------------------------------------------------------
INSERT INTO seguridadalimentariaerp.modulos (nombre, slug, descripcion)
SELECT 'Órdenes de compra', 'ordenes_compra', 'Pedidos a proveedores y recepción de mercadería'
WHERE NOT EXISTS (SELECT 1 FROM seguridadalimentariaerp.modulos WHERE slug = 'ordenes_compra');

INSERT INTO seguridadalimentariaerp.empresa_modulos (empresa_id, modulo_id, activo)
SELECT e.id, m.id, true
FROM seguridadalimentariaerp.empresas e
CROSS JOIN seguridadalimentariaerp.modulos m
WHERE m.slug = 'ordenes_compra'
  AND NOT EXISTS (
    SELECT 1 FROM seguridadalimentariaerp.empresa_modulos em
    WHERE em.empresa_id = e.id AND em.modulo_id = m.id
  );
