-- ============================================================================
-- Migracion: Modulo Documentos + Notificaciones (campanita).
-- Schema: seguridadalimentariaerp
-- Fecha: 2026-07-14
--
-- Documentos: archivos de cualquier tipo con fecha de vencimiento opcional y
-- aviso configurable (N dias antes). El aviso se materializa como una fila en
-- `notificaciones`, que alimenta la campanita del header.
--
-- La tabla notificaciones es generica (tipo + titulo + mensaje + url) y se
-- deja preparada para otros origenes (producto_id), aunque hoy solo la usa
-- Documentos.
--
-- Idempotente, no destructiva.
-- ============================================================================

SET search_path TO seguridadalimentariaerp, public;

-- ---------------------------------------------------------------------------
-- 1) Documentos
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS seguridadalimentariaerp.documentos (
  id                  uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  empresa_id          uuid NOT NULL,
  nombre              text NOT NULL,
  descripcion         text NULL,
  categoria           text NULL,
  -- Archivo en Storage (bucket privado `seguridadalimentaria-documentos`).
  archivo_path        text NOT NULL,
  archivo_nombre      text NOT NULL,          -- nombre original, para descargar
  mime_type           text NULL,
  tamano_bytes        bigint NULL,
  -- Vencimiento y aviso previo.
  fecha_vencimiento   date NULL,              -- NULL = documento sin vencimiento
  dias_aviso_previo   integer NOT NULL DEFAULT 30
                      CHECK (dias_aviso_previo >= 0 AND dias_aviso_previo <= 365),
  subido_por          uuid NULL,
  archivado           boolean NOT NULL DEFAULT false,
  created_at          timestamp with time zone NOT NULL DEFAULT now(),
  updated_at          timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS documentos_empresa_idx
  ON seguridadalimentariaerp.documentos (empresa_id, archivado, created_at DESC);

-- Para el barrido de vencimientos: solo interesan los que vencen y no estan
-- archivados.
CREATE INDEX IF NOT EXISTS documentos_vencimiento_idx
  ON seguridadalimentariaerp.documentos (empresa_id, fecha_vencimiento)
  WHERE fecha_vencimiento IS NOT NULL AND archivado = false;

-- ---------------------------------------------------------------------------
-- 2) Notificaciones (campanita)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS seguridadalimentariaerp.notificaciones (
  id            uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  empresa_id    uuid NOT NULL,
  tipo          text NOT NULL,                -- 'documento_por_vencer' | 'documento_vencido'
  titulo        text NOT NULL,
  mensaje       text NOT NULL,
  url           text NULL,                    -- destino al hacer click
  documento_id  uuid NULL REFERENCES seguridadalimentariaerp.documentos(id) ON DELETE CASCADE,
  producto_id   uuid NULL,                    -- reservado para futuros origenes
  leida         boolean NOT NULL DEFAULT false,
  created_at    timestamp with time zone NOT NULL DEFAULT now(),
  updated_at    timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notificaciones_empresa_idx
  ON seguridadalimentariaerp.notificaciones (empresa_id, leida, created_at DESC);

-- Dedupe: una sola notificacion NO leida por (empresa, documento, tipo). Si el
-- usuario la marca como leida y el documento sigue por vencer, una proxima
-- evaluacion puede volver a generarla.
CREATE UNIQUE INDEX IF NOT EXISTS notificaciones_activa_documento
  ON seguridadalimentariaerp.notificaciones (empresa_id, documento_id, tipo)
  WHERE leida = false AND documento_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3) Trigger touch updated_at (reusa el patron de cajas)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION seguridadalimentariaerp.touch_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS documentos_touch ON seguridadalimentariaerp.documentos;
CREATE TRIGGER documentos_touch
  BEFORE UPDATE ON seguridadalimentariaerp.documentos
  FOR EACH ROW EXECUTE FUNCTION seguridadalimentariaerp.touch_updated_at();

DROP TRIGGER IF EXISTS notificaciones_touch ON seguridadalimentariaerp.notificaciones;
CREATE TRIGGER notificaciones_touch
  BEFORE UPDATE ON seguridadalimentariaerp.notificaciones
  FOR EACH ROW EXECUTE FUNCTION seguridadalimentariaerp.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 4) Modulo 'documentos' en el catalogo + habilitado para la empresa
-- ---------------------------------------------------------------------------
INSERT INTO seguridadalimentariaerp.modulos (nombre, slug, descripcion)
SELECT 'Documentos', 'documentos', 'Archivos con vencimiento y aviso previo'
WHERE NOT EXISTS (
  SELECT 1 FROM seguridadalimentariaerp.modulos WHERE slug = 'documentos'
);

INSERT INTO seguridadalimentariaerp.empresa_modulos (empresa_id, modulo_id, activo)
SELECT e.id, m.id, true
FROM seguridadalimentariaerp.empresas e
CROSS JOIN seguridadalimentariaerp.modulos m
WHERE m.slug = 'documentos'
  AND NOT EXISTS (
    SELECT 1 FROM seguridadalimentariaerp.empresa_modulos em
    WHERE em.empresa_id = e.id AND em.modulo_id = m.id
  );

-- ---------------------------------------------------------------------------
-- 5) Bucket de Storage privado (los documentos pueden ser sensibles)
-- ---------------------------------------------------------------------------
UPDATE storage.buckets
SET public = false
WHERE id = 'seguridadalimentaria-documentos';
