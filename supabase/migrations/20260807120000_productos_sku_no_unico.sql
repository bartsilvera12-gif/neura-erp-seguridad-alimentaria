-- El SKU deja de ser único por empresa.
--
-- Seguridad Alimentaria carga un producto por LOTE ("CURITAS ... LOTE: NA-620",
-- "... LOTE: NA-623"), y todos los lotes de un mismo artículo comparten el SKU
-- del artículo. Con el índice UNIQUE (empresa_id, sku) el alta del segundo lote
-- se rechazaba y el usuario quedaba sin forma de cargarlo.
--
-- Se reemplaza el índice UNIQUE por uno común: el SKU se sigue usando para
-- buscar y agrupar (por eso conserva índice), pero ya no identifica una fila.
-- La identificación única sigue siendo `id` y, para escaneo, el índice
-- `uq_productos_codigo_barras` — que NO se toca: el código de barras sigue
-- siendo único por empresa.
--
-- Idempotente.

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
    EXECUTE format('DROP INDEX IF EXISTS %I.idx_productos_empresa_sku', r.sch);
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS idx_productos_empresa_sku ON %I.productos (empresa_id, sku)',
      r.sch
    );
  END LOOP;
END $$;
