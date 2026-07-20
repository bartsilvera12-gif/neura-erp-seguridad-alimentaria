-- ============================================================================
-- Migracion: RLS en documentos y notificaciones
-- Schema: seguridadalimentariaerp  (EXCLUSIVO de esta instancia)
-- Fecha: 2026-07-20
--
-- La migracion del 2026-07-14 creo ambas tablas con `empresa_id` y grants,
-- pero SIN habilitar row level security. El resto de las tablas del schema si
-- la tiene. El QA de aislamiento (scripts/qa-presupuestos-y-seguridad.ts) lo
-- detecto.
--
-- En la practica el acceso pasa hoy por el service role, que igual saltea RLS,
-- asi que esto no era una fuga activa; pero deja las dos tablas fuera de la
-- misma red de seguridad que todas las demas, y cualquier acceso futuro con
-- rol de usuario (o una consulta via PostgREST autenticada) las leeria enteras.
--
-- Append-only, idempotente. No toca otros schemas.
-- ============================================================================

SET search_path TO seguridadalimentariaerp, public;

ALTER TABLE seguridadalimentariaerp.documentos     ENABLE ROW LEVEL SECURITY;
ALTER TABLE seguridadalimentariaerp.notificaciones ENABLE ROW LEVEL SECURITY;

-- Misma funcion de tenancy que usa el resto del schema.
DROP POLICY IF EXISTS documentos_empresa ON seguridadalimentariaerp.documentos;
CREATE POLICY documentos_empresa
  ON seguridadalimentariaerp.documentos
  FOR ALL
  USING (seguridadalimentariaerp.puede_acceder_empresa(empresa_id))
  WITH CHECK (seguridadalimentariaerp.puede_acceder_empresa(empresa_id));

DROP POLICY IF EXISTS notificaciones_empresa ON seguridadalimentariaerp.notificaciones;
CREATE POLICY notificaciones_empresa
  ON seguridadalimentariaerp.notificaciones
  FOR ALL
  USING (seguridadalimentariaerp.puede_acceder_empresa(empresa_id))
  WITH CHECK (seguridadalimentariaerp.puede_acceder_empresa(empresa_id));
