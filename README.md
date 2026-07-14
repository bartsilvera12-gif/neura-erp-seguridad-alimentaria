# Seguridad Alimentaria ERP

Instancia dedicada del Neura ERP para **Seguridad Alimentaria**.

Modelo de aislamiento: **1 cliente = 1 repositorio = 1 schema = 1 deploy.**

| Recurso | Valor |
|---|---|
| Repositorio | `bartsilvera12-gif/neura-erp-seguridad-alimentaria` |
| Schema Postgres | `seguridadalimentariaerp` |
| Aplicación (Coolify) | `seguridad-alimentaria-erp` |
| Stack | Next.js 16 · Supabase self-hosted · PostgREST · Coolify (Nixpacks, SSR, puerto 3000) |

Clonado desde `reserva-ecologica-caacupe-erp` @ `77c2790` con baseline de historial limpia.

## Resolución de schema

Toda la app resuelve el schema en un único punto: [`src/lib/supabase/schema.ts`](src/lib/supabase/schema.ts).

Orden de resolución: `NEURA_CLIENT_SCHEMA` → `APP_DB_SCHEMA` → `NEXT_PUBLIC_APP_DB_SCHEMA` → default del repo (`seguridadalimentariaerp`).

El default del repo es el schema propio a propósito: en el bundle de browser solo se inlinean las
variables `NEXT_PUBLIC_*`, así que sin default propio el cliente caería en el schema de otra instancia.

Además hay un **guard duro**: si alguna de esas variables apunta a `reservacaacupe`, `enlodemari`,
`zentra_erp` o `public`, la app lanza error en vez de leer datos de otro cliente.

## Puesta en marcha

```bash
npm ci
cp .env.example .env.local   # completar valores (nunca commitear)
npm run dev
```

## Base de datos

El schema `seguridadalimentariaerp` **no se provisiona replayando `supabase/migrations/`**: esas
migraciones son historia acumulada (repartida entre `public` y `zentra_erp`) y replayarlas es frágil.

La provisión oficial clona la estructura del schema molde, vacía y sin dependencias hacia el origen:

```bash
node scripts/provision-seguridadalimentariaerp.cjs            # crear / verificar (idempotente)
node scripts/provision-seguridadalimentariaerp.cjs --verify   # solo verificar
node scripts/provision-seguridadalimentariaerp.cjs --recreate # DROP CASCADE + reclonar
```

Requiere `SUPABASE_DB_URL` con un superusuario. Ver [`docs/PROVISION_SCHEMA.md`](docs/PROVISION_SCHEMA.md).

### PostgREST

El schema debe estar en `PGRST_DB_SCHEMAS` del servicio `rest` de Supabase, o el browser devuelve
`PGRST106`. Verificación:

```bash
curl -s -o /dev/null -w '%{http_code}' \
  -H "apikey: $NEXT_PUBLIC_SUPABASE_ANON_KEY" \
  -H "Accept-Profile: seguridadalimentariaerp" \
  "$NEXT_PUBLIC_SUPABASE_URL/rest/v1/empresas?select=id&limit=1"   # → 200
```

## Pendientes de alta comercial

El cliente todavía no proveyó estos datos; están como variables vacías, no inventados:

- Logo (`NEURA_EMPRESA_LOGO_URL`) — hoy usa el logo genérico Neura.
- Actividad económica, teléfono y dirección del membrete de documentos.
- RUC / timbrado y certificado SIFEN (facturación electrónica sin habilitar).
- Canal de WhatsApp propio (no se reutiliza el del cliente fuente).
- Dominio definitivo (opera sobre la URL temporal de Coolify).
