"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import TipoCambioField from "@/components/compras/TipoCambioField";
import { useRouter } from "next/navigation";
import { Search, Trash2, Loader2, Plus, ImageIcon } from "lucide-react";
import { getProveedores, proveedorExiste, createProveedor } from "@/lib/proveedores/storage";
import SearchableSelect from "@/components/ui/SearchableSelect";
import AdjuntosOrdenCompra, { type AdjuntoPendiente } from "@/components/compras/AdjuntosOrdenCompra";
import { saveOrdenCompra, type OrdenItemPayload } from "@/lib/ordenes-compra/storage";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import { aKilos, formatPeso } from "@/lib/inventario/peso";
import type { Proveedor } from "@/lib/proveedores/types";
import type { TipoIva, TipoPago, Moneda } from "@/lib/compras/types";

/** Miniatura con fallback si no hay imagen o falla. */
function ProductoThumb({ url, alt }: { url?: string | null; alt: string }) {
  const [err, setErr] = useState(false);
  if (!url || err) {
    return (
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-slate-100 bg-slate-50 text-slate-300">
        <ImageIcon className="h-4 w-4" />
      </div>
    );
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt={alt} loading="lazy" onError={() => setErr(true)} className="h-10 w-10 shrink-0 rounded-md border border-slate-100 object-cover" />;
}

/** Resultado del autocomplete (búsqueda server-side sobre todo el catálogo). */
type ComboHit = {
  id: string;
  nombre: string;
  sku: string;
  precio_venta: number;
  stock_actual: number;
  controla_stock: boolean;
  imagen_url: string | null;
  /** Peso unitario en gramos. Alimenta la estimacion de flete del embarque. */
  peso_gramos: number | null;
};

function fmtGs(v: number) {
  return `Gs. ${Math.round(v).toLocaleString("es-PY")}`;
}
/** IVA INCLUIDO (modelo PY): el costo ya contiene el IVA; se desglosa desde adentro. */
function desglosarIva(bruto: number, iva: TipoIva): { subtotal: number; monto_iva: number } {
  if (iva === "exenta") return { subtotal: bruto, monto_iva: 0 };
  const factor = iva === "5" ? 1.05 : 1.1;
  const subtotal = bruto / factor;
  return { subtotal, monto_iva: bruto - subtotal };
}

type Linea = {
  producto_id: string;
  producto_nombre: string;
  sku: string;
  cantidad: number;
  costo_input: number; // en la moneda de la cabecera
  iva_tipo: TipoIva;
  precio_venta: number;
  peso_gramos: number | null;
};

const inputClass = "w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#4FAEB2]/30 bg-white";

export default function NuevaOrdenCompraPage() {
  const router = useRouter();
  const [proveedores, setProveedores] = useState<Proveedor[]>([]);
  const [cab, setCab] = useState({
    proveedor_id: "",
    moneda: "PYG" as Moneda,
    tipo_cambio: "",
    // Snapshot de la cotizacion: se pacta al crear la OC y la compra generada
    // al recibir la hereda, aunque la mercaderia llegue con otro dolar.
    cotizacion_fuente: null as string | null,
    cotizacion_fecha: null as string | null,
    cotizacion_es_manual: false,
    // Costo del kilo de flete de ESTE embarque. Cambia por envio (courier,
    // aereo, maritimo), por eso vive en la orden y no en el producto.
    flete_por_kilo: "",
    // Cuando se espera la mercaderia. Sin esto los avisos de "por llegar" y
    // "atrasada" no tienen contra que comparar.
    fecha_estimada_llegada: "",
    dias_aviso_previo: "3",
    tipo_pago: "contado" as TipoPago,
    plazo_dias: "",
    observacion: "",
  });
  const [lineas, setLineas] = useState<Linea[]>([]);
  // Archivos ya subidos al bucket que se asocian recien cuando la orden existe.
  const [adjuntos, setAdjuntos] = useState<AdjuntoPendiente[]>([]);
  // Alta de proveedor sin salir de la orden: si hay que ir a Proveedores y
  // volver, se pierde todo lo que se venia cargando.
  const [nuevoProvOpen, setNuevoProvOpen] = useState(false);
  const [nuevoProv, setNuevoProv] = useState({ nombre: "", ruc: "", telefono: "" });
  const [errorProv, setErrorProv] = useState<string | null>(null);
  const [guardandoProv, setGuardandoProv] = useState(false);
  const [q, setQ] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [hits, setHits] = useState<ComboHit[]>([]);
  const [buscando, setBuscando] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const [enviando, setEnviando] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const searchBoxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    getProveedores().then(setProveedores).catch(() => setProveedores([]));
  }, []);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (searchBoxRef.current && !searchBoxRef.current.contains(e.target as Node)) setSearchOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  // Autocomplete server-side por tokens (todo el catálogo), con debounce —
  // mismo endpoint que el buscador de Caja.
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    const term = q.trim();
    if (term.length < 2) { setHits([]); setBuscando(false); return; }
    setBuscando(true);
    timer.current = setTimeout(async () => {
      try {
        const r = await fetchWithSupabaseSession(`/api/productos/search?q=${encodeURIComponent(term)}&limit=20`, { cache: "no-store" });
        const j = await r.json();
        setHits(((j?.data?.items ?? []) as Record<string, unknown>[]).map((p): ComboHit => ({
          id: String(p.id), nombre: String(p.nombre ?? ""), sku: String(p.sku ?? ""),
          precio_venta: Number(p.precio_venta) || 0, stock_actual: Number(p.stock_actual) || 0,
          controla_stock: p.controla_stock !== false, imagen_url: (p.imagen_url as string | null) ?? null,
          peso_gramos: p.peso_gramos != null ? Number(p.peso_gramos) : null,
        })));
      } catch { setHits([]); }
      finally { setBuscando(false); }
    }, 220);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [q]);

  useEffect(() => { setHighlight(-1); }, [hits]);

  const tc = cab.moneda === "USD" ? Number(cab.tipo_cambio) || 0 : 1;

  const excluidos = useMemo(() => new Set(lineas.map((l) => l.producto_id)), [lineas]);
  const resultados = useMemo(() => hits.filter((p) => !excluidos.has(p.id)), [hits, excluidos]);

  async function handleCrearProveedor() {
    const nombre = nuevoProv.nombre.trim();
    const ruc = nuevoProv.ruc.trim();
    if (!nombre || !ruc) return;
    setErrorProv(null);
    setGuardandoProv(true);
    try {
      const dup = await proveedorExiste(ruc);
      if (dup) { setErrorProv(`RUC ya registrado para "${dup.nombre}".`); return; }
      const r = await createProveedor({
        nombre: nombre.toUpperCase(),
        ruc,
        telefono: nuevoProv.telefono.trim(),
        email: "",
        contacto: "",
        direccion: "",
        estado: "activo",
      });
      if (!r.ok) { setErrorProv(r.error); return; }
      const lista = await getProveedores().catch(() => [] as Proveedor[]);
      setProveedores(lista);
      setCab((p) => ({ ...p, proveedor_id: String(r.proveedor.id) }));
      setNuevoProvOpen(false);
      setNuevoProv({ nombre: "", ruc: "", telefono: "" });
    } finally {
      setGuardandoProv(false);
    }
  }

  function addProducto(p: ComboHit) {
    setLineas((prev) => {
      if (prev.some((l) => l.producto_id === p.id)) return prev; // ya está
      return [
        ...prev,
        {
          producto_id: p.id,
          producto_nombre: p.nombre,
          sku: p.sku,
          cantidad: 1,
          costo_input: 0,
          iva_tipo: "10",
          precio_venta: p.precio_venta,
          peso_gramos: p.peso_gramos,
        },
      ];
    });
    setQ("");
    setHits([]);
    setSearchOpen(false);
    setHighlight(-1);
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  /** Teclado: ↑/↓ navega, Enter agrega el resaltado, Esc cierra. */
  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") { e.preventDefault(); setSearchOpen(true); setHighlight((h) => Math.min(h + 1, resultados.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHighlight((h) => Math.max(h - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); const sel = resultados[highlight] ?? resultados[0]; if (sel) addProducto(sel); }
    else if (e.key === "Escape") { setSearchOpen(false); setHighlight(-1); }
  }
  function updateLinea(id: string, patch: Partial<Linea>) {
    setLineas((prev) => prev.map((l) => (l.producto_id === id ? { ...l, ...patch } : l)));
  }
  function removeLinea(id: string) {
    setLineas((prev) => prev.filter((l) => l.producto_id !== id));
  }

  const totalOc = useMemo(
    () => lineas.reduce((s, l) => s + l.costo_input * tc * l.cantidad, 0),
    [lineas, tc]
  );

  // Peso del embarque y flete estimado. El flete NO se suma al costo de los
  // productos: es una referencia para dimensionar el envio. Capitalizarlo al
  // inventario es una decision contable que todavia no esta definida.
  const pesoTotalGramos = useMemo(
    () => lineas.reduce((s, l) => s + (l.peso_gramos ?? 0) * l.cantidad, 0),
    [lineas]
  );
  const lineasSinPeso = useMemo(() => lineas.filter((l) => !l.peso_gramos).length, [lineas]);
  const fletePorKilo = Number(cab.flete_por_kilo) || 0;
  const fleteTotal = aKilos(pesoTotalGramos) * fletePorKilo;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!cab.proveedor_id) return setErr("Seleccioná un proveedor.");
    if (cab.moneda === "USD" && tc <= 0) return setErr("Cargá el tipo de cambio (USD → Gs.).");
    if (lineas.length === 0) return setErr("Agregá al menos un producto.");
    const mala = lineas.find((l) => l.cantidad <= 0 || l.costo_input <= 0);
    if (mala) return setErr(`Revisá "${mala.producto_nombre}": cantidad y costo deben ser mayores a 0.`);

    const prov = proveedores.find((p) => String(p.id) === cab.proveedor_id);
    if (!prov) return setErr("Proveedor no encontrado.");

    const items: OrdenItemPayload[] = lineas.map((l) => {
      const costoPyg = l.costo_input * tc;
      const totalLinea = costoPyg * l.cantidad;
      const { subtotal, monto_iva } = desglosarIva(totalLinea, l.iva_tipo);
      return {
        producto_id: l.producto_id,
        producto_nombre: l.producto_nombre,
        cantidad: l.cantidad,
        costo_unitario: Math.round(costoPyg),
        costo_unitario_original: l.costo_input,
        iva_tipo: l.iva_tipo,
        subtotal: Math.round(subtotal),
        monto_iva: Math.round(monto_iva),
        total: Math.round(totalLinea),
        precio_venta: Math.round(l.precio_venta),
        margen_venta: null,
      };
    });

    setEnviando(true);
    try {
      const res = await saveOrdenCompra(
        {
          proveedor_id: String(prov.id),
          proveedor_nombre: prov.nombre,
          moneda: cab.moneda,
          tipo_cambio: tc,
          cotizacion_fuente: cab.moneda === "USD" ? cab.cotizacion_fuente : null,
          cotizacion_fecha: cab.moneda === "USD" ? cab.cotizacion_fecha : null,
          cotizacion_es_manual: cab.moneda === "USD" ? cab.cotizacion_es_manual : false,
          flete_por_kilo: Number(cab.flete_por_kilo) > 0 ? Number(cab.flete_por_kilo) : null,
          fecha_estimada_llegada: cab.fecha_estimada_llegada || null,
          dias_aviso_previo: parseInt(cab.dias_aviso_previo, 10) || 3,
          tipo_pago: cab.tipo_pago,
          plazo_dias: cab.tipo_pago === "credito" && cab.plazo_dias ? parseInt(cab.plazo_dias) : undefined,
          observacion: cab.observacion.trim() || null,
        },
        items
      );
      if (!res.success) { setErr(res.error); return; }

      // Los archivos ya estaban subidos al bucket; recien ahora existe la orden
      // a la cual asociarlos. Si esto falla NO se pierde la orden: se avisa y
      // los documentos se pueden volver a adjuntar desde el detalle.
      if (adjuntos.length > 0) {
        try {
          await fetchWithSupabaseSession(
            `/api/ordenes-compra/${encodeURIComponent(res.numero_oc)}/documentos`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ documentos: adjuntos }),
            }
          );
        } catch (e) {
          console.error("[oc-nueva] no se pudieron asociar los adjuntos:", e);
        }
      }

      router.push(`/compras/ordenes/${encodeURIComponent(res.numero_oc)}`);
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div className="space-y-6">
      <Link href="/compras/ordenes" className="inline-flex items-center gap-1 text-sm font-medium text-slate-500 hover:text-[#3F8E91]">
        ← Órdenes de compra
      </Link>
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">Nueva orden de compra</h1>
        <p className="mt-1 text-sm text-slate-500">Productos y costos pactados con el proveedor. No pide factura ni impacta stock — eso se hace al recibir.</p>
      </div>

      <form onSubmit={onSubmit} className="space-y-6">
        {/* Cabecera */}
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="sm:col-span-2">
              <label className="mb-1 block text-xs font-semibold text-slate-600">Proveedor <span className="text-red-500">*</span></label>
              <SearchableSelect
                value={cab.proveedor_id || null}
                onChange={(id) => setCab((p) => ({ ...p, proveedor_id: id }))}
                options={proveedores.map((p) => ({
                  id: String(p.id),
                  label: p.nombre,
                  hint: p.ruc ? `RUC ${p.ruc}` : null,
                }))}
                placeholder="Buscar proveedor…"
                emptyText="Sin proveedores que coincidan"
              />
              {!nuevoProvOpen ? (
                <button
                  type="button"
                  onClick={() => { setErrorProv(null); setNuevoProvOpen(true); }}
                  className="mt-1.5 text-xs font-semibold text-[#4FAEB2] transition-colors hover:text-[#3F8E91]"
                >
                  + Nuevo proveedor
                </button>
              ) : (
                <div className="mt-2 rounded-lg border border-[#4FAEB2]/30 bg-[#4FAEB2]/5 p-3">
                  <p className="mb-2 text-xs font-semibold text-slate-700">Nuevo proveedor</p>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                    <input
                      value={nuevoProv.nombre}
                      onChange={(e) => setNuevoProv((p) => ({ ...p, nombre: e.target.value }))}
                      placeholder="Nombre / Razón social *"
                      className={`${inputClass} uppercase sm:col-span-2`}
                    />
                    <input
                      value={nuevoProv.ruc}
                      onChange={(e) => setNuevoProv((p) => ({ ...p, ruc: e.target.value }))}
                      placeholder="RUC *"
                      className={inputClass}
                    />
                    <input
                      value={nuevoProv.telefono}
                      onChange={(e) => setNuevoProv((p) => ({ ...p, telefono: e.target.value }))}
                      placeholder="Teléfono (opcional)"
                      className={`${inputClass} sm:col-span-3`}
                    />
                  </div>
                  {errorProv && <p className="mt-1.5 text-xs text-red-600">{errorProv}</p>}
                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      onClick={handleCrearProveedor}
                      disabled={guardandoProv || !nuevoProv.nombre.trim() || !nuevoProv.ruc.trim()}
                      className="rounded-lg bg-[#4FAEB2] px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-[#3F8E91] disabled:opacity-50"
                    >
                      {guardandoProv ? "Guardando…" : "Guardar proveedor"}
                    </button>
                    <button
                      type="button"
                      onClick={() => { setNuevoProvOpen(false); setErrorProv(null); }}
                      className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-white"
                    >
                      Cancelar
                    </button>
                  </div>
                </div>
              )}
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-600">Moneda</label>
              <select value={cab.moneda} onChange={(e) => setCab((p) => ({ ...p, moneda: e.target.value as Moneda }))} className={inputClass}>
                <option value="PYG">Guaraníes (PYG)</option>
                <option value="USD">Dólares (USD)</option>
              </select>
            </div>
            {cab.moneda === "USD" && (
              <TipoCambioField
                value={{
                  tipo_cambio: Number(cab.tipo_cambio) || 0,
                  cotizacion_fuente: cab.cotizacion_fuente,
                  cotizacion_fecha: cab.cotizacion_fecha,
                  cotizacion_es_manual: cab.cotizacion_es_manual,
                }}
                onChange={(v) => setCab((p) => ({
                  ...p,
                  tipo_cambio: v.tipo_cambio > 0 ? String(v.tipo_cambio) : "",
                  cotizacion_fuente: v.cotizacion_fuente,
                  cotizacion_fecha: v.cotizacion_fecha,
                  cotizacion_es_manual: v.cotizacion_es_manual,
                }))}
              />
            )}
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-600">
                Flete por kilo ({cab.moneda})
              </label>
              <input
                type="number"
                min={0}
                step="any"
                value={cab.flete_por_kilo}
                onChange={(e) => setCab((p) => ({ ...p, flete_por_kilo: e.target.value }))}
                placeholder="Opcional"
                className={inputClass}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-600">Llegada estimada</label>
              <input
                type="date"
                value={cab.fecha_estimada_llegada}
                onChange={(e) => setCab((p) => ({ ...p, fecha_estimada_llegada: e.target.value }))}
                className={inputClass}
              />
              <span className="mt-1 block text-[11px] text-slate-400">Habilita los avisos de llegada.</span>
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-600">Avisarme (días antes)</label>
              <input
                type="number"
                min={0}
                max={365}
                value={cab.dias_aviso_previo}
                onChange={(e) => setCab((p) => ({ ...p, dias_aviso_previo: e.target.value }))}
                disabled={!cab.fecha_estimada_llegada}
                className={`${inputClass} disabled:bg-slate-50 disabled:text-slate-400`}
              />
              <span className="mt-1 block text-[11px] text-slate-400">Notificación en la campanita.</span>
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-600">Tipo de pago</label>
              <select value={cab.tipo_pago} onChange={(e) => setCab((p) => ({ ...p, tipo_pago: e.target.value as TipoPago }))} className={inputClass}>
                <option value="contado">Contado</option>
                <option value="credito">Crédito</option>
              </select>
            </div>
            {cab.tipo_pago === "credito" && (
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600">Plazo (días)</label>
                <input type="number" min={1} value={cab.plazo_dias} onChange={(e) => setCab((p) => ({ ...p, plazo_dias: e.target.value }))} className={inputClass} />
              </div>
            )}
            <div className="sm:col-span-2 lg:col-span-4">
              <label className="mb-1 block text-xs font-semibold text-slate-600">Observación <span className="font-normal text-slate-400">(opcional)</span></label>
              <input value={cab.observacion} onChange={(e) => setCab((p) => ({ ...p, observacion: e.target.value }))} className={inputClass} placeholder="Notas de la orden…" />
            </div>
          </div>

          {/* Documentacion del pedido. Los archivos se suben ya mismo al bucket
              y se asocian a la orden cuando esta se crea. */}
          <div className="mt-5 border-t border-slate-100 pt-5">
            <label className="mb-2 block text-xs font-semibold text-slate-600">
              Documentación <span className="font-normal text-slate-400">(opcional)</span>
            </label>
            <AdjuntosOrdenCompra numeroOc={null} onPendientesChange={setAdjuntos} />
          </div>
        </div>

        {/* Buscador de productos */}
        <div ref={searchBoxRef} className="relative">
          <Search className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-[#4FAEB2]" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => { setQ(e.target.value); setSearchOpen(true); setHighlight(-1); }}
            onFocus={() => setSearchOpen(true)}
            onKeyDown={onKeyDown}
            placeholder="Buscar producto por nombre, SKU o palabras clave…"
            className="h-14 w-full rounded-2xl border-2 border-[#4FAEB2]/25 bg-white pl-12 pr-4 text-base outline-none focus:border-[#4FAEB2] focus:ring-4 focus:ring-[#4FAEB2]/15"
            autoComplete="off"
          />
          {searchOpen && q.trim().length >= 2 && (
            <div className="absolute left-0 right-0 top-full z-30 mt-2 max-h-[50vh] overflow-y-auto rounded-2xl border-2 border-[#4FAEB2]/20 bg-white shadow-[0_16px_40px_-12px_rgba(15,23,42,0.28)]">
              {buscando && resultados.length === 0 ? (
                <div className="px-4 py-6 text-center text-sm text-slate-400">Buscando…</div>
              ) : resultados.length === 0 ? (
                <div className="px-4 py-6 text-center text-sm text-slate-400">Sin resultados para &quot;{q}&quot;</div>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {resultados.map((p, i) => {
                    const sinStock = p.controla_stock && p.stock_actual <= 0;
                    return (
                      <li key={p.id}>
                        <button type="button"
                          onMouseEnter={() => setHighlight(i)}
                          onClick={() => addProducto(p)}
                          className={`flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors ${i === highlight ? "bg-[#4FAEB2]/[0.08]" : "hover:bg-slate-50"}`}>
                          <ProductoThumb url={p.imagen_url} alt={p.nombre} />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-semibold text-slate-800">{p.nombre}</p>
                            <div className="mt-0.5 flex items-center gap-2 text-xs text-slate-500">
                              <span className="font-mono">{p.sku || "—"}</span>
                              <span className="text-slate-300">·</span>
                              <span className={`font-semibold ${!p.controla_stock ? "text-slate-400" : sinStock ? "text-red-600" : p.stock_actual < 5 ? "text-amber-600" : "text-emerald-700"}`}>
                                {!p.controla_stock ? "Sin control" : sinStock ? "Sin stock" : `${p.stock_actual} en stock`}
                              </span>
                            </div>
                          </div>
                          <span className="shrink-0 text-sm font-bold tabular-nums text-slate-800">{fmtGs(p.precio_venta)}</span>
                          <span className="shrink-0 inline-flex items-center gap-1 rounded-lg bg-[#4FAEB2]/10 px-2.5 py-1 text-xs font-bold text-[#3F8E91]">
                            <Plus className="h-3.5 w-3.5" strokeWidth={2.5} /> Agregar
                          </span>
                        </button>
                      </li>
                    );
                  })}
                  {resultados.length >= 20 && (
                    <li className="px-4 py-2 text-center text-[11px] text-slate-400">Mostrando los primeros 20. Refiná la búsqueda para acotar.</li>
                  )}
                </ul>
              )}
            </div>
          )}
        </div>

        {/* Ítems */}
        <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
          {lineas.length === 0 ? (
            <p className="py-12 text-center text-sm text-slate-400">Buscá productos arriba y agregalos a la orden.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[820px] text-sm">
                <thead className="border-b border-slate-200 bg-slate-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-slate-500">Producto</th>
                    <th className="px-3 py-3 text-center text-[11px] font-bold uppercase tracking-wide text-slate-500">Cant.</th>
                    <th className="px-3 py-3 text-right text-[11px] font-bold uppercase tracking-wide text-slate-500">Costo unit. ({cab.moneda})</th>
                    <th className="px-3 py-3 text-center text-[11px] font-bold uppercase tracking-wide text-slate-500">IVA</th>
                    <th className="px-3 py-3 text-right text-[11px] font-bold uppercase tracking-wide text-slate-500">Peso</th>
                    <th className="px-4 py-3 text-right text-[11px] font-bold uppercase tracking-wide text-slate-500">Total (Gs.)</th>
                    <th className="w-10 px-2 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {lineas.map((l) => (
                    <tr key={l.producto_id} className="hover:bg-[#4FAEB2]/5">
                      <td className="px-4 py-3">
                        <p className="font-semibold text-slate-900">{l.producto_nombre}</p>
                        <p className="font-mono text-[11px] text-slate-500">{l.sku}</p>
                      </td>
                      <td className="px-3 py-3">
                        <input type="number" min={1} value={l.cantidad}
                          onChange={(e) => updateLinea(l.producto_id, { cantidad: Math.max(1, parseInt(e.target.value) || 1) })}
                          className="mx-auto h-8 w-16 rounded-md border border-slate-200 px-2 text-center text-sm tabular-nums" />
                      </td>
                      <td className="px-3 py-3 text-right">
                        <input type="number" min={0} value={l.costo_input}
                          onChange={(e) => updateLinea(l.producto_id, { costo_input: Math.max(0, Number(e.target.value) || 0) })}
                          className="h-8 w-28 rounded-md border border-slate-200 px-2 text-right text-sm tabular-nums" />
                      </td>
                      <td className="px-3 py-3">
                        <div className="mx-auto inline-flex overflow-hidden rounded-lg border border-slate-200">
                          {(["exenta", "5", "10"] as const).map((iva) => {
                            const sel = l.iva_tipo === iva;
                            return (
                              <button key={iva} type="button" onClick={() => updateLinea(l.producto_id, { iva_tipo: iva })}
                                className={`px-2 py-1.5 text-[11px] font-semibold transition-colors ${sel ? "bg-[#4FAEB2] text-white" : "bg-white text-slate-600 hover:bg-slate-100"}`}>
                                {iva === "exenta" ? "Ex" : `${iva}%`}
                              </button>
                            );
                          })}
                        </div>
                      </td>
                      <td className="px-3 py-3 text-right text-sm tabular-nums">
                        {l.peso_gramos ? (
                          <span className="text-slate-600">{formatPeso(l.peso_gramos * l.cantidad)}</span>
                        ) : (
                          <span
                            className="cursor-help text-amber-600"
                            title="Este producto no tiene peso cargado. Cargalo en Inventario para que entre en el flete."
                          >
                            sin peso
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right text-sm font-bold tabular-nums text-slate-900">
                        {fmtGs(l.costo_input * tc * l.cantidad)}
                      </td>
                      <td className="px-2 py-3 text-center">
                        <button type="button" onClick={() => removeLinea(l.producto_id)} className="rounded p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600" aria-label="Quitar">
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {err && <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{err}</p>}

        {/* Total + submit */}
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-center gap-x-10 gap-y-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Total estimado</p>
              <p className="text-2xl font-bold tabular-nums text-slate-900">{fmtGs(totalOc)}</p>
            </div>
            {pesoTotalGramos > 0 && (
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Peso del envío</p>
                <p className="text-2xl font-bold tabular-nums text-slate-900">{formatPeso(pesoTotalGramos)}</p>
                {lineasSinPeso > 0 && (
                  <p className="mt-0.5 text-[11px] text-amber-600">
                    {lineasSinPeso} {lineasSinPeso === 1 ? "producto sin peso" : "productos sin peso"} — no suman
                  </p>
                )}
              </div>
            )}
            {fleteTotal > 0 && (
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Flete estimado</p>
                <p className="text-2xl font-bold tabular-nums text-[#3F8E91]">
                  {cab.moneda === "USD"
                    ? `USD ${fleteTotal.toLocaleString("es-PY", { maximumFractionDigits: 2 })}`
                    : fmtGs(fleteTotal)}
                </p>
                {cab.moneda === "USD" && tc > 0 && (
                  <p className="mt-0.5 text-[11px] text-slate-400">≈ {fmtGs(fleteTotal * tc)}</p>
                )}
              </div>
            )}
          </div>
          <button type="submit" disabled={enviando}
            className="inline-flex items-center gap-2 rounded-xl bg-[#4FAEB2] px-6 py-3 text-sm font-bold text-white shadow-md shadow-[#4FAEB2]/30 hover:bg-[#3F8E91] disabled:opacity-50">
            {enviando && <Loader2 className="h-4 w-4 animate-spin" />}
            Crear orden de compra
          </button>
        </div>
      </form>
    </div>
  );
}
