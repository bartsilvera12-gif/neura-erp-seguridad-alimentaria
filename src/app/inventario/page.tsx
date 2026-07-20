"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Search, X, Plus, Package, Coins, AlertTriangle,
  SlidersHorizontal, ChevronLeft, ChevronRight, PackageSearch, Pencil,
} from "lucide-react";
import { getProductos } from "@/lib/inventario/storage";
import type { Producto } from "@/lib/inventario/types";
import ExportExcelButton from "@/components/ui/ExportExcelButton";
import ImportExcelButton from "@/components/ui/ImportExcelButton";
import EdgeScrollArea from "@/components/ui/EdgeScrollArea";
import { useIsAdmin } from "@/lib/auth/use-is-admin";
import { productoMatchesQuery } from "@/lib/productos/token-search";

function formatGs(valor: number) {
  return `Gs. ${Math.round(valor).toLocaleString("es-PY")}`;
}

/** Stock con hasta 3 decimales (los insumos pueden quedar fraccionados). */
function formatStock(valor: number) {
  return valor.toLocaleString("es-PY", { maximumFractionDigits: 3 });
}

function calcularMargenVenta(costo: number, precio: number): number {
  if (precio === 0) return 0;
  return ((precio - costo) / precio) * 100;
}

function margenColor(margen: number): string {
  if (margen >= 40) return "text-emerald-600";
  if (margen >= 20) return "text-amber-600";
  return "text-red-600";
}

/** Estado de stock: define el badge y el filtro rápido. */
type EstadoStock = "sin_stock" | "bajo" | "ok";
function estadoStockDe(p: Producto): EstadoStock {
  if (p.stock_actual <= 0) return "sin_stock";
  if (p.stock_actual <= p.stock_minimo) return "bajo";
  return "ok";
}
const ESTADO_META: Record<EstadoStock, { label: string; badge: string; texto: string }> = {
  sin_stock: { label: "Sin stock", badge: "bg-red-50 text-red-700 ring-1 ring-red-100", texto: "text-red-600" },
  bajo: { label: "Stock bajo", badge: "bg-amber-50 text-amber-700 ring-1 ring-amber-100", texto: "text-amber-600" },
  ok: { label: "Disponible", badge: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100", texto: "text-slate-700" },
};

const inputClass =
  "w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none transition-shadow duration-150 placeholder:text-slate-400 focus:border-[#4FAEB2] focus:ring-2 focus:ring-[#4FAEB2]/20";
const btnPrimario =
  "inline-flex items-center gap-2 rounded-lg bg-[#4FAEB2] px-4 py-2 text-sm font-semibold text-white shadow-sm transition-[transform,background-color] duration-150 ease-out hover:bg-[#3F8E91] active:scale-[0.97]";
const btnSecundario =
  "inline-flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-600 transition-[transform,background-color] duration-150 ease-out hover:bg-slate-50 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-40";

interface UbicacionMin { id: string; nombre: string; tipo: string }

const POR_PAGINA_OPCIONES = [25, 50, 100] as const;

export default function InventarioPage() {
  const { isAdmin } = useIsAdmin();
  const [todos, setTodos] = useState<Producto[]>([]);
  const [ubicaciones, setUbicaciones] = useState<UbicacionMin[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const [cargando, setCargando] = useState(true);

  // ── Filtros ────────────────────────────────────────────────────────────────
  const [busqueda, setBusqueda] = useState("");
  const [filtroEstado, setFiltroEstado] = useState<EstadoStock | "">("");
  const [filtroUbicacion, setFiltroUbicacion] = useState("");   // "", "__sin__" o id
  const [filtroPrecio, setFiltroPrecio] = useState<"" | "sin_precio" | "con_precio">("");
  const [filtroBarras, setFiltroBarras] = useState<"" | "con" | "sin">("");
  const [filtroMargen, setFiltroMargen] = useState<"" | "alto" | "medio" | "bajo">("");
  const [verFiltros, setVerFiltros] = useState(false);
  const [orden, setOrden] = useState<"nombre" | "stock_asc" | "valor_desc" | "margen_desc">("nombre");

  // ── Paginado ───────────────────────────────────────────────────────────────
  const [pagina, setPagina] = useState(1);
  const [porPagina, setPorPagina] = useState<number>(25);

  // Esta instancia solo comercializa productos de REVENTA (ver historial de git).
  const tab = "reventa" as "reventa" | "menu" | "materia";

  useEffect(() => {
    let cancelled = false;
    setCargando(true);
    getProductos()
      .then((data) => { if (!cancelled) setTodos(data); })
      .finally(() => { if (!cancelled) setCargando(false); });
    fetch("/api/inventario/ubicaciones", { credentials: "include", cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        if (cancelled || !j?.success) return;
        setUbicaciones((j.data?.ubicaciones ?? []) as UbicacionMin[]);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [refreshKey]);

  const ubicacionById = useMemo(
    () => new Map(ubicaciones.map((u) => [u.id, u])),
    [ubicaciones]
  );

  /** Universo de la pestaña (hoy: solo reventa). Base de todos los filtros. */
  const universo = useMemo(
    () =>
      todos.filter((p) => {
        const esVendible = p.es_vendible !== false;
        const esInsumo = p.es_insumo === true;
        const controlaStock = p.controla_stock !== false;
        if (tab === "reventa") return esVendible && controlaStock && !esInsumo;
        if (tab === "menu") return esVendible && !controlaStock && !esInsumo;
        return esInsumo;
      }),
    [todos, tab]
  );

  const productos = useMemo(() => {
    const lista = universo.filter((p) => {
      // Buscador inteligente: cada palabra puede aparecer en cualquier campo y
      // en cualquier orden, sin importar acentos ni mayúsculas.
      // "boligrafo azul" encuentra "Bolígrafo detectable azul".
      if (!productoMatchesQuery(busqueda, p.nombre, p.sku, p.codigo_barras)) return false;

      if (filtroEstado !== "" && estadoStockDe(p) !== filtroEstado) return false;

      if (filtroUbicacion === "__sin__") {
        if (p.ubicacion_principal_id) return false;
      } else if (filtroUbicacion !== "" && p.ubicacion_principal_id !== filtroUbicacion) {
        return false;
      }

      if (filtroPrecio === "sin_precio" && p.precio_venta > 0) return false;
      if (filtroPrecio === "con_precio" && !(p.precio_venta > 0)) return false;

      const tieneBarras = typeof p.codigo_barras === "string" && p.codigo_barras.trim() !== "";
      if (filtroBarras === "con" && !tieneBarras) return false;
      if (filtroBarras === "sin" && tieneBarras) return false;

      if (filtroMargen !== "") {
        const m = calcularMargenVenta(p.costo_promedio, p.precio_venta);
        if (filtroMargen === "alto" && m < 40) return false;
        if (filtroMargen === "medio" && (m < 20 || m >= 40)) return false;
        if (filtroMargen === "bajo" && m >= 20) return false;
      }
      return true;
    });

    const ordenada = [...lista];
    if (orden === "nombre") ordenada.sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
    else if (orden === "stock_asc") ordenada.sort((a, b) => a.stock_actual - b.stock_actual);
    else if (orden === "valor_desc")
      ordenada.sort((a, b) => b.stock_actual * b.costo_promedio - a.stock_actual * a.costo_promedio);
    else
      ordenada.sort(
        (a, b) =>
          calcularMargenVenta(b.costo_promedio, b.precio_venta) -
          calcularMargenVenta(a.costo_promedio, a.precio_venta)
      );
    return ordenada;
  }, [universo, busqueda, filtroEstado, filtroUbicacion, filtroPrecio, filtroBarras, filtroMargen, orden]);

  /** Resumen sobre TODO el universo (no sobre la página), para que no cambie al paginar. */
  const resumen = useMemo(() => {
    const conStock = universo.filter(
      (p) => !(p.controla_stock === false && p.es_insumo !== true && p.modo_receta !== "produccion_previa")
    );
    return {
      total: universo.length,
      stockValorizado: conStock.reduce((s, p) => s + p.stock_actual * p.costo_promedio, 0),
      sinStock: conStock.filter((p) => p.stock_actual <= 0).length,
      bajo: conStock.filter((p) => p.stock_actual > 0 && p.stock_actual <= p.stock_minimo).length,
      disponibles: conStock.filter((p) => p.stock_actual > 0).length,
    };
  }, [universo]);

  /** Filtros que ACOTAN resultados: definen el mensaje de "sin resultados". */
  const hayFiltros =
    busqueda.trim() !== "" || filtroEstado !== "" || filtroUbicacion !== "" ||
    filtroPrecio !== "" || filtroBarras !== "" || filtroMargen !== "";

  /** El orden no acota, pero sí es "algo configurado": el botón debe avisarlo
   *  porque el panel está plegado y no se ve desde afuera. */
  const hayAjustes = hayFiltros || orden !== "nombre";

  function limpiarFiltros() {
    setBusqueda("");
    setFiltroEstado("");
    setFiltroUbicacion("");
    setFiltroPrecio("");
    setFiltroBarras("");
    setFiltroMargen("");
    setOrden("nombre");
    setPagina(1);
  }

  // Al cambiar filtros u orden, volver a la primera página: si no, el usuario
  // filtra y ve "sin resultados" solo porque quedó parado en la página 5.
  useEffect(() => {
    setPagina(1);
  }, [busqueda, filtroEstado, filtroUbicacion, filtroPrecio, filtroBarras, filtroMargen, orden, porPagina]);

  const totalPaginas = Math.max(1, Math.ceil(productos.length / porPagina));
  const paginaSegura = Math.min(pagina, totalPaginas);
  const visibles = useMemo(
    () => productos.slice((paginaSegura - 1) * porPagina, paginaSegura * porPagina),
    [productos, paginaSegura, porPagina]
  );
  const desde = productos.length === 0 ? 0 : (paginaSegura - 1) * porPagina + 1;
  const hasta = Math.min(paginaSegura * porPagina, productos.length);

  return (
    <div className="space-y-6">
      {/* Encabezado */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="inline-block h-1.5 w-1.5 rounded-full bg-[#4FAEB2]"
              style={{ boxShadow: "0 0 0 3px rgba(79, 174, 178, 0.18)" }}
            />
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#4FAEB2]">
              Zentra · Stock
            </p>
          </div>
          <h1 className="mt-1 text-lg font-semibold tracking-tight text-slate-900">Inventario</h1>
          <p className="mt-0.5 text-xs text-slate-500">Gestión de productos y control de stock</p>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <ExportExcelButton url="/api/inventario/productos/export" />
          <ImportExcelButton
            entidad="Productos"
            previewUrl="/api/inventario/productos/import/preview"
            commitUrl="/api/inventario/productos/import/commit"
            templateUrl="/api/inventario/productos/import/template"
            permiteCrearFaltantes
            visible={isAdmin}
            onCompleted={() => setRefreshKey((k) => k + 1)}
          />
          <Link href="/inventario/nuevo" className={btnPrimario}>
            <Plus className="h-4 w-4" />
            Nuevo producto
          </Link>
        </div>
      </div>

      {/* Resumen — las tarjetas de estado además filtran */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-sm">
          <div className="flex items-center justify-between gap-2">
            <p className="truncate text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">
              Total productos
            </p>
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#4FAEB2]/12 text-[#3F8E91]">
              <Package className="h-3.5 w-3.5" />
            </span>
          </div>
          <p className="mt-1 text-2xl font-bold tracking-tight tabular-nums text-slate-900">{resumen.total}</p>
          <p className="text-[11px] text-slate-400">de reventa</p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-sm">
          <div className="flex items-center justify-between gap-2">
            <p className="truncate text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">
              Stock valorizado
            </p>
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#4FAEB2]/12 text-[#3F8E91]">
              <Coins className="h-3.5 w-3.5" />
            </span>
          </div>
          <p className="mt-1 truncate text-2xl font-bold tracking-tight tabular-nums text-slate-900">
            {formatGs(resumen.stockValorizado)}
          </p>
          <p className="text-[11px] text-slate-400">stock × costo prom.</p>
        </div>

        {([
          { id: "sin_stock" as const, label: "Sin stock", valor: resumen.sinStock, Icon: AlertTriangle, tono: "text-red-600", chip: "bg-red-50 text-red-600" },
          { id: "bajo" as const, label: "Stock bajo", valor: resumen.bajo, Icon: AlertTriangle, tono: "text-amber-600", chip: "bg-amber-50 text-amber-600" },
        ]).map((t) => {
          const activo = filtroEstado === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setFiltroEstado(activo ? "" : t.id)}
              aria-pressed={activo}
              className={`rounded-xl border bg-white p-3.5 text-left shadow-sm transition-[transform,border-color,box-shadow] duration-150 ease-out active:scale-[0.98] ${
                activo ? "border-[#4FAEB2] ring-2 ring-[#4FAEB2]/20" : "border-slate-200 hover:border-slate-300"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <p className="truncate text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">
                  {t.label}
                </p>
                <span className={`flex h-7 w-7 items-center justify-center rounded-lg ${t.chip}`}>
                  <t.Icon className="h-3.5 w-3.5" />
                </span>
              </div>
              <p className={`mt-1 text-2xl font-bold tracking-tight tabular-nums ${t.valor > 0 ? t.tono : "text-slate-900"}`}>
                {t.valor}
              </p>
              <p className="text-[11px] text-slate-400">{activo ? "filtrando" : "clic para filtrar"}</p>
            </button>
          );
        })}
      </div>

      {/* Buscador + filtros */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              type="search"
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              placeholder="Buscar por nombre, SKU o código de barras — palabras en cualquier orden…"
              className={`${inputClass} pl-9`}
            />
          </div>

          <button
            type="button"
            onClick={() => setVerFiltros((v) => !v)}
            className={`${btnSecundario} ${verFiltros || hayAjustes ? "border-[#4FAEB2] text-[#3F8E91]" : ""}`}
          >
            <SlidersHorizontal className="h-4 w-4" />
            Filtros y orden
            {hayAjustes && (
              <span className="ml-1 rounded-full bg-[#4FAEB2] px-1.5 text-[10px] font-bold text-white">•</span>
            )}
          </button>

          {hayAjustes && (
            <button type="button" onClick={limpiarFiltros} className={btnSecundario}>
              <X className="h-3.5 w-3.5" />
              Limpiar
            </button>
          )}
        </div>

        {verFiltros && (
          <div className="mt-3 grid grid-cols-1 gap-3 border-t border-slate-100 pt-3 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-500">Ordenar por</label>
              <select value={orden} onChange={(e) => setOrden(e.target.value as typeof orden)} className={inputClass}>
                <option value="nombre">Nombre (A-Z)</option>
                <option value="stock_asc">Menor stock primero</option>
                <option value="valor_desc">Mayor valor en stock</option>
                <option value="margen_desc">Mayor margen</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-500">Estado de stock</label>
              <select value={filtroEstado} onChange={(e) => setFiltroEstado(e.target.value as EstadoStock | "")} className={inputClass}>
                <option value="">Todos</option>
                <option value="sin_stock">Sin stock</option>
                <option value="bajo">Stock bajo</option>
                <option value="ok">Disponible</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-500">Ubicación</label>
              <select value={filtroUbicacion} onChange={(e) => setFiltroUbicacion(e.target.value)} className={inputClass}>
                <option value="">Todas</option>
                <option value="__sin__">Sin ubicación</option>
                {ubicaciones.map((u) => (
                  <option key={u.id} value={u.id}>{u.nombre}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-500">Precio de venta</label>
              <select value={filtroPrecio} onChange={(e) => setFiltroPrecio(e.target.value as typeof filtroPrecio)} className={inputClass}>
                <option value="">Todos</option>
                <option value="sin_precio">Sin precio (Gs. 0)</option>
                <option value="con_precio">Con precio cargado</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-500">Margen</label>
              <select value={filtroMargen} onChange={(e) => setFiltroMargen(e.target.value as typeof filtroMargen)} className={inputClass}>
                <option value="">Todos</option>
                <option value="alto">Alto (≥ 40%)</option>
                <option value="medio">Medio (20-40%)</option>
                <option value="bajo">Bajo (&lt; 20%)</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-500">Código de barras</label>
              <select value={filtroBarras} onChange={(e) => setFiltroBarras(e.target.value as typeof filtroBarras)} className={inputClass}>
                <option value="">Todos</option>
                <option value="con">Con código</option>
                <option value="sin">Sin código</option>
              </select>
            </div>
          </div>
        )}
      </div>

      {/* Listado */}
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
          <p className="text-sm font-semibold text-slate-900">
            Productos
            <span className="ml-2 text-xs font-normal text-slate-400">
              {productos.length === resumen.total
                ? `${productos.length} en total`
                : `${productos.length} de ${resumen.total}`}
            </span>
          </p>
          <div className="flex items-center gap-2">
            <label htmlFor="porpag" className="text-xs text-slate-500">Por página</label>
            <select
              id="porpag"
              value={porPagina}
              onChange={(e) => setPorPagina(Number(e.target.value))}
              className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs outline-none focus:border-[#4FAEB2]"
            >
              {POR_PAGINA_OPCIONES.map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </div>
        </div>

        {cargando ? (
          <div className="divide-y divide-slate-100">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex items-center gap-4 px-5 py-4">
                <div className="h-9 w-9 shrink-0 animate-pulse rounded-lg bg-slate-100" />
                <div className="flex-1 space-y-2">
                  <div className="h-3 w-1/3 animate-pulse rounded bg-slate-100" />
                  <div className="h-2.5 w-1/5 animate-pulse rounded bg-slate-50" />
                </div>
                <div className="h-6 w-20 animate-pulse rounded-full bg-slate-100" />
              </div>
            ))}
          </div>
        ) : visibles.length === 0 ? (
          <div className="px-6 py-16 text-center">
            <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-[#4FAEB2]/10">
              <PackageSearch className="h-5 w-5 text-[#4FAEB2]" />
            </div>
            {hayFiltros ? (
              <>
                <p className="text-sm font-semibold text-slate-900">Sin resultados</p>
                <p className="mx-auto mt-1 max-w-sm text-xs text-slate-500">
                  Ningún producto coincide con la búsqueda o los filtros elegidos.
                </p>
                <button type="button" onClick={limpiarFiltros} className={`mt-4 ${btnSecundario}`}>
                  Limpiar filtros
                </button>
              </>
            ) : (
              <>
                <p className="text-sm font-semibold text-slate-900">Todavía no hay productos</p>
                <p className="mx-auto mt-1 max-w-sm text-xs text-slate-500">
                  Cargá tu primer producto o importá el catálogo desde Excel.
                </p>
                <Link href="/inventario/nuevo" className={`mt-4 ${btnPrimario}`}>
                  <Plus className="h-4 w-4" />
                  Nuevo producto
                </Link>
              </>
            )}
          </div>
        ) : (
          <EdgeScrollArea>
            <table className="w-full min-w-[900px] text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-[11px] font-bold uppercase tracking-wide text-slate-500">
                  <th className="px-4 py-3">Producto</th>
                  <th className="px-3 py-3 text-right">Costo prom.</th>
                  <th className="px-3 py-3 text-right">Precio venta</th>
                  <th className="px-3 py-3 text-center">Stock</th>
                  <th className="hidden px-3 py-3 text-right lg:table-cell">Valor</th>
                  <th className="hidden px-3 py-3 text-right md:table-cell">Margen</th>
                  <th className="hidden px-3 py-3 lg:table-cell">Ubicación</th>
                  <th className="w-10 px-2 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {visibles.map((p, i) => {
                  const estado = estadoStockDe(p);
                  const meta = ESTADO_META[estado];
                  const margen = calcularMargenVenta(p.costo_promedio, p.precio_venta);
                  const valor = p.stock_actual * p.costo_promedio;
                  const ubi = p.ubicacion_principal_id ? ubicacionById.get(p.ubicacion_principal_id) : null;
                  return (
                    <tr
                      key={p.id}
                      className="zentra-row-in align-middle transition-colors duration-150 hover:bg-[#4FAEB2]/5"
                      style={{ animationDelay: `${Math.min(i, 10) * 30}ms` }}
                    >
                      <td className="px-4 py-3">
                        <p className="font-semibold leading-snug text-slate-900">{p.nombre}</p>
                        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-slate-400">
                          <span className="font-mono">{p.sku}</span>
                          {p.codigo_barras && (
                            <>
                              <span className="text-slate-300">·</span>
                              <span className="font-mono">{p.codigo_barras}</span>
                            </>
                          )}
                        </p>
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums text-slate-600">
                        {p.costo_promedio > 0 ? formatGs(p.costo_promedio) : <span className="text-slate-300">—</span>}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums font-medium text-slate-800">
                        {p.precio_venta > 0
                          ? formatGs(p.precio_venta)
                          : <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[11px] font-semibold text-amber-700">sin precio</span>}
                      </td>
                      <td className="px-3 py-3 text-center">
                        <span className={`text-sm font-bold tabular-nums ${meta.texto}`}>
                          {formatStock(p.stock_actual)}
                        </span>
                        <p className="text-[11px] text-slate-400 tabular-nums">mín. {formatStock(p.stock_minimo)}</p>
                        <span className={`mt-0.5 inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ${meta.badge}`}>
                          {meta.label}
                        </span>
                      </td>
                      <td className="hidden px-3 py-3 text-right tabular-nums text-slate-600 lg:table-cell">
                        {valor > 0 ? formatGs(valor) : <span className="text-slate-300">—</span>}
                      </td>
                      <td className="hidden px-3 py-3 text-right md:table-cell">
                        <span className={`text-sm font-semibold tabular-nums ${margenColor(margen)}`}>
                          {margen.toFixed(1)}%
                        </span>
                      </td>
                      <td className="hidden px-3 py-3 text-xs text-slate-500 lg:table-cell">
                        {ubi ? ubi.nombre : <span className="text-slate-300">—</span>}
                      </td>
                      <td className="px-2 py-3 text-center">
                        <Link
                          href={`/inventario/${p.id}/editar`}
                          className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:border-[#4FAEB2] hover:text-[#3F8E91]"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                          Editar
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </EdgeScrollArea>
        )}

        {/* Paginado */}
        {!cargando && productos.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-4 py-3">
            <p className="text-xs text-slate-500 tabular-nums">
              Mostrando {desde}–{hasta} de {productos.length}
            </p>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setPagina((n) => Math.max(1, n - 1))}
                disabled={paginaSegura <= 1}
                className={btnSecundario}
              >
                <ChevronLeft className="h-4 w-4" />
                Anterior
              </button>
              <span className="px-3 text-xs font-medium tabular-nums text-slate-600">
                {paginaSegura} / {totalPaginas}
              </span>
              <button
                type="button"
                onClick={() => setPagina((n) => Math.min(totalPaginas, n + 1))}
                disabled={paginaSegura >= totalPaginas}
                className={btnSecundario}
              >
                Siguiente
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
