# Provisión del schema `seguridadalimentariaerp`

Instancia monocliente: **1 cliente = 1 repo = 1 schema = 1 deploy.**

## Por qué se clona y no se replayan las migraciones

`supabase/migrations/` es historia acumulada del producto, con objetos repartidos entre `public` y
`zentra_erp` y varias reescrituras de schema. Replayarla contra un schema nuevo es frágil y no
reproduce el estado real. El procedimiento oficial clona la **estructura viva** del schema molde
(`reservacaacupe`), vacía y reescribiendo cada referencia interna al schema destino.

Las migraciones históricas se conservan **sin tocar** (incluidos los nombres `*_reservacaacupe_*.sql`):
son el registro del DDL del producto, no se ejecutan en esta instancia y renombrarlas rompería el
historial de versiones.

## Ejecutar

```bash
export SUPABASE_DB_URL='postgresql://<rol_owner>:<pass>@<host>:6432/postgres?sslmode=disable'

node scripts/provision-seguridadalimentariaerp.cjs            # crear / alinear (idempotente)
node scripts/provision-seguridadalimentariaerp.cjs --verify    # solo verificar
node scripts/provision-seguridadalimentariaerp.cjs --recreate  # DROP CASCADE + reclonar

node scripts/postgrest-expose-schema.cjs                       # exponer en PostgREST (append-only)
```

El rol debe ser **owner de los objetos** (`supabase_admin` en este Supabase self-hosted): el clonador
corre como `SECURITY DEFINER` y las tablas quedan con ese owner, así que `ALTER TABLE … ROW LEVEL
SECURITY` requiere ese rol. Con `postgres` (que acá **no** es superusuario) el paso de RLS falla con
`must be owner of table`.

## Qué hace el script

1. **Clonador** — usa `public.neura_clone_schema_full(src, tgt)`, ya instalado en la base. Solo lo
   instala si falta (base nueva); nunca pisa la versión existente ni modifica `public`.
2. **Estructura** — 122 tablas, 269 FKs, 454 índices, 402 policies, 31 funciones, 60 triggers,
   0 secuencias, 0 vistas. Sin filas.
3. **Alineación de RLS** — el clonador habilita RLS en *todas* las tablas, pero el molde deja 8 sin
   RLS (`presupuestos`, `presupuesto_items`, `producciones`, `produccion_items`, `cobros_clientes`,
   `cuentas_por_cobrar`, `recibos_dinero`, `sifen_jobs`). Con RLS activo y sin policies esas tablas
   devolverían cero filas al browser y romperían sus módulos. Se replica el flag del molde.
4. **Grants de `anon`** — el bloque de grants del clonador omite `anon`. El molde sí le da tablas,
   secuencias y `EXECUTE` (el acceso real lo gobierna RLS, no el grant). Sin esto PostgREST responde
   **401 / `error=42501`** al browser antes de evaluar las policies.
5. **`search_path`** — el clonador reescribe el del schema origen y el de `zentra_erp`, pero el molde
   arrastra `search_path=enlodemari` de una instancia anterior del linaje. Los cuerpos quedan
   calificados con el schema destino (no hay fuga de datos hoy), pero un `search_path` apuntando a
   otro cliente hace que cualquier referencia sin calificar se resuelva contra su schema. Se repunta
   al schema propio en las 8 funciones afectadas.
6. **Seed mínimo** — solo lo indispensable para arrancar:
   - `modulos` (28): catálogo de producto, no dato de cliente.
   - `empresas` (1): fila nueva de Seguridad Alimentaria, **sin** RUC, teléfono, email ni dirección.
   - `empresa_modulos` (28): habilitación por módulo, espejando los flags `activo` del molde.

   No se copian clientes, proveedores, productos, ventas, compras, facturas, documentos electrónicos,
   certificados, conversaciones ni ningún otro dato operativo.
7. **Verificación** — FKs/funciones/policies/`search_path` que apunten al molde, drift de RLS, grants
   por rol, y tablas con filas fuera del seed. Sale con código ≠ 0 si algo falla.

## Storage

Los buckets son **globales compartidos** (`chat-media`, `productos-imagenes`, `sorteo-ticket-assets`,
`sifen`, `sifen-certificados`) y el aislamiento es por path `${empresa_id}/…`. Como la instancia tiene
un `empresa_id` propio, **no se crean buckets nuevos ni se copian archivos**.

## Rollback

El schema es aditivo: no toca `reservacaacupe`, `public`, `zentra_erp` ni ningún otro.

```sql
DROP SCHEMA seguridadalimentariaerp CASCADE;
```

Y quitar el schema de `pgrst.db_schemas` (append-only inverso, conservando el resto de la lista):

```sql
ALTER ROLE authenticator IN DATABASE postgres SET pgrst.db_schemas = '<lista sin el schema>';
ALTER ROLE authenticator SET pgrst.db_schemas = '<lista sin el schema>';
SELECT pg_notify('pgrst', 'reload config');
```
