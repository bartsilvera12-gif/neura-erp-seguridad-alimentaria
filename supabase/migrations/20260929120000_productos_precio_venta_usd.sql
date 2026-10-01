-- Precio de venta en USD por producto (D1 — precio dual Gs./USD).
-- Campo INDEPENDIENTE cargado a mano: NO se deriva de precio_venta (Gs.) ni de
-- ninguna cotización. Es el precio que el exportador cotiza directamente en USD.
-- Nullable: la mayoría de los productos solo tienen precio en Gs.; solo los que
-- se operan en USD llevan este valor. Con NULL, la venta en USD debe pedir el
-- precio manualmente (no hay conversión automática desde Gs.).
--
-- Instancia monocliente: aplica SOLO al schema de esta empresa
-- (`seguridadalimentariaerp`). No toca `public` ni otros tenants. Idempotente.

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT n.nspname AS sch
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'productos'
      AND c.relkind = 'r'
      AND n.nspname = 'seguridadalimentariaerp'
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.productos ADD COLUMN IF NOT EXISTS precio_venta_usd numeric',
      r.sch
    );
    EXECUTE format(
      'COMMENT ON COLUMN %I.productos.precio_venta_usd IS ''Precio de venta en USD (opcional). Campo comercial independiente cargado manualmente; NO es una conversión del precio en Gs. Se usa como precio de la línea cuando la venta se cobra en USD.''',
      r.sch
    );
  END LOOP;
END $$;
