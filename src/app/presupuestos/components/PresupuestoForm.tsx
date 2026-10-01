"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { FileText, ArrowLeft, Plus, Trash2, Loader2 } from "lucide-react";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import { calcMontoIvaIncluido, type IvaTipoPresupuesto } from "@/lib/presupuestos/types";
import SearchableSelect from "@/components/ui/SearchableSelect";

/**
 * Formulario de presupuesto compartido por el alta (`/presupuestos/nuevo`) y la
 * edición (`/presupuestos/[id]/editar`). Ambas pantallas deben validar y calcular
 * igual, así que viven en un solo componente: la única diferencia es el endpoint
 * (POST vs PUT) y los textos.
 */

type NivelPrecio = "minorista" | "mayorista" | "distribuidor";
type MonedaPresupuesto = "PYG" | "USD";
type ProductoLite = {
  id: string;
  nombre: string;
  sku: string;
  precio_venta: number;
  precio_mayorista: number | null;
  precio_distribuidor: number | null;
  /** Precio en USD (opcional). Se usa cuando el presupuesto es en dólares. */
  precio_venta_usd: number | null;
  unidad_medida: string;
  tipo_iva: IvaTipoPresupuesto;
};
type ClienteLite = {
  id: string;
  nombre: string;
  ruc: string | null;
  documento: string | null;
  telefono: string | null;
  direccion: string | null;
  nivel_precio: NivelPrecio;
};

/**
 * Precio unitario del producto en la moneda del presupuesto.
 *  - PYG: precio de lista del canal (minorista/mayorista/distribuidor).
 *  - USD: precio en dólares propio del producto (precio_venta_usd). NO se
 *    convierte desde Gs.: si el producto no tiene precio USD, arranca en 0 y el
 *    operador lo carga a mano. El nivel no aplica en USD (hay un único precio USD).
 */
function precioParaProducto(p: ProductoLite, nivel: NivelPrecio, moneda: MonedaPresupuesto): number {
  if (moneda === "USD") {
    return p.precio_venta_usd != null && p.precio_venta_usd > 0 ? p.precio_venta_usd : 0;
  }
  if (nivel === "mayorista" && p.precio_mayorista != null && p.precio_mayorista > 0) return p.precio_mayorista;
  if (nivel === "distribuidor" && p.precio_distribuidor != null && p.precio_distribuidor > 0) return p.precio_distribuidor;
  return p.precio_venta;
}

export type PresupuestoFormItem = {
  producto_id: string | null;
  producto_nombre: string;
  sku: string | null;
  cantidad: number;
  unidad_medida: string | null;
  precio_unitario: number;
  iva_tipo: IvaTipoPresupuesto;
  descuento: number;
};

/** Estado inicial del formulario en modo edición. */
export type PresupuestoFormInicial = {
  cliente_id: string | null;
  moneda?: string;
  cliente_nombre: string;
  cliente_ruc: string | null;
  cliente_telefono: string | null;
  cliente_direccion: string | null;
  validez_dias: number | null;
  forma_pago: string | null;
  plazo_entrega: string | null;
  fecha_entrega: string | null;
  observaciones: string | null;
  items: PresupuestoFormItem[];
};

export type PresupuestoFormProps = {
  modo: "nuevo" | "editar";
  /** Requerido en modo edición: destino del PUT. */
  presupuestoId?: string;
  /** Se muestra en el encabezado al editar. */
  numeroControl?: string;
  inicial?: PresupuestoFormInicial;
};

function fmtMoneda(n: number, moneda: MonedaPresupuesto) {
  const v = Number(n) || 0;
  const simbolo = moneda === "USD" ? "USD " : "Gs. ";
  return simbolo + v.toLocaleString("es-PY", { maximumFractionDigits: moneda === "USD" ? 2 : 0 });
}
function round2(n: number) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
function itemTotals(it: PresupuestoFormItem) {
  const bruto = (Number(it.precio_unitario) || 0) * (Number(it.cantidad) || 0);
  const total = Math.max(0, bruto - (Number(it.descuento) || 0));
  const iva = round2(calcMontoIvaIncluido(it.iva_tipo, total));
  return { total: round2(total), iva, subtotal: round2(total - iva) };
}

const IVAS: IvaTipoPresupuesto[] = ["10%", "5%", "EXENTA"];
const labelClass = "block text-xs font-medium text-gray-600 mb-1";
const inputClass = "w-full rounded-md border border-gray-300 px-3 py-2 text-sm";

export default function PresupuestoForm({
  modo,
  presupuestoId,
  numeroControl,
  inicial,
}: PresupuestoFormProps) {
  const router = useRouter();
  const esEdicion = modo === "editar";
  const volverHref = esEdicion && presupuestoId ? `/presupuestos/${presupuestoId}` : "/presupuestos";

  const [productos, setProductos] = useState<ProductoLite[]>([]);
  const [clientes, setClientes] = useState<ClienteLite[]>([]);

  // Cliente
  const [clienteId, setClienteId] = useState(inicial?.cliente_id ?? "");
  const [clienteNombre, setClienteNombre] = useState(inicial?.cliente_nombre ?? "");
  const [clienteRuc, setClienteRuc] = useState(inicial?.cliente_ruc ?? "");
  const [clienteTel, setClienteTel] = useState(inicial?.cliente_telefono ?? "");
  const [clienteDir, setClienteDir] = useState(inicial?.cliente_direccion ?? "");
  const [creandoCliente, setCreandoCliente] = useState(false);
  const [errorCliente, setErrorCliente] = useState<string | null>(null);

  // Moneda del presupuesto (Gs. o USD). No fiscal: no requiere tipo de cambio.
  const [moneda, setMoneda] = useState<MonedaPresupuesto>(
    inicial?.moneda === "USD" ? "USD" : "PYG"
  );

  // Items
  const [items, setItems] = useState<PresupuestoFormItem[]>(inicial?.items ?? []);
  const [selProd, setSelProd] = useState("");

  // Condiciones
  const [validezDias, setValidezDias] = useState(
    inicial ? (inicial.validez_dias != null ? String(inicial.validez_dias) : "") : "15"
  );
  const [formaPago, setFormaPago] = useState(inicial?.forma_pago ?? "");
  const [plazoEntrega, setPlazoEntrega] = useState(inicial?.plazo_entrega ?? "");
  const [fechaEntrega, setFechaEntrega] = useState(inicial?.fecha_entrega ?? "");
  const [observaciones, setObservaciones] = useState(inicial?.observaciones ?? "");

  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchWithSupabaseSession("/api/productos", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        if (j?.success) {
          const list = (j.data?.productos ?? []) as Record<string, unknown>[];
          setProductos(
            list
              .filter((p) => p.es_vendible !== false)
              .map((p) => ({
                id: String(p.id),
                nombre: String(p.nombre),
                sku: String(p.sku ?? ""),
                precio_venta: Number(p.precio_venta) || 0,
                precio_mayorista: p.precio_mayorista != null ? Number(p.precio_mayorista) || null : null,
                precio_distribuidor: p.precio_distribuidor != null ? Number(p.precio_distribuidor) || null : null,
                precio_venta_usd: p.precio_venta_usd != null ? Number(p.precio_venta_usd) || null : null,
                unidad_medida: String(p.unidad_medida ?? "UNIDAD"),
                tipo_iva: (p.tipo_iva === "EXENTA" || p.tipo_iva === "5%" ? p.tipo_iva : "10%") as IvaTipoPresupuesto,
              }))
          );
        }
      })
      .catch(() => {});
    fetchWithSupabaseSession("/api/clientes", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        if (j?.success && Array.isArray(j.data)) {
          const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
          setClientes(
            (j.data as Record<string, unknown>[]).map((r) => ({
              id: String(r.id),
              nombre: s(r.empresa) || s(r.nombre_contacto) || s(r.nombre) || "Cliente",
              ruc: s(r.ruc) || null,
              documento: s(r.documento) || null,
              telefono: s(r.telefono) || null,
              direccion: s(r.direccion) || null,
              nivel_precio: (r.nivel_precio === "mayorista" || r.nivel_precio === "distribuidor"
                ? r.nivel_precio
                : "minorista") as NivelPrecio,
            }))
          );
        }
      })
      .catch(() => {});
  }, []);

  function seleccionarCliente(id: string) {
    setClienteId(id);
    const c = clientes.find((x) => x.id === id);
    if (c) {
      setClienteNombre(c.nombre);
      // Prefiere RUC; si el cliente se identifica por CI (sin RUC), usa el documento.
      setClienteRuc(c.ruc || c.documento || "");
      setClienteTel(c.telefono ?? "");
      setClienteDir(c.direccion ?? "");
    }
  }

  /**
   * Da de alta el cliente cargado a mano y lo deja seleccionado. Reutiliza el
   * mismo endpoint que la pantalla de clientes, así el registro nace idéntico
   * a los creados desde ahí (mismos defaults, mismas validaciones).
   */
  async function crearCliente() {
    const nombre = clienteNombre.trim();
    if (!nombre) return;
    setCreandoCliente(true);
    setErrorCliente(null);
    try {
      const ruc = clienteRuc.trim();
      const res = await fetchWithSupabaseSession("/api/clientes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tipo_cliente: "empresa",
          empresa: nombre,
          // El endpoint exige `nombre_contacto`; sin un contacto aparte, el
          // nombre de la empresa cumple ese rol.
          nombre_contacto: nombre,
          // Un RUC paraguayo lleva guion verificador; sin él es una CI.
          ruc: ruc.includes("-") ? ruc : null,
          documento: ruc && !ruc.includes("-") ? ruc : null,
          telefono: clienteTel.trim() || null,
          direccion: clienteDir.trim() || null,
          nivel_precio: "minorista",
          estado: "activo",
        }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        data?: { id?: string };
        error?: string;
      };
      if (!res.ok || !j.success || !j.data?.id) {
        setErrorCliente(j.error ?? "No se pudo crear el cliente.");
        return;
      }
      const nuevo: ClienteLite = {
        id: String(j.data.id),
        nombre,
        ruc: ruc.includes("-") ? ruc : null,
        documento: ruc && !ruc.includes("-") ? ruc : null,
        telefono: clienteTel.trim() || null,
        direccion: clienteDir.trim() || null,
        nivel_precio: "minorista",
      };
      setClientes((prev) => [...prev, nuevo]);
      setClienteId(nuevo.id);
    } catch {
      setErrorCliente("No se pudo crear el cliente.");
    } finally {
      setCreandoCliente(false);
    }
  }

  function agregarProducto() {
    const p = productos.find((x) => x.id === selProd);
    if (!p) return;
    if (items.some((it) => it.producto_id === p.id)) return;
    const nivel = clientes.find((c) => c.id === clienteId)?.nivel_precio ?? "minorista";
    setItems((prev) => [
      ...prev,
      {
        producto_id: p.id,
        producto_nombre: p.nombre,
        sku: p.sku || null,
        cantidad: 1,
        unidad_medida: p.unidad_medida,
        precio_unitario: precioParaProducto(p, nivel, moneda),
        iva_tipo: p.tipo_iva,
        descuento: 0,
      },
    ]);
    setSelProd("");
  }

  /**
   * Cambia la moneda del presupuesto y re-deriva el precio de cada ítem que
   * proviene del inventario al precio de lista en esa moneda. Los ítems manuales
   * (sin producto_id) conservan el valor cargado a mano.
   */
  function cambiarMoneda(nueva: MonedaPresupuesto) {
    setMoneda(nueva);
    const nivel = clientes.find((c) => c.id === clienteId)?.nivel_precio ?? "minorista";
    setItems((prev) =>
      prev.map((it) => {
        if (!it.producto_id) return it;
        const p = productos.find((x) => x.id === it.producto_id);
        if (!p) return it;
        return { ...it, precio_unitario: precioParaProducto(p, nivel, nueva) };
      })
    );
  }

  function agregarManual() {
    setItems((prev) => [
      ...prev,
      {
        producto_id: null,
        producto_nombre: "",
        sku: null,
        cantidad: 1,
        unidad_medida: null,
        precio_unitario: 0,
        iva_tipo: "10%",
        descuento: 0,
      },
    ]);
  }

  function updItem(i: number, patch: Partial<PresupuestoFormItem>) {
    setItems((prev) => prev.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));
  }
  function delItem(i: number) {
    setItems((prev) => prev.filter((_, idx) => idx !== i));
  }

  const totales = useMemo(() => {
    let subtotal = 0,
      iva = 0,
      desc = 0,
      total = 0;
    for (const it of items) {
      const t = itemTotals(it);
      subtotal += t.subtotal;
      iva += t.iva;
      total += t.total;
      desc += Number(it.descuento) || 0;
    }
    return { subtotal: round2(subtotal), iva: round2(iva), desc: round2(desc), total: round2(total) };
  }, [items]);

  const valido =
    clienteNombre.trim().length > 0 &&
    items.length > 0 &&
    items.every((it) => it.producto_nombre.trim() && it.cantidad > 0 && it.precio_unitario >= 0);

  async function guardar() {
    if (guardando || !valido) return;
    if (esEdicion && !presupuestoId) return;
    setGuardando(true);
    setError(null);
    try {
      const res = await fetchWithSupabaseSession(
        esEdicion ? `/api/presupuestos/${presupuestoId}` : "/api/presupuestos",
        {
          method: esEdicion ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            cliente_id: clienteId || null,
            cliente_nombre: clienteNombre.trim(),
            cliente_ruc: clienteRuc.trim() || null,
            cliente_telefono: clienteTel.trim() || null,
            cliente_direccion: clienteDir.trim() || null,
            moneda,
            validez_dias: validezDias.trim() === "" ? null : parseInt(validezDias, 10),
            forma_pago: formaPago.trim() || null,
            plazo_entrega: plazoEntrega.trim() || null,
            fecha_entrega: fechaEntrega.trim() || null,
            observaciones: observaciones.trim() || null,
            items: items.map((it) => ({
              producto_id: it.producto_id,
              producto_nombre: it.producto_nombre.trim(),
              sku: it.sku,
              cantidad: Number(it.cantidad),
              unidad_medida: it.unidad_medida,
              precio_unitario: Number(it.precio_unitario),
              iva_tipo: it.iva_tipo,
              descuento: Number(it.descuento) || 0,
            })),
          }),
        }
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body?.success === false) {
        setError(
          body?.error ??
            (esEdicion ? "No se pudo guardar los cambios." : "No se pudo guardar el presupuesto.")
        );
        return;
      }
      const destinoId = esEdicion ? presupuestoId : body?.data?.id;
      if (!destinoId) {
        setError("El servidor no devolvió el presupuesto guardado.");
        return;
      }
      // `refresh` para que el detalle no muestre la versión cacheada previa.
      router.push(`/presupuestos/${destinoId}`);
      router.refresh();
    } catch {
      setError("Error de red al guardar el presupuesto.");
    } finally {
      setGuardando(false);
    }
  }

  return (
    <div className="space-y-6 max-w-5xl">
      <Link href={volverHref} className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700">
        <ArrowLeft className="h-4 w-4" /> {esEdicion ? "Volver al presupuesto" : "Volver a presupuestos"}
      </Link>

      <div className="flex items-center gap-3">
        <FileText className="h-7 w-7 text-[#4FAEB2]" />
        <h1 className="text-2xl sm:text-3xl font-bold text-gray-800">
          {esEdicion ? `Editar ${numeroControl ?? "presupuesto"}` : "Nuevo presupuesto"}
        </h1>
      </div>

      {error && <div className="rounded-md bg-red-50 border border-red-200 p-3 text-sm text-red-700">{error}</div>}

      {/* Cliente */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
        <h2 className="text-sm font-semibold text-gray-700 mb-3">Cliente</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>Cliente existente (opcional)</label>
            <SearchableSelect
              value={clienteId || "__manual__"}
              onChange={(id) => seleccionarCliente(id === "__manual__" ? "" : id)}
              options={[
                { id: "__manual__", label: "— Cargar manualmente —" },
                ...clientes.map((c) => ({ id: c.id, label: c.nombre, hint: c.ruc || c.documento || null })),
              ]}
              placeholder="Buscar cliente por nombre o RUC…"
              emptyText="Sin clientes que coincidan"
            />
          </div>
          <div>
            <label className={labelClass}>Nombre / Razón social *</label>
            <input value={clienteNombre} onChange={(e) => { setClienteId(""); setClienteNombre(e.target.value); }} className={inputClass} placeholder="Nombre del cliente" />
          </div>
          <div>
            <label className={labelClass}>RUC / CI</label>
            <input value={clienteRuc} onChange={(e) => setClienteRuc(e.target.value)} className={inputClass} />
          </div>
          <div>
            <label className={labelClass}>Teléfono</label>
            <input value={clienteTel} onChange={(e) => setClienteTel(e.target.value)} className={inputClass} />
          </div>
          <div className="sm:col-span-2">
            <label className={labelClass}>Dirección</label>
            <input value={clienteDir} onChange={(e) => setClienteDir(e.target.value)} className={inputClass} />
          </div>
        </div>

        {/* Alta de cliente sin salir del presupuesto. Solo aparece cuando el
            nombre se cargó a mano (no hay cliente_id): si ya se eligió uno
            existente, no hay nada que crear. */}
        {!clienteId && clienteNombre.trim() !== "" && (
          <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
            <p className="flex-1 text-xs text-slate-500">
              Este cliente no está en la base. Podés guardarlo para reutilizarlo en próximos
              presupuestos y ventas.
            </p>
            <button
              type="button"
              onClick={crearCliente}
              disabled={creandoCliente}
              className="rounded-lg bg-[#4FAEB2] px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-[#3F8E91] disabled:opacity-50"
            >
              {creandoCliente ? "Guardando…" : "Guardar como cliente"}
            </button>
          </div>
        )}
        {errorCliente && <p className="mt-2 text-xs text-red-600">{errorCliente}</p>}
      </div>

      {/* Productos */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-gray-700">Productos</h2>
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-gray-500">Moneda</span>
            <div className="inline-flex overflow-hidden rounded-lg border border-slate-200">
              {(["PYG", "USD"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => cambiarMoneda(m)}
                  className={`px-3 py-1.5 text-xs font-semibold transition-colors ${
                    moneda === m ? "bg-[#4FAEB2] text-white" : "bg-white text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  {m === "PYG" ? "Guaraníes (Gs.)" : "Dólares (USD)"}
                </button>
              ))}
            </div>
          </div>
        </div>
        {moneda === "USD" && (
          <p className="mb-3 text-xs text-gray-400">
            Presupuesto en dólares: los precios de inventario se cargan desde el precio USD del producto. Los productos sin precio USD arrancan en 0 — completalos a mano.
          </p>
        )}
        {/* Selector STICKY: al scrollear la página con muchos ítems, la barra para agregar
            nuevos productos queda siempre visible arriba, sin necesidad de subir manualmente. */}
        <div className="sticky top-0 z-10 -mx-5 mb-4 border-b border-slate-200 bg-white/95 px-5 py-3 backdrop-blur">
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex-1 min-w-[220px]">
              <label className={labelClass}>Agregar desde inventario</label>
              <SearchableSelect
                value={selProd || null}
                onChange={(id) => setSelProd(id)}
                options={productos.map((p) => ({ id: p.id, label: p.nombre, hint: p.sku || null }))}
                placeholder="Buscar producto por nombre o SKU…"
                emptyText="Sin productos que coincidan"
              />
            </div>
            <button type="button" onClick={agregarProducto} disabled={!selProd} className="inline-flex items-center gap-1 rounded-md bg-[#4FAEB2] px-3 py-2 text-sm font-medium text-white hover:bg-[#3F8E91] disabled:opacity-50">
              <Plus className="h-4 w-4" /> Agregar
            </button>
            <button type="button" onClick={agregarManual} className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50">
              <Plus className="h-4 w-4" /> Ítem manual
            </button>
            {items.length > 0 && (
              <span className="ml-auto text-xs text-slate-500 tabular-nums">{items.length} ítem{items.length === 1 ? "" : "s"}</span>
            )}
          </div>
        </div>

        {items.length === 0 ? (
          <p className="text-sm text-gray-500">Sin ítems. Agregá productos del inventario o ítems manuales.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-sm">
              <thead className="text-left text-xs text-gray-500 uppercase">
                <tr>
                  <th className="py-2 pr-2">Descripción</th>
                  <th className="py-2 px-2 w-20">Cant.</th>
                  <th className="py-2 px-2 w-32">Precio unit.</th>
                  <th className="py-2 px-2 w-24">IVA</th>
                  <th className="py-2 px-2 w-28">Descuento</th>
                  <th className="py-2 px-2 w-32 text-right">Total</th>
                  <th className="py-2 pl-2 w-10"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {items.map((it, i) => {
                  const t = itemTotals(it);
                  return (
                    <tr key={i}>
                      <td className="py-2 pr-2">
                        <input value={it.producto_nombre} onChange={(e) => updItem(i, { producto_nombre: e.target.value })} className={inputClass} placeholder="Descripción" />
                      </td>
                      <td className="py-2 px-2">
                        <input type="number" min="0" step="0.01" value={it.cantidad} onChange={(e) => updItem(i, { cantidad: Number(e.target.value) })} className={inputClass} />
                      </td>
                      <td className="py-2 px-2">
                        <input type="number" min="0" step={moneda === "USD" ? "0.01" : "1"} value={it.precio_unitario} onChange={(e) => updItem(i, { precio_unitario: Number(e.target.value) })} className={inputClass} />
                      </td>
                      <td className="py-2 px-2">
                        <select value={it.iva_tipo} onChange={(e) => updItem(i, { iva_tipo: e.target.value as IvaTipoPresupuesto })} className={`${inputClass} bg-white`}>
                          {IVAS.map((iv) => <option key={iv} value={iv}>{iv}</option>)}
                        </select>
                      </td>
                      <td className="py-2 px-2">
                        <input type="number" min="0" step="1" value={it.descuento} onChange={(e) => updItem(i, { descuento: Number(e.target.value) })} className={inputClass} />
                      </td>
                      <td className="py-2 px-2 text-right tabular-nums font-medium">{fmtMoneda(t.total, moneda)}</td>
                      <td className="py-2 pl-2 text-right">
                        <button onClick={() => delItem(i)} className="text-red-600 hover:text-red-700" aria-label="Eliminar"><Trash2 className="h-4 w-4" /></button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {items.length > 0 && (
          <div className="mt-4 ml-auto w-full sm:w-72 text-sm space-y-1">
            <div className="flex justify-between"><span className="text-gray-500">Subtotal (sin IVA)</span><span className="tabular-nums">{fmtMoneda(totales.subtotal, moneda)}</span></div>
            <div className="flex justify-between"><span className="text-gray-500">IVA</span><span className="tabular-nums">{fmtMoneda(totales.iva, moneda)}</span></div>
            {totales.desc > 0 && <div className="flex justify-between"><span className="text-gray-500">Descuentos</span><span className="tabular-nums">- {fmtMoneda(totales.desc, moneda)}</span></div>}
            <div className="flex justify-between border-t border-slate-200 pt-1 font-semibold text-base"><span>Total</span><span className="tabular-nums text-[#4FAEB2]">{fmtMoneda(totales.total, moneda)}</span></div>
          </div>
        )}
      </div>

      {/* Condiciones */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
        <h2 className="text-sm font-semibold text-gray-700 mb-3">Condiciones comerciales</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className={labelClass}>Validez (días)</label>
            <input type="number" min="0" value={validezDias} onChange={(e) => setValidezDias(e.target.value)} className={inputClass} />
            {esEdicion && (
              <p className="mt-1 text-xs text-gray-400">
                El vencimiento se recalcula desde la fecha de emisión original.
              </p>
            )}
          </div>
          <div>
            <label className={labelClass}>Forma de pago</label>
            <input value={formaPago} onChange={(e) => setFormaPago(e.target.value)} className={inputClass} placeholder="Ej: 50% anticipo, saldo contra entrega" />
          </div>
          <div>
            <label className={labelClass}>Plazo de entrega</label>
            <input value={plazoEntrega} onChange={(e) => setPlazoEntrega(e.target.value)} className={inputClass} placeholder="Ej: 5 días hábiles" />
          </div>
          <div>
            <label className={labelClass}>Día de entrega</label>
            <input
              type="date"
              value={fechaEntrega}
              onChange={(e) => setFechaEntrega(e.target.value)}
              className={inputClass}
            />
            <p className="mt-1 text-xs text-gray-400">Se muestra en el PDF/impresión del presupuesto.</p>
          </div>
          <div className="sm:col-span-3">
            <label className={labelClass}>Observaciones</label>
            <textarea value={observaciones} onChange={(e) => setObservaciones(e.target.value)} rows={3} className={inputClass} />
          </div>
        </div>
      </div>

      <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
        <Link href={volverHref} className="inline-flex items-center justify-center rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50">
          Cancelar
        </Link>
        <button onClick={guardar} disabled={!valido || guardando} className="inline-flex items-center justify-center gap-1.5 rounded-md bg-[#4FAEB2] px-5 py-2 text-sm font-medium text-white hover:bg-[#3F8E91] disabled:opacity-50">
          {guardando ? (
            <><Loader2 className="h-4 w-4 animate-spin" /> Guardando…</>
          ) : esEdicion ? (
            "Guardar cambios"
          ) : (
            "Guardar presupuesto"
          )}
        </button>
      </div>
    </div>
  );
}
