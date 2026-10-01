# Deploy — Precios en USD (productos, ventas/ticket y presupuestos)

Guía de despliegue de la funcionalidad de **precios en dólares (USD)** sin la
facturación electrónica SIFEN en USD (esa parte queda fuera de esta rama hasta
validar con el SET).

Instancia monocliente: aplica **solo** al schema `seguridadalimentariaerp`.

---

## Estado actual

- **Producción:** intacta. La columna `productos.precio_venta_usd` **NO existe**
  todavía (verificado por lectura). El campo USD **no es visible** porque el
  código del feature aún no está desplegado.
- **Rama:** `feat/precios-usd-sin-sifen`
- **Commit:** `b20edae` (basado en `origin/main` = `4ca9184`)
- **Verificación técnica:** `tsc --noEmit` OK · `next build` OK (exit 0).
- **Alcance:** 16 archivos (+517 / −72). Única migración:
  `20260929120000_productos_precio_venta_usd.sql`.
- **NO incluye** SIFEN USD (rde-xml, payload, migración de `facturas`, bridge en
  `create-venta-pg`). `create-venta-pg.ts` y `src/lib/sifen/*` quedan idénticos a
  producción.

> ⚠️ Orden importante: **primero la migración, después el código**. La columna
> debe existir antes de que el código la lea/escriba, para no dejar un estado
> parcial en producción.

---

## 1. Migración `productos.precio_venta_usd`

Agrega la columna `precio_venta_usd numeric` (opcional, nullable) a
`seguridadalimentariaerp.productos`. Es **idempotente** (`ADD COLUMN IF NOT EXISTS`)
y reversible.

Archivo: `supabase/migrations/20260929120000_productos_precio_venta_usd.sql`

Opción A — script del repo:

```bash
npm run db:apply-sql-file -- supabase/migrations/20260929120000_productos_precio_venta_usd.sql
```

Opción B — directo por psql:

```bash
psql "postgresql://postgres:<password>@<host>:<port>/postgres" \
  -f supabase/migrations/20260929120000_productos_precio_venta_usd.sql
```

---

## 2. Verificación de la columna (solo lectura)

Antes y/o después de la migración, confirmar el estado de la columna:

```sql
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'seguridadalimentariaerp'
  AND table_name   = 'productos'
  AND column_name  = 'precio_venta_usd';
```

- **Antes de migrar:** 0 filas (la columna no existe).
- **Después de migrar:** 1 fila, `data_type = numeric`.

---

## 3. Deploy del código

Desplegar la rama `feat/precios-usd-sin-sifen` (commit `b20edae`) por el pipeline
habitual (build Docker standalone).

```bash
# push desde un entorno autenticado
git push -u origin feat/precios-usd-sin-sifen
# luego: merge a main (PR o directo) y deploy del build
```

---

## 4. Verificación en la UI

En el sistema desplegado:

- **Inventario → Productos → Nuevo / Editar:** debe aparecer el campo
  **"Precio de venta (USD)" (opcional)**, debajo de "Precio distribuidor" y antes
  del selector "IVA aplicado al vender".

---

## 5. Pruebas de humo

1. **Producto:** crear/editar un producto cargando un **Precio de venta (USD)** y
   guardar; reabrir y verificar que persiste.
2. **Venta en USD:** nueva venta → elegir moneda **USD**, cargar/confirmar el tipo
   de cambio; el precio de línea toma el precio USD del producto. Verificar:
   - ticket en USD con tipo de cambio y equivalente en Gs.;
   - listado de ventas muestra el importe en USD.
3. **Presupuesto en USD:** nuevo presupuesto → moneda **USD** → el precio toma
   `precio_venta_usd`; subtotales y total en USD; el **PDF** sale en USD.
4. **Regresión Gs.:** confirmar que una venta/presupuesto en **Gs.** sigue
   funcionando igual que antes (sin cambios).

---

## 6. Rollback

- **Código:** revertir el deploy a la versión anterior (`main` previo al merge).
- **Columna:** es aditiva e inofensiva; puede dejarse. Si se quiere eliminar:

```sql
ALTER TABLE seguridadalimentariaerp.productos DROP COLUMN precio_venta_usd;
```

> Nota: no eliminar la columna si ya hay productos con precio USD cargado que se
> quieran conservar.

---

## Notas

- Los productos existentes quedan **sin** precio USD tras la migración; se cargan a
  mano desde la ficha del producto. El precio en Gs. no se toca.
- La **facturación electrónica SIFEN en USD** NO está en esta rama. Vive en
  `feat/precios-usd-sifen` y se despliega recién tras validar el XML firmado en
  **SIFEN Test** con el SET.
