-- ============================================================================
-- Migracion: peso del producto + documentacion adjunta por producto
-- Schema: seguridadalimentariaerp  (EXCLUSIVO de esta instancia)
-- Fecha: 2026-07-20
--
-- Pedido del cliente: costear mercaderia importada desde EE.UU.
--   1) Adjuntar uno o varios archivos por producto (ficha tecnica).
--   2) Peso del producto, con unidad gramos o kilogramos.
--   3) Ese peso alimentara formulas de flete (costo de envio por kilo).
--
-- DECISION DE MODELO — por que se guarda el peso en GRAMOS y no "valor+unidad":
--   Si se guardara el numero tal como lo escribe el usuario junto a su unidad,
--   toda formula de costeo tendria que hacer la conversion:
--       SUM(CASE WHEN peso_unidad='kg' THEN peso*1000 ELSE peso END)
--   ...y bastaria que UNA consulta se olvide del CASE para calcular un flete
--   mil veces mas caro o mas barato. Guardando siempre gramos, cualquier
--   formula futura hace `peso_gramos / 1000.0 * costo_por_kilo` sin ramas.
--   `peso_unidad` queda SOLO como preferencia de presentacion: en que unidad
--   se lo mostramos de vuelta al usuario que lo cargo.
--
-- La unidad COMERCIAL del producto sigue siendo `unidad_medida` ('UNIDAD').
-- El peso es un dato adicional y no la reemplaza.
--
-- Append-only, idempotente. No toca otros schemas.
-- ============================================================================

SET search_path TO seguridadalimentariaerp, public;

-- ############################################################################
-- 1) PESO DEL PRODUCTO
-- ############################################################################

ALTER TABLE seguridadalimentariaerp.productos
  ADD COLUMN IF NOT EXISTS peso_gramos numeric NULL,
  ADD COLUMN IF NOT EXISTS peso_unidad text NOT NULL DEFAULT 'kg';

COMMENT ON COLUMN seguridadalimentariaerp.productos.peso_gramos IS
  'Peso unitario SIEMPRE en gramos, sin importar en que unidad lo cargo el usuario. Canonico para formulas de flete. NULL = sin peso definido.';
COMMENT ON COLUMN seguridadalimentariaerp.productos.peso_unidad IS
  'Solo presentacion: en que unidad (g|kg) se le muestra el peso al usuario. NO usar para calcular.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'seguridadalimentariaerp.productos'::regclass
      AND conname = 'productos_peso_unidad_check'
  ) THEN
    ALTER TABLE seguridadalimentariaerp.productos
      ADD CONSTRAINT productos_peso_unidad_check CHECK (peso_unidad IN ('g', 'kg'));
  END IF;

  -- Un peso negativo no existe; cero tampoco es un peso valido (seria "sin dato",
  -- y para eso esta NULL).
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'seguridadalimentariaerp.productos'::regclass
      AND conname = 'productos_peso_gramos_check'
  ) THEN
    ALTER TABLE seguridadalimentariaerp.productos
      ADD CONSTRAINT productos_peso_gramos_check CHECK (peso_gramos IS NULL OR peso_gramos > 0);
  END IF;
END $$;

-- Para reportes de flete: traer los productos que tienen peso cargado.
CREATE INDEX IF NOT EXISTS productos_peso_idx
  ON seguridadalimentariaerp.productos (empresa_id)
  WHERE peso_gramos IS NOT NULL;

-- ############################################################################
-- 2) DOCUMENTACION ADJUNTA POR PRODUCTO
-- ############################################################################

-- Tabla propia y no `documentos`: aquel modulo es un repositorio general con
-- vencimiento y avisos por campanita. Las fichas tecnicas no vencen, y meterlas
-- ahi llenaria el listado de Documentos con cientos de archivos de producto.
-- Si comparten el bucket de Storage (un solo lugar donde viven los archivos).
CREATE TABLE IF NOT EXISTS seguridadalimentariaerp.producto_documentos (
  id             uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  empresa_id     uuid NOT NULL,
  producto_id    uuid NOT NULL,
  nombre         text NOT NULL,               -- etiqueta visible ("Ficha tecnica")
  archivo_path   text NOT NULL,               -- ruta dentro del bucket
  archivo_nombre text NOT NULL,               -- nombre original, para descargar
  mime_type      text NULL,
  tamano_bytes   bigint NULL,
  subido_por     uuid NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE seguridadalimentariaerp.producto_documentos IS
  'Archivos adjuntos de un producto (principalmente la ficha tecnica). Comparte el bucket de Storage con el modulo Documentos.';

-- Borrar el producto se lleva sus adjuntos. El archivo en Storage queda
-- huerfano a proposito: se prefiere un archivo de mas a perder documentacion
-- por un borrado accidental.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'seguridadalimentariaerp.producto_documentos'::regclass
      AND conname = 'producto_documentos_producto_fk'
  ) THEN
    ALTER TABLE seguridadalimentariaerp.producto_documentos
      ADD CONSTRAINT producto_documentos_producto_fk
      FOREIGN KEY (producto_id)
      REFERENCES seguridadalimentariaerp.productos (id)
      ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS producto_documentos_producto_idx
  ON seguridadalimentariaerp.producto_documentos (empresa_id, producto_id, created_at DESC);

-- Un mismo archivo no puede quedar registrado dos veces (doble clic en subir).
CREATE UNIQUE INDEX IF NOT EXISTS producto_documentos_path_uq
  ON seguridadalimentariaerp.producto_documentos (empresa_id, archivo_path);

-- updated_at automatico, igual que el resto del schema.
DROP TRIGGER IF EXISTS producto_documentos_touch ON seguridadalimentariaerp.producto_documentos;
CREATE TRIGGER producto_documentos_touch
  BEFORE UPDATE ON seguridadalimentariaerp.producto_documentos
  FOR EACH ROW EXECUTE FUNCTION seguridadalimentariaerp.touch_updated_at();

-- ############################################################################
-- 3) RLS Y GRANTS
-- ############################################################################

ALTER TABLE seguridadalimentariaerp.producto_documentos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS producto_documentos_empresa ON seguridadalimentariaerp.producto_documentos;
CREATE POLICY producto_documentos_empresa
  ON seguridadalimentariaerp.producto_documentos
  FOR ALL
  USING (seguridadalimentariaerp.puede_acceder_empresa(empresa_id))
  WITH CHECK (seguridadalimentariaerp.puede_acceder_empresa(empresa_id));

GRANT SELECT, INSERT, UPDATE, DELETE
  ON seguridadalimentariaerp.producto_documentos
  TO authenticated, service_role;
