-- ============================================================================
-- Migracion: busqueda de productos insensible a acentos.
-- Schema: seguridadalimentariaerp
-- Fecha: 2026-07-16
--
-- Problema: el buscador server-side usa ILIKE, que SI distingue acentos, asi que
-- "boligrafo" no encontraba "Bolígrafo". (El filtro client-side ya normalizaba,
-- de ahi la inconsistencia entre lo que filtra el navegador y lo que trae la API.)
--
-- Solucion: columna generada `busqueda_norm` con el texto buscable en minusculas
-- y sin acentos (nombre + sku + codigo de barras), mas indice trigram para que
-- el LIKE '%...%' siga siendo rapido. El endpoint normaliza el termino igual
-- antes de consultar.
--
-- Se usa translate() y no unaccent(): unaccent no es IMMUTABLE (depende de un
-- diccionario) y por eso Postgres no la acepta en una columna generada.
--
-- Idempotente, no destructiva.
-- ============================================================================

SET search_path TO seguridadalimentariaerp, public;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE seguridadalimentariaerp.productos
  ADD COLUMN IF NOT EXISTS busqueda_norm text
  GENERATED ALWAYS AS (
    translate(
      lower(
        coalesce(nombre, '') || ' ' ||
        coalesce(sku, '') || ' ' ||
        coalesce(codigo_barras, '')
      ),
      'áéíóúüñàèìòùâêîôûäëïöç',
      'aeiouunaeiouaeiouaeioc'
    )
  ) STORED;

COMMENT ON COLUMN seguridadalimentariaerp.productos.busqueda_norm IS
  'Texto buscable (nombre + sku + codigo de barras) en minusculas y sin acentos. Generada: no se escribe a mano. La usa /api/productos/search.';

-- El operador viene de pg_trgm, instalada en el esquema `extensions`: hay que
-- calificarlo o el CREATE INDEX no lo resuelve.
CREATE INDEX IF NOT EXISTS productos_busqueda_norm_trgm_idx
  ON seguridadalimentariaerp.productos
  USING gin (busqueda_norm extensions.gin_trgm_ops);
