-- ============================================================================
-- Migracion: documentacion adjunta en ordenes de compra
-- Schema: seguridadalimentariaerp  (EXCLUSIVO de esta instancia)
-- Fecha: 2026-07-23
--
-- Una orden de importacion viene con papeles: confirmacion del proveedor,
-- factura proforma, packing list, conocimiento de embarque, despacho. Hoy solo
-- se podia adjuntar el comprobante AL RECIBIR (en la compra), que es tarde:
-- esos documentos existen desde que se hace el pedido.
--
-- Se referencia por `numero_oc` y NO por id de fila: una orden de compra son N
-- filas (una por producto) que comparten numero_oc. El documento es de la
-- ORDEN completa, no de una linea.
--
-- Comparte el bucket de Storage con el modulo Documentos y con las fichas
-- tecnicas de productos: un solo lugar donde viven los archivos.
--
-- Append-only, idempotente. No toca otros schemas.
-- ============================================================================

SET search_path TO seguridadalimentariaerp, public;

CREATE TABLE IF NOT EXISTS seguridadalimentariaerp.ordenes_compra_documentos (
  id             uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  empresa_id     uuid NOT NULL,
  numero_oc      text NOT NULL,
  nombre         text NOT NULL,               -- etiqueta visible
  archivo_path   text NOT NULL,               -- ruta dentro del bucket
  archivo_nombre text NOT NULL,               -- nombre original, para descargar
  mime_type      text NULL,
  tamano_bytes   bigint NULL,
  subido_por     uuid NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE seguridadalimentariaerp.ordenes_compra_documentos IS
  'Archivos de una orden de compra (proforma, packing list, despacho). Se referencia por numero_oc: el documento es de la orden completa, no de una linea.';

-- Sin FK: `ordenes_compra` no tiene PK por numero_oc (son N filas por orden).
-- El aislamiento lo dan empresa_id + RLS, y el borrado de una OC es logico
-- (estado cancelada), no fisico, asi que no hay riesgo de huerfanos reales.
CREATE INDEX IF NOT EXISTS ordenes_compra_documentos_oc_idx
  ON seguridadalimentariaerp.ordenes_compra_documentos (empresa_id, numero_oc, created_at DESC);

-- Un mismo archivo no puede quedar registrado dos veces (doble clic al subir).
CREATE UNIQUE INDEX IF NOT EXISTS ordenes_compra_documentos_path_uq
  ON seguridadalimentariaerp.ordenes_compra_documentos (empresa_id, archivo_path);

DROP TRIGGER IF EXISTS ordenes_compra_documentos_touch ON seguridadalimentariaerp.ordenes_compra_documentos;
CREATE TRIGGER ordenes_compra_documentos_touch
  BEFORE UPDATE ON seguridadalimentariaerp.ordenes_compra_documentos
  FOR EACH ROW EXECUTE FUNCTION seguridadalimentariaerp.touch_updated_at();

ALTER TABLE seguridadalimentariaerp.ordenes_compra_documentos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ordenes_compra_documentos_empresa ON seguridadalimentariaerp.ordenes_compra_documentos;
CREATE POLICY ordenes_compra_documentos_empresa
  ON seguridadalimentariaerp.ordenes_compra_documentos
  FOR ALL
  USING (seguridadalimentariaerp.puede_acceder_empresa(empresa_id))
  WITH CHECK (seguridadalimentariaerp.puede_acceder_empresa(empresa_id));

GRANT SELECT, INSERT, UPDATE, DELETE
  ON seguridadalimentariaerp.ordenes_compra_documentos
  TO authenticated, service_role;
