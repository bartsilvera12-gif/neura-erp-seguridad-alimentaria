-- ============================================================================
-- Migracion: habilitar el modulo CRM Funnel
-- Schema: seguridadalimentariaerp  (EXCLUSIVO de esta instancia)
-- Fecha: 2026-07-20
--
-- La migracion del 2026-07-16 dejo `crm` desactivado a proposito: el funnel
-- todavia era la version vieja y el usuario pidio ocultarlo mientras tanto.
-- Ya portado el funnel (kanban + lista + vista movil + scope por responsable),
-- se habilita.
--
-- Append-only, idempotente. No toca otros schemas.
-- ============================================================================

SET search_path TO seguridadalimentariaerp, public;

-- El catalogo `modulos` ya trae el slug `crm` (viene del provisioning inicial).
-- Solo se garantiza la fila en empresa_modulos y se fuerza activo.
INSERT INTO seguridadalimentariaerp.empresa_modulos (empresa_id, modulo_id, activo)
SELECT e.id, m.id, true
  FROM seguridadalimentariaerp.empresas e
 CROSS JOIN seguridadalimentariaerp.modulos m
 WHERE m.slug = 'crm'
   AND NOT EXISTS (
     SELECT 1 FROM seguridadalimentariaerp.empresa_modulos em
      WHERE em.empresa_id = e.id AND em.modulo_id = m.id
   );

UPDATE seguridadalimentariaerp.empresa_modulos em
   SET activo = true
  FROM seguridadalimentariaerp.modulos m
 WHERE em.modulo_id = m.id
   AND m.slug = 'crm'
   AND em.activo IS DISTINCT FROM true;

-- Backfill de asignacion: los prospectos historicos no tienen responsable de
-- catalogo. Se dejan en NULL a proposito — inventar un dueno haria que un
-- comercial "herede" leads que nunca trabajo. Con NULL solo los ven los
-- administradores, que es justamente quien debe repartirlos.
