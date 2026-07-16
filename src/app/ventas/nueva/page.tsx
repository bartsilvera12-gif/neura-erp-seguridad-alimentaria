"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { Search, Plus, Minus, Trash2, Image as ImageIcon } from "lucide-react";
import NuevoClienteRapidoModal, { type NuevoClienteCreado } from "./NuevoClienteRapidoModal";
import { useRouter } from "next/navigation";
import MontoInput from "@/components/ui/MontoInput";
import ProductPickerModal, { type ProductoPickerItem, type AgregarVentaPayload } from "@/components/inventario/ProductPickerModal";
import { saveVenta, type FaltanteStock } from "@/lib/ventas/storage";
import { getProductos } from "@/lib/inventario/storage";
import { productoMatchesQuery } from "@/lib/productos/token-search";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import type { TipoIvaVenta, TipoVenta, MonedaVenta, LineaVenta, MetodoPago, TipoPrecioVenta } from "@/lib/ventas/types";
import type { Producto } from "@/lib/inventario/types";
import type { MetodoValuacion } from "@/lib/inventario/types";

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatGs(valor: number) {
  return `Gs. ${Math.round(valor).toLocaleString("es-PY")}`;
}

/** Miniatura del producto con fallback a un ícono cuando no hay imagen. */
function ProductoThumb({ url, alt }: { url?: string | null; alt: string }) {
  if (url) {
    return (
      <Image
        src={url}
        alt={alt}
        width={36}
        height={36}
        className="h-9 w-9 shrink-0 rounded-md border border-slate-200 object-cover"
        unoptimized
      />
    );
  }
  return (
    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-slate-200 bg-slate-50 text-slate-300">
      <ImageIcon className="h-4 w-4" />
    </span>
  );
}

/**
 * IVA INCLUIDO: el precio de venta ya contiene el IVA. `total` es precio × cantidad
 * (= total de la línea). El IVA se desglosa desde adentro, NO se suma encima.
 *   EXENTA → 0 · 5% → total - total/1.05 · 10% → total - total/1.10
 */
function calcIva(tipo: TipoIvaVenta, total: number) {
  if (tipo === "EXENTA") return 0;
  if (tipo === "5%")     return total - total / 1.05;
  return total - total / 1.10;
}

/**
 * Precio unitario (Gs.) según el tipo elegido, con fallbacks:
 *  minorista → precio_venta;
 *  mayorista → precio_mayorista (>0) o fallback a precio_venta;
 *  costo     → costo_promedio.
 */
function precioPorTipo(p: Producto, tipo: TipoPrecioVenta): number {
  if (tipo === "mayorista") return p.precio_mayorista != null && p.precio_mayorista > 0 ? p.precio_mayorista : p.precio_venta;
  if (tipo === "distribuidor") return p.precio_distribuidor != null && p.precio_distribuidor > 0 ? p.precio_distribuidor : p.precio_venta;
  if (tipo === "costo") return p.costo_promedio ?? 0; // histórico: ya no se ofrece en la UI
  return p.precio_venta;
}

// ── Estilos ────────────────────────────────────────────────────────────────────

const inputClass =
  "w-full border border-slate-200 rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-[#0EA5E9] focus:outline-none bg-white text-sm";
const labelClass = "block text-sm font-medium text-slate-700 mb-1.5";

// ── Sub-componentes ───────────────────────────────────────────────────────────

function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  disabled,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className={`flex border border-slate-200 rounded-lg overflow-hidden ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          disabled={disabled}
          onClick={() => onChange(opt.value)}
          className={`flex-1 py-2 text-sm font-medium transition-colors ${
            value === opt.value
              ? "bg-[#0EA5E9] text-white"
              : "bg-white text-slate-600 hover:bg-slate-50"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-3">
      {children}
    </p>
  );
}

// ── Componente principal ───────────────────────────────────────────────────────

export default function NuevaVentaPage() {
  const router = useRouter();

  // ── Estado global ──────────────────────────────────────────────────────────
  const [productos, setProductos]   = useState<Producto[]>([]);
  const [items, setItems]           = useState<LineaVenta[]>([]);
  const [errorLinea, setErrorLinea] = useState<string | null>(null);
  const [errorVenta, setErrorVenta] = useState<string | null>(null);
  // Venta sin stock: faltantes devueltos por el backend + modal de confirmación.
  const [faltantes, setFaltantes] = useState<FaltanteStock[]>([]);
  const [confirmSinStockOpen, setConfirmSinStockOpen] = useState(false);
  // Guard anti doble-submit: estado para UI (botón/spinner) + ref para bloqueo síncrono
  // inmediato (React puede tardar en aplicar el estado; el ref corta el segundo disparo ya).
  const [guardando, setGuardando] = useState(false);
  const isSubmittingRef = useRef(false);

  // Facturación de un pedido enviado a Caja (?pedido_id=...). Precarga items + cliente.
  const [pedidoId, setPedidoId] = useState<string | null>(null);
  const [pedidoNumero, setPedidoNumero] = useState<string | null>(null);

  // ── Condiciones de la venta ───────────────────────────────────────────────
  // Instancia dedicada: siempre Guaraníes.
  const moneda: MonedaVenta = "GS";

  // Contado / Crédito (campos ya existentes en `ventas`: tipo_venta + plazo_dias).
  const [tipoVenta, setTipoVenta] = useState<TipoVenta>("CONTADO");
  const [plazoDias, setPlazoDias] = useState("");
  /**
   * Tipo de documento a emitir:
   *  - "factura": puente venta→factura activo → tras confirmar, redirect a
   *    /facturas/[id]?auto=1 (arranca pipeline SIFEN).
   *  - "ticket": NO emite factura ERP. Se registra la venta y se imprime el
   *    ticket comanda; queda un modal post-venta con acciones opcionales.
   *
   * Esta instancia AÚN NO tiene SIFEN configurado: el tipo queda fijo en
   * "ticket" y el selector de documento no se muestra (emitir factura arrancaría
   * un pipeline que falla sin certificado/timbrado). Para reactivarlo cuando
   * configuren la facturación electrónica: volver el default a "factura" y
   * restaurar el <SegmentedControl> de documento (ver historial de git).
   */
  const [tipoDocumento] = useState<"factura" | "ticket">("ticket");

  // Cliente (opcional). Si se selecciona, se envía cliente_id al crear la venta.
  type ClienteLite = { id: string; label: string; ruc: string | null; usa_nota_remision: boolean; nivel_precio: "minorista" | "mayorista" | "distribuidor" };
  const [clientes, setClientes] = useState<ClienteLite[]>([]);
  const [clienteId, setClienteId] = useState("");
  const [clienteQuery, setClienteQuery] = useState("");
  const [modalNuevoCliente, setModalNuevoCliente] = useState(false);
  const [clienteOpen, setClienteOpen] = useState(false);
  const clienteContainerRef = useRef<HTMLDivElement>(null);
  // Nota de remisión: activada si el cliente la usa; toggle manual solo con cliente.
  const [generaNotaRemision, setGeneraNotaRemision] = useState(false);

  // ── Cobro (solo CONTADO, no se persiste — solo ayuda al cajero) ───────────
  const [montoRecibido, setMontoRecibido] = useState("");
  const [metodoPago, setMetodoPago] = useState<MetodoPago>("efectivo");

  // ── Detalle de cobro (conciliación bancaria) ──────────────────────────────
  const [entidades, setEntidades] = useState<{ id: string; codigo: string | null; nombre: string; tipo: string | null }[]>([]);
  const [pagoEntidadId, setPagoEntidadId] = useState("");
  const [pagoReferencia, setPagoReferencia] = useState("");
  const [pagoTitular, setPagoTitular] = useState("");
  const [pagoObservacion] = useState("");
  // Modal de cobro (transferencia / tarjeta) + buscador de entidad.
  const [cobroModalOpen, setCobroModalOpen] = useState(false);
  const [entidadQuery, setEntidadQuery] = useState("");

  // ── Combobox de producto (autocomplete server-side) ─────────────────────────
  const [comboQuery,     setComboQuery]     = useState("");
  const [comboOpen,      setComboOpen]      = useState(false);
  const [comboHighlight, setComboHighlight] = useState(-1);
  const [comboHits,      setComboHits]      = useState<Producto[]>([]);
  const [comboBuscando,  setComboBuscando]  = useState(false);
  const comboTimerRef    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const comboInputRef    = useRef<HTMLInputElement>(null);
  const comboContainerRef = useRef<HTMLDivElement>(null);

  // ── Modal buscador (F3) ────────────────────────────────────────────────────
  const [pickerOpen, setPickerOpen] = useState(false);

  function pickerToProducto(p: ProductoPickerItem): Producto {
    return {
      id: p.id,
      nombre: p.nombre,
      sku: p.sku,
      tipo_iva: p.tipo_iva,
      precio_venta: p.precio_venta,
      precio_mayorista: p.precio_mayorista ?? null,
      precio_distribuidor: p.precio_distribuidor ?? null,
      stock_actual: p.stock_actual,
      unidad_medida: p.unidad_medida,
      costo_promedio: p.costo_promedio ?? 0,
      stock_minimo: 0,
      metodo_valuacion: "CPP",
      codigo_barras: p.codigo_barras,
      codigo_barras_interno: p.codigo_barras_interno,
      imagen_path: null,
      imagen_url: p.imagen_url,
    };
  }

  /**
   * Agregado directo desde el modal: arma la LineaVenta usando la misma
   * logica que handleAgregarLinea pero con datos del modal, sin pasar
   * por el form inline. Mantiene el modal abierto si todo OK.
   */
  function handleAgregarDesdePicker(payload: AgregarVentaPayload): boolean {
    const { producto: p, cantidad, precio_input, iva, tipo_precio } = payload;
    const precioPyg = precio_input;
    // Verificar stock vs lo ya cargado SOLO si el producto controla stock.
    // Venta sin stock (Fase 5): NO se bloquea por falta de stock al agregar; la
    // confirmación se pide al registrar la venta. El Menú (controla_stock=false) tampoco valida.
    // IVA incluido: el total de la línea es precio × cantidad; el IVA se desglosa
    // desde adentro y el subtotal (base imponible) = total − IVA.
    const totalLinea = cantidad * precioPyg;
    const montoIva = calcIva(iva, totalLinea);
    const subtotal = totalLinea - montoIva;

    // Asegurar que el producto este en el array local (para que stock_actual
    // se conozca en validaciones posteriores del form inline).
    const prodLocal = pickerToProducto(p);
    setProductos((prev) => (prev.find((x) => x.id === prodLocal.id) ? prev : [...prev, prodLocal]));

    setItems((prev) => [
      ...prev,
      {
        producto_id: p.id,
        producto_nombre: p.nombre,
        sku: p.sku,
        cantidad,
        precio_venta_original: precio_input,
        precio_venta: precioPyg,
        tipo_iva: iva,
        tipo_precio,
        subtotal,
        monto_iva: montoIva,
        total_linea: totalLinea,
      },
    ]);
    setErrorVenta(null);
    return true;
  }

  useEffect(() => {
    let cancelled = false;
    getProductos().then((data) => {
      if (!cancelled) setProductos(data);
    });
    return () => { cancelled = true; };
  }, []);

  // Precarga al facturar un pedido (Caja): lee ?pedido_id=, trae el pedido y carga sus
  // items + cliente en el carrito. NO crea nada acá; la venta se genera al confirmar.
  useEffect(() => {
    let cancelled = false;
    let pid: string | null = null;
    try {
      pid = new URLSearchParams(window.location.search).get("pedido_id");
    } catch { pid = null; }
    if (!pid) return;
    setPedidoId(pid);
    (async () => {
      try {
        const [res, prodList] = await Promise.all([
          fetch(`/api/proyectos/${pid}`, { credentials: "include", cache: "no-store" }),
          getProductos().catch(() => [] as Producto[]),
        ]);
        const j = await res.json();
        if (cancelled || !j?.success || !j.data?.proyecto) return;
        // El pedido en caja NO guarda el IVA por ítem (brief_data.items solo trae
        // producto_id/cantidad/precio). Recuperamos el tipo_iva REAL de cada
        // producto para no forzar 10% al facturar (bug: productos 5%/exenta como
        // sésamo/girasol se facturaban al 10%).
        const ivaPorProducto = new Map<string, TipoIvaVenta>(
          prodList.map((prod): [string, TipoIvaVenta] => [String(prod.id), (prod.tipo_iva ?? "10%") as TipoIvaVenta])
        );
        const p = j.data.proyecto as { brief_data?: unknown; cliente_id?: string | null; metadata?: unknown };
        const brief = (p.brief_data && typeof p.brief_data === "object" && !Array.isArray(p.brief_data))
          ? (p.brief_data as Record<string, unknown>) : {};
        const meta = (p.metadata && typeof p.metadata === "object" && !Array.isArray(p.metadata))
          ? (p.metadata as Record<string, unknown>) : {};
        setPedidoNumero(
          (typeof brief.numero_control === "string" && brief.numero_control) ||
          (typeof brief.numero_presupuesto === "string" && brief.numero_presupuesto) ||
          (typeof meta.numero_presupuesto === "string" && meta.numero_presupuesto) || null
        );
        const itemsRaw = Array.isArray(brief.items) ? (brief.items as Record<string, unknown>[]) : [];
        const lineas: LineaVenta[] = itemsRaw
          .filter((it) => it.producto_id && (Number(it.cantidad) || 0) > 0)
          .map((it) => {
            const cantidad = Number(it.cantidad) || 0;
            const precio = Number(it.precio_venta) || 0;
            // Prioriza el IVA guardado en el ítem si existiera; si no, el del
            // producto (fuente de verdad). Solo cae a 10% si no hay dato alguno.
            const ivaGuardado = it.iva_tipo ?? it.tipo_iva;
            const iva: TipoIvaVenta =
              ivaGuardado === "EXENTA" || ivaGuardado === "5%" || ivaGuardado === "10%"
                ? ivaGuardado
                : ivaPorProducto.get(String(it.producto_id)) ?? "10%";
            // IVA incluido: total de línea = precio × cantidad; IVA desglosado desde adentro.
            const totalLinea = cantidad * precio;
            const montoIva = calcIva(iva, totalLinea);
            const subtotal = totalLinea - montoIva;
            return {
              producto_id: String(it.producto_id),
              producto_nombre: typeof it.producto_nombre === "string" ? it.producto_nombre : "",
              sku: typeof it.sku === "string" ? it.sku : "",
              cantidad,
              precio_venta_original: precio,
              precio_venta: precio,
              tipo_iva: iva,
              tipo_precio: ((): TipoPrecioVenta => {
                const t = typeof it.tipo_precio === "string" ? it.tipo_precio : "";
                return t === "mayorista" || t === "distribuidor" || t === "costo" ? t as TipoPrecioVenta : "minorista";
              })(),
              subtotal,
              monto_iva: montoIva,
              total_linea: totalLinea,
            };
          });
        if (!cancelled && lineas.length) setItems(lineas);
        if (!cancelled && p.cliente_id) setClienteId(String(p.cliente_id));
      } catch { /* el aviso seguirá visible; el cajero puede cargar manualmente */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // Cargar entidades bancarias (caja/banco/tarjeta/billetera) para el detalle de cobro.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/entidades-bancarias", { credentials: "include", cache: "no-store" })
      .then((r) => r.json())
      .then((j) => { if (!cancelled && j?.success) setEntidades(j.data?.entidades ?? []); })
      .catch(() => { /* no bloquea la venta si falla */ });
    return () => { cancelled = true; };
  }, []);

  // Cargar clientes (buscador opcional de cliente en la venta).
  // Se recarga al montar Y cada vez que la ventana recupera el foco — así, si el
  // usuario abrió "Cargar nuevo cliente" en otra pestaña y volvió, el nuevo
  // cliente aparece en el buscador sin refrescar la página.
  const fetchClientes = useCallback(async () => {
    try {
      const r = await fetch("/api/clientes", { credentials: "include", cache: "no-store" });
      const j = await r.json();
      if (!j?.success || !Array.isArray(j.data)) return;
      const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
      const lite: ClienteLite[] = (j.data as Record<string, unknown>[]).map((row) => ({
        id: String(row.id),
        label: s(row.empresa) || s(row.nombre_contacto) || s(row.nombre) || "Cliente",
        ruc: s(row.ruc) || null,
        usa_nota_remision: row.usa_nota_remision === true,
        nivel_precio: (row.nivel_precio === "mayorista" || row.nivel_precio === "distribuidor" ? row.nivel_precio : "minorista") as "minorista" | "mayorista" | "distribuidor",
      }));
      setClientes(lite);
    } catch {
      /* el buscador de cliente es opcional, no bloquea la venta */
    }
  }, []);
  useEffect(() => {
    let cancelled = false;
    void fetchClientes();
    const onFocus = () => { if (!cancelled) void fetchClientes(); };
    window.addEventListener("focus", onFocus);
    return () => { cancelled = true; window.removeEventListener("focus", onFocus); };
  }, []);

  // UX rápida: al entrar, enfocar el buscador inline para empezar a cargar de
  // una (sin abrir modales). El "Buscador avanzado" (picker) queda a un clic.
  useEffect(() => {
    const t = setTimeout(() => comboInputRef.current?.focus(), 120);
    return () => clearTimeout(t);
  }, []);

  // Autocomplete: búsqueda server-side por tokens (todo el catálogo), con debounce.
  useEffect(() => {
    const q = comboQuery.trim();
    if (comboTimerRef.current) clearTimeout(comboTimerRef.current);
    if (q.length < 2) { setComboHits([]); setComboBuscando(false); return; }
    setComboBuscando(true);
    comboTimerRef.current = setTimeout(async () => {
      try {
        const res = await fetchWithSupabaseSession(
          `/api/productos/search?q=${encodeURIComponent(q)}&limit=20`,
          { cache: "no-store" }
        );
        const j = await res.json();
        const items = ((j?.data?.items ?? []) as Record<string, unknown>[]).map((p): Producto => ({
          id: String(p.id),
          nombre: String(p.nombre ?? ""),
          sku: String(p.sku ?? ""),
          costo_promedio: Number(p.costo_promedio) || 0,
          precio_venta: Number(p.precio_venta) || 0,
          precio_mayorista: p.precio_mayorista != null ? Number(p.precio_mayorista) : null,
          precio_distribuidor: p.precio_distribuidor != null ? Number(p.precio_distribuidor) : null,
          stock_actual: Number(p.stock_actual) || 0,
          stock_minimo: Number(p.stock_minimo) || 0,
          unidad_medida: String(p.unidad_medida ?? "UNIDAD"),
          metodo_valuacion: (typeof p.metodo_valuacion === "string" ? p.metodo_valuacion : "CPP") as MetodoValuacion,
          es_vendible: p.es_vendible !== false,
          controla_stock: p.controla_stock !== false,
          tipo_iva: (p.tipo_iva === "EXENTA" || p.tipo_iva === "5%" ? p.tipo_iva : "10%") as TipoIvaVenta,
          imagen_url: (p.imagen_url as string | null) ?? null,
          imagen_path: (p.imagen_path as string | null) ?? null,
        }));
        setComboHits(items);
        // Merge a `productos` para que los lookups (tipo de precio, stock) resuelvan.
        if (items.length > 0) {
          setProductos((prev) => {
            const byId = new Map(prev.map((x) => [x.id, x]));
            for (const it of items) byId.set(it.id, { ...byId.get(it.id), ...it });
            return [...byId.values()];
          });
        }
      } catch {
        setComboHits([]);
      } finally {
        setComboBuscando(false);
      }
    }, 220);
    return () => { if (comboTimerRef.current) clearTimeout(comboTimerRef.current); };
  }, [comboQuery]);

  // Cerrar el dropdown del buscador al hacer clic fuera.
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (comboContainerRef.current && !comboContainerRef.current.contains(e.target as Node)) {
        setComboOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Scroll a la opción destacada en el dropdown.
  useEffect(() => {
    if (comboHighlight >= 0) {
      document.getElementById(`combo-opt-${comboHighlight}`)?.scrollIntoView({ block: "nearest" });
    }
  }, [comboHighlight]);

  // Cerrar dropdown al hacer clic fuera
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (comboContainerRef.current && !comboContainerRef.current.contains(e.target as Node)) {
        setComboOpen(false);
      }
      if (clienteContainerRef.current && !clienteContainerRef.current.contains(e.target as Node)) {
        setClienteOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Scroll a la opción destacada en el dropdown
  useEffect(() => {
    if (comboHighlight >= 0) {
      document.getElementById(`combo-opt-${comboHighlight}`)?.scrollIntoView({ block: "nearest" });
    }
  }, [comboHighlight]);

  // ── Cálculos ───────────────────────────────────────────────────────────────
  const tipoCambioNum = 1;

  const totalSubtotal = items.reduce((s, i) => s + i.subtotal, 0);
  const totalIva      = items.reduce((s, i) => s + i.monto_iva, 0);
  const totalGeneral  = items.reduce((s, i) => s + i.total_linea, 0);
  // Condición de venta: si es Crédito, exigir plazo de al menos 1 día.
  const plazoDiasNum = parseInt(plazoDias) || 0;
  // Crédito exige cliente seleccionado Y plazo/vencimiento (≥1 día). Genera cuenta por cobrar.
  const creditoValido = tipoVenta === "CONTADO" || (plazoDiasNum >= 1 && !!clienteId);
  // Cliente obligatorio SOLO si vamos a emitir factura electrónica (SIFEN
  // requiere receptor) o si es crédito (necesita CxC). Para "Solo ticket" a
  // consumidor final, la venta puede ir sin cliente.
  const clienteObligatorio = tipoDocumento === "factura" || tipoVenta === "CREDITO";
  const ventaValida   = items.length > 0 && creditoValido && (!clienteObligatorio || !!clienteId);

  // Cliente (opcional) — selección + filtrado del buscador.
  const clienteSel = clientes.find((c) => c.id === clienteId) ?? null;
  const clientesFiltrados = (clienteQuery.trim() === ""
    ? clientes
    : clientes.filter((c) => productoMatchesQuery(clienteQuery, c.label, c.ruc))
  ).slice(0, 50);

  // Cobro: entidad seleccionada + filtrado por código/nombre.
  const entidadSel = entidades.find((e) => e.id === pagoEntidadId) ?? null;
  const entidadesFiltradas = (entidadQuery.trim() === ""
    ? entidades
    : entidades.filter((e) => productoMatchesQuery(entidadQuery, e.nombre, e.codigo))
  ).slice(0, 50);

  // Vuelto (solo informativo, no se persiste)
  const montoRecibidoNum = parseFloat(montoRecibido) || 0;
  const vuelto           = montoRecibidoNum - totalGeneral;

  // ── Resultados del autocomplete de producto ────────────────────────────────
  // Vienen del endpoint de búsqueda server-side (token search sobre TODO el
  // catálogo, no un subconjunto en memoria).
  const comboResultados = comboHits;

  /** Selecciona método de cobro. Efectivo no pide datos; transferencia/tarjeta abren modal. */
  function handleSelectMetodo(m: MetodoPago) {
    setMetodoPago(m);
    if (m === "efectivo") {
      setCobroModalOpen(false);
      // "Caja efectivo" por defecto si existe una entidad tipo caja.
      const caja = entidades.find((e) => e.tipo === "caja");
      setPagoEntidadId(caja ? caja.id : "");
      setPagoTitular("");
    } else {
      setEntidadQuery("");
      setCobroModalOpen(true);
    }
  }

  function handleEliminarLinea(index: number) {
    setItems((prev) => prev.filter((_, i) => i !== index));
  }

  // ── Autocomplete rápido + edición inline de la tabla ───────────────────────
  /** Recalcula subtotal/IVA/total de una línea (IVA incluido, igual que calcIva). */
  function recomputeLinea(l: LineaVenta): LineaVenta {
    const total_linea = l.cantidad > 0 && l.precio_venta > 0 ? l.cantidad * l.precio_venta : 0;
    const monto_iva = calcIva(l.tipo_iva, total_linea);
    return { ...l, total_linea, monto_iva, subtotal: total_linea - monto_iva };
  }

  /** Agrega un producto directo desde el autocomplete: si ya está suma +1; si no,
   *  crea la línea. Luego limpia el input y devuelve el foco (carga rápida tipo caja). */
  function agregarProductoRapido(p: Producto) {
    const precio = precioPorTipo(p, "minorista");
    setProductos((prev) => (prev.find((x) => x.id === p.id) ? prev : [...prev, p]));
    setItems((prev) => {
      const idx = prev.findIndex((it) => it.producto_id === p.id);
      if (idx >= 0) {
        return prev.map((it, i) => (i === idx ? recomputeLinea({ ...it, cantidad: it.cantidad + 1 }) : it));
      }
      return [
        ...prev,
        recomputeLinea({
          producto_id: p.id,
          producto_nombre: p.nombre,
          sku: p.sku,
          cantidad: 1,
          precio_venta_original: precio,
          precio_venta: precio,
          tipo_iva: p.tipo_iva ?? "10%",
          tipo_precio: "minorista",
          subtotal: 0,
          monto_iva: 0,
          total_linea: 0,
        }),
      ];
    });
    setComboQuery("");
    setComboOpen(false);
    setComboHighlight(-1);
    setErrorLinea(null);
    setTimeout(() => comboInputRef.current?.focus(), 0);
  }

  function updateItemCampo(idx: number, patch: Partial<LineaVenta>) {
    setItems((prev) => prev.map((it, i) => (i === idx ? recomputeLinea({ ...it, ...patch }) : it)));
  }
  function changeCantidadItem(idx: number, delta: number) {
    setItems((prev) => prev.map((it, i) => (i === idx ? recomputeLinea({ ...it, cantidad: Math.max(1, it.cantidad + delta) }) : it)));
  }
  function changeTipoPrecioItem(idx: number, tipo: TipoPrecioVenta) {
    setItems((prev) =>
      prev.map((it, i) => {
        if (i !== idx) return it;
        const prod = productos.find((p) => p.id === it.producto_id);
        const precio = prod ? precioPorTipo(prod, tipo) : it.precio_venta;
        return recomputeLinea({ ...it, tipo_precio: tipo, precio_venta: precio, precio_venta_original: precio });
      })
    );
  }

  /** Teclado del autocomplete: ↑/↓ navega, Enter agrega el resaltado (o el primero), Esc cierra. */
  function onComboKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setComboOpen(true);
      setComboHighlight((h) => Math.min(h + 1, comboResultados.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setComboHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const sel = comboResultados[comboHighlight] ?? comboResultados[0];
      if (sel) agregarProductoRapido(sel);
    } else if (e.key === "Escape") {
      setComboOpen(false);
      setComboHighlight(-1);
    }
  }

  /** Envía la venta. Con `permitirSinStock=true` autoriza vender aunque falte stock. */
  async function enviarVenta(permitirSinStock: boolean) {
    // Guard duro contra doble submit: si ya hay una confirmación en vuelo, cortar
    // inmediatamente. El ref se evalúa de forma síncrona (no espera al re-render de React),
    // así que un segundo click/Enter casi simultáneo no puede disparar otra venta.
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    // Cliente obligatorio si emitimos factura ERP (SIFEN necesita receptor) o si
    // es crédito (necesita CxC). "Solo ticket" en efectivo puede ir sin cliente.
    if (clienteObligatorio && !clienteId) {
      isSubmittingRef.current = false;
      const motivo =
        tipoDocumento === "factura"
          ? "Para emitir factura electrónica"
          : "Para venta a crédito";
      setErrorVenta(`${motivo} tenés que elegir un cliente. Podés cargarlo rápido desde el buscador de arriba.`);
      return;
    }
    setGuardando(true);
    try {
      const resultado = await saveVenta(
        {
          items,
          moneda,
          tipo_cambio:  tipoCambioNum,
          subtotal:     totalSubtotal,
          monto_iva:    totalIva,
          total:        totalGeneral,
          tipo_venta:   tipoVenta,
          plazo_dias:   tipoVenta === "CREDITO" ? plazoDiasNum : undefined,
          metodo_pago:  metodoPago,
          cliente_id:   clienteId || null,
          genera_nota_remision: !!clienteId && generaNotaRemision,
          emitir_factura: tipoDocumento === "factura",
        },
        undefined,
        {
          entidad_bancaria_id: pagoEntidadId || null,
          entidad_nombre_snapshot: entidades.find((e) => e.id === pagoEntidadId)?.nombre ?? null,
          referencia: pagoReferencia.trim() || null,
          titular: metodoPago === "transferencia" ? pagoTitular.trim() || null : null,
          observacion: pagoObservacion.trim() || null,
        },
        { permitirSinStock, pedidoId }
      );

      if (!resultado.success) {
        // Falta stock sin autorizar → abrir modal de confirmación con el detalle.
        // (El guard se libera en el finally para permitir confirmar sin stock.)
        if (resultado.faltantes && resultado.faltantes.length > 0) {
          setFaltantes(resultado.faltantes);
          setConfirmSinStockOpen(true);
          return;
        }
        setErrorVenta(resultado.error);
        return;
      }
      const v = resultado.venta;
      const generaNota = v.genera_nota_remision === true || !!v.nota_remision_numero;

      // Redirección directa al panel SIFEN con ?auto=1: el panel detecta ese
      // flag y auto-ejecuta el pipeline (borrador → xml → firmar → enviar)
      // apenas monta. Al aprobar SET, abre el KUDE en una pestaña nueva para
      // imprimir. Un solo click del operador dispara toda la cadena legal.
      //
      // Solo se dispara si el cajero eligió "Factura" en el toggle. Si eligió
      // "Ticket", saltamos al fallback (imprime ticket + modal post-venta).
      if (tipoDocumento === "factura" && resultado.factura?.id) {
        router.push(`/facturas/${resultado.factura.id}?auto=1`);
        return;
      }

      // Ticket (y nota de remisión si aplica) se abren en pestaña aparte y el
      // cajero vuelve directo a Caja: sin modal intermedio, la carga de la
      // siguiente venta arranca de una. Si el navegador bloquea la pestaña, el
      // ticket se reimprime desde el listado de ventas.
      const ticketUrl = `/api/ventas/${v.id}/ticket?mode=comandas&auto=1`;
      const remisionUrl = `/api/ventas/${v.id}/ticket?tipo=remision&auto=1`;
      try { window.open(ticketUrl, "_blank", "noopener"); } catch {}
      if (generaNota) { try { window.open(remisionUrl, "_blank", "noopener"); } catch {} }
      router.push("/ventas");
    } finally {
      // Liberar el guard SIEMPRE: éxito, error o flujo de "confirmar sin stock".
      isSubmittingRef.current = false;
      setGuardando(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrorVenta(null);
    if (!ventaValida) return;
    await enviarVenta(false);
  }

  async function confirmarVentaSinStock() {
    setConfirmSinStockOpen(false);
    setErrorVenta(null);
    await enviarVenta(true);
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-8">

      <div>
        <h1 className="text-2xl sm:text-3xl font-bold text-gray-800">Nueva venta</h1>
        <p className="text-gray-600">
          Buscá un producto y se agrega al instante. Revisá cantidades y precios en la tabla.
        </p>
      </div>

      {pedidoId && (
        <div className="rounded-lg border border-[#4FAEB2]/40 bg-[#4FAEB2]/[0.08] px-4 py-3 text-sm text-slate-700">
          <span className="font-semibold text-[#3F8E91]">Estás facturando un pedido{pedidoNumero ? ` (${pedidoNumero})` : ""}.</span>{" "}
          La venta se generará al confirmar y el pedido quedará marcado como facturado. Podés ajustar items, precios y método de pago.
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-6 max-w-7xl">

        {/* ── SECCIÓN 0: Datos de la venta (cliente opcional + condición) ────── */}
        <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-4 sm:p-6">
          <SectionTitle>Datos de la venta</SectionTitle>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">

            {/* Cliente — obligatorio si emite factura o si es crédito; opcional para "solo ticket" en efectivo */}
            <div ref={clienteContainerRef} className="relative">
              <label className={labelClass}>
                Cliente {clienteObligatorio ? (
                  <span className="text-rose-600">*</span>
                ) : (
                  <span className="text-slate-400 font-normal">(opcional para ticket)</span>
                )}
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={clienteSel ? clienteSel.label : clienteQuery}
                  onChange={(e) => { setClienteId(""); setClienteQuery(e.target.value); setClienteOpen(true); }}
                  onFocus={() => setClienteOpen(true)}
                  placeholder="Buscar por nombre o RUC…"
                  className={`${inputClass} ${clienteSel ? "font-medium" : ""}`}
                />
                {clienteSel && (
                  <button
                    type="button"
                    onClick={() => { setClienteId(""); setClienteQuery(""); setGeneraNotaRemision(false); }}
                    className="shrink-0 rounded-lg border border-slate-200 px-3 text-xs text-slate-500 hover:bg-slate-50"
                  >
                    Quitar
                  </button>
                )}
              </div>
              {clienteOpen && !clienteSel && (
                <div className="absolute z-20 mt-1 w-full max-h-64 overflow-auto rounded-lg border border-slate-200 bg-white shadow-lg">
                  {/* Acción al TOPE del dropdown: abre el modal de "nuevo cliente rápido". */}
                  <button
                    type="button"
                    onClick={() => { setClienteOpen(false); setModalNuevoCliente(true); }}
                    className="flex w-full items-center gap-1.5 border-b border-slate-100 bg-[#4FAEB2]/[0.06] px-3 py-2 text-left text-xs font-semibold text-[#3F8E91] hover:bg-[#4FAEB2]/[0.12]"
                    title="Se abre un mini formulario acá mismo, sin cambiar de página."
                  >
                    <span className="text-base leading-none">＋</span>
                    Cargar nuevo cliente
                    {clienteQuery.trim() && <span className="ml-1 truncate text-slate-500">«{clienteQuery.trim()}»</span>}
                  </button>
                  {clientesFiltrados.length === 0 ? (
                    <p className="px-3 py-2 text-xs text-gray-400">Sin clientes que coincidan.</p>
                  ) : (
                    clientesFiltrados.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => { setClienteId(c.id); setClienteQuery(""); setClienteOpen(false); setGeneraNotaRemision(c.usa_nota_remision); }}
                        className="block w-full text-left px-3 py-2 text-sm hover:bg-slate-50"
                      >
                        <span className="font-medium text-gray-800">{c.label}</span>
                        {c.ruc && <span className="ml-2 text-xs text-gray-400">RUC {c.ruc}</span>}
                        {c.usa_nota_remision && <span className="ml-2 text-[10px] rounded-full bg-sky-100 text-sky-700 px-1.5 py-0.5 font-semibold">Nota remisión</span>}
                      </button>
                    ))
                  )}
                </div>
              )}
              <p className="mt-1 text-[11px] text-gray-400">
                El cliente es opcional para el ticket. Si no existe, cargalo con “＋ Cargar nuevo cliente”.
              </p>
              {!clienteId && clienteObligatorio && (
                <p className="mt-1 text-[11px] text-rose-600">
                  La venta a crédito requiere un cliente seleccionado.
                </p>
              )}

              {/* Nota de remisión: solo con cliente. Si el cliente la usa, viene activada. */}
              {clienteSel && (
                <div className="mt-2 rounded-lg border border-sky-100 bg-sky-50/60 px-3 py-2">
                  {clienteSel.usa_nota_remision && (
                    <p className="mb-1.5 text-[11px] text-sky-700">
                      Este cliente usa nota de remisión. Se generará junto al ticket.
                    </p>
                  )}
                  <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={generaNotaRemision}
                      onChange={(e) => setGeneraNotaRemision(e.target.checked)}
                      className="h-4 w-4 rounded border-slate-300 text-[#0EA5E9] focus:ring-[#0EA5E9]"
                    />
                    Generar nota de remisión
                  </label>
                </div>
              )}
            </div>

            {/* Condición: Contado / Crédito */}
            <div>
              <label className={labelClass}>Condición</label>
              <SegmentedControl<TipoVenta>
                value={tipoVenta}
                options={[
                  { value: "CONTADO", label: "Contado" },
                  { value: "CREDITO", label: "Crédito" },
                ]}
                onChange={(v) => { setTipoVenta(v); if (v === "CONTADO") setPlazoDias(""); }}
              />
              {tipoVenta === "CREDITO" && (
                <div className="mt-3">
                  <label className={labelClass}>Plazo de crédito (días)</label>
                  <input
                    type="number"
                    min={1}
                    value={plazoDias}
                    onChange={(e) => setPlazoDias(e.target.value)}
                    placeholder="Ej: 30"
                    className={`${inputClass} ${plazoDiasNum < 1 ? "border-red-300 bg-red-50" : ""}`}
                  />
                  {plazoDiasNum < 1 && (
                    <p className="mt-1 text-[11px] text-red-600">Ingresá un plazo de al menos 1 día.</p>
                  )}
                  {!clienteId && (
                    <p className="mt-1 text-[11px] text-red-600">La venta a crédito requiere un cliente seleccionado.</p>
                  )}
                  <p className="mt-1 text-[11px] text-slate-500">Al confirmar se genera una cuenta por cobrar por el total.</p>
                </div>
              )}
            </div>

            {/* Documento a emitir — SIFEN no configurado en esta instancia: la venta
                sale siempre como ticket. El selector Factura/Ticket se oculta hasta
                activar la facturación electrónica (ver comentario en tipoDocumento). */}
            <div>
              <label className={labelClass}>Documento</label>
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5">
                <p className="text-sm font-medium text-slate-700">Ticket de venta</p>
                <p className="mt-0.5 text-[11px] text-slate-500">
                  Se registra la venta y se imprime un ticket. La facturación electrónica todavía no está habilitada para esta empresa.
                </p>
              </div>
            </div>

          </div>
        </div>

        {/* ── SECCIÓN 3: Carrito + totales + confirmar ─────────────────────── */}
        <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-4 sm:p-6">
          <div className="mb-3 flex items-center justify-between gap-2">
            <SectionTitle>Productos en esta venta</SectionTitle>
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              className="shrink-0 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 hover:border-[#4FAEB2] hover:text-[#3F8E91]"
              title="Buscador avanzado (más filtros, crear producto)"
            >
              Buscador avanzado
            </button>
          </div>

          {/* Autocomplete: al elegir un producto se agrega solo y se limpia. */}
          <div ref={comboContainerRef} className="relative">
            <Search className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-[#4FAEB2]" />
            <input
              ref={comboInputRef}
              type="text"
              value={comboQuery}
              onChange={(e) => { setComboQuery(e.target.value); setComboOpen(true); setComboHighlight(-1); }}
              onFocus={() => setComboOpen(true)}
              onKeyDown={onComboKeyDown}
              placeholder="Buscar producto por nombre, SKU o palabras clave…"
              className="h-12 w-full rounded-xl border-2 border-[#4FAEB2]/30 bg-white pl-12 pr-4 text-base text-slate-800 outline-none transition-all focus:border-[#4FAEB2] focus:ring-4 focus:ring-[#4FAEB2]/15"
              autoComplete="off"
            />
            {comboOpen && comboQuery.trim().length >= 2 && (
              <div className="absolute left-0 right-0 top-full z-30 mt-2 max-h-[56vh] overflow-y-auto rounded-xl border-2 border-[#4FAEB2]/20 bg-white shadow-[0_16px_40px_-12px_rgba(15,23,42,0.28)]">
                {comboBuscando && comboResultados.length === 0 ? (
                  <div className="px-4 py-5 text-center text-sm text-slate-400">Buscando…</div>
                ) : comboResultados.length === 0 ? (
                  <div className="px-4 py-5 text-center text-sm text-slate-400">Sin resultados para &quot;{comboQuery}&quot;.</div>
                ) : (
                  <ul className="divide-y divide-slate-100">
                    {comboResultados.map((p, i) => {
                      const controla = p.controla_stock !== false;
                      const sinStock = controla && (p.stock_actual ?? 0) <= 0;
                      return (
                        <li key={p.id}>
                          <button
                            type="button"
                            id={`combo-opt-${i}`}
                            onMouseEnter={() => setComboHighlight(i)}
                            onClick={() => agregarProductoRapido(p)}
                            className={`flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors ${i === comboHighlight ? "bg-[#4FAEB2]/10" : "hover:bg-slate-50"}`}
                          >
                            <ProductoThumb url={p.imagen_url} alt={p.nombre} />
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm font-semibold text-slate-800">{p.nombre}</p>
                              <div className="mt-0.5 flex items-center gap-2 text-xs text-slate-500">
                                <span className="font-mono">{p.sku}</span>
                                <span className="text-slate-300">·</span>
                                <span className={`font-semibold ${!controla ? "text-slate-400" : sinStock ? "text-red-600" : (p.stock_actual ?? 0) < 5 ? "text-amber-600" : "text-emerald-700"}`}>
                                  {!controla ? "Sin control" : sinStock ? "Sin stock" : `${p.stock_actual} ${p.unidad_medida ?? ""}`}
                                </span>
                              </div>
                            </div>
                            <span className="shrink-0 text-sm font-bold tabular-nums text-slate-800">{formatGs(precioPorTipo(p, "minorista"))}</span>
                            <span className="shrink-0 inline-flex items-center gap-1 rounded-lg bg-[#4FAEB2]/12 px-2.5 py-1 text-xs font-bold text-[#3F8E91]">
                              <Plus className="h-3.5 w-3.5" strokeWidth={2.5} /> Agregar
                            </span>
                          </button>
                        </li>
                      );
                    })}
                    {comboResultados.length >= 20 && (
                      <li className="px-4 py-2 text-center text-[11px] text-slate-400">
                        Mostrando los primeros 20. Refiná la búsqueda para acotar.
                      </li>
                    )}
                  </ul>
                )}
              </div>
            )}
          </div>

          {items.length === 0 ? (
            <div className="mt-4 py-10 text-center text-gray-400 text-sm border-2 border-dashed border-gray-200 rounded-lg">
              Buscá un producto arriba y se agrega automáticamente a la venta.
            </div>
          ) : (
            <>
              {/* Tabla editable: cantidad (± / campo), nivel de precio, IVA y precio
                  unitario son editables por fila. min-w fuerza scroll en mobile. */}
              <div className="mt-4 overflow-x-auto rounded-xl border border-slate-200">
                <table className="w-full min-w-[900px] text-sm text-left">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-[11px] font-bold uppercase tracking-wide text-slate-500">
                      <th className="px-3 py-3">Producto</th>
                      <th className="hidden px-3 py-3 md:table-cell">Precio</th>
                      <th className="hidden px-3 py-3 text-center md:table-cell">IVA</th>
                      <th className="px-3 py-3 text-center">Cant.</th>
                      <th className="px-3 py-3 text-right">Precio unit.</th>
                      <th className="px-3 py-3 text-right">Stock</th>
                      <th className="px-3 py-3 text-right">Subtotal</th>
                      <th className="w-10 px-2 py-3"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {items.map((item, idx) => {
                      const prod = productos.find((p) => p.id === item.producto_id);
                      const controla = prod ? prod.controla_stock !== false : true;
                      const stock = prod?.stock_actual ?? 0;
                      const stockBajo = controla && item.cantidad > stock;
                      return (
                        <tr key={idx} className="align-middle transition-colors hover:bg-[#4FAEB2]/5">
                          {/* Producto + SKU */}
                          <td className="px-3 py-2.5">
                            <div className="flex items-center gap-3">
                              <ProductoThumb url={prod?.imagen_url} alt={item.producto_nombre} />
                              <div className="min-w-0">
                                <p className="font-semibold text-slate-900 leading-snug">{item.producto_nombre}</p>
                                <p className="font-mono text-[11px] text-slate-500">{item.sku}</p>
                              </div>
                            </div>
                          </td>
                          {/* Nivel de precio */}
                          <td className="hidden px-3 py-2.5 md:table-cell">
                            <div className="inline-flex overflow-hidden rounded-lg border border-slate-200">
                              {(["minorista", "mayorista", "distribuidor"] as const).map((tp) => {
                                const sel = (item.tipo_precio ?? "minorista") === tp;
                                return (
                                  <button key={tp} type="button" onClick={() => changeTipoPrecioItem(idx, tp)}
                                    className={`px-2 py-1.5 text-[11px] font-semibold transition-colors ${sel ? "bg-[#4FAEB2] text-white" : "bg-white text-slate-600 hover:bg-slate-100"}`}>
                                    {tp === "minorista" ? "Min" : tp === "mayorista" ? "May" : "Dist"}
                                  </button>
                                );
                              })}
                            </div>
                          </td>
                          {/* IVA */}
                          <td className="hidden px-3 py-2.5 md:table-cell">
                            <div className="inline-flex overflow-hidden rounded-lg border border-slate-200">
                              {(["EXENTA", "5%", "10%"] as const).map((iva) => {
                                const sel = item.tipo_iva === iva;
                                return (
                                  <button key={iva} type="button" onClick={() => updateItemCampo(idx, { tipo_iva: iva })}
                                    className={`px-2 py-1.5 text-[11px] font-semibold transition-colors ${sel ? "bg-[#4FAEB2] text-white" : "bg-white text-slate-600 hover:bg-slate-100"}`}>
                                    {iva === "EXENTA" ? "Ex" : iva}
                                  </button>
                                );
                              })}
                            </div>
                          </td>
                          {/* Cantidad con steppers */}
                          <td className="px-3 py-2.5">
                            <div className="mx-auto flex w-fit items-center rounded-md border border-slate-200 bg-white">
                              <button type="button" onClick={() => changeCantidadItem(idx, -1)} className="h-8 w-8 rounded-l-md text-slate-500 hover:bg-slate-100"><Minus className="mx-auto h-3.5 w-3.5" /></button>
                              <input
                                type="number" min={1} value={item.cantidad}
                                onChange={(e) => updateItemCampo(idx, { cantidad: Math.max(1, parseInt(e.target.value) || 1) })}
                                className="h-8 w-12 text-center text-sm tabular-nums outline-none"
                                aria-label={`Cantidad de ${item.producto_nombre}`}
                              />
                              <button type="button" onClick={() => changeCantidadItem(idx, 1)} className="h-8 w-8 rounded-r-md text-slate-500 hover:bg-slate-100"><Plus className="mx-auto h-3.5 w-3.5" /></button>
                            </div>
                          </td>
                          {/* Precio unitario editable */}
                          <td className="px-3 py-2.5 text-right">
                            <input
                              type="number" min={0} value={item.precio_venta}
                              onChange={(e) => updateItemCampo(idx, { precio_venta: Math.max(0, Number(e.target.value) || 0) })}
                              className="h-8 w-28 rounded-md border border-slate-200 bg-white px-2 text-right text-sm tabular-nums"
                              aria-label={`Precio unitario de ${item.producto_nombre}`}
                            />
                          </td>
                          {/* Stock */}
                          <td className="px-3 py-2.5 text-right">
                            <span className={`text-xs font-semibold tabular-nums ${!controla ? "text-slate-400" : stockBajo ? "text-red-600" : "text-slate-600"}`}>
                              {!controla ? "—" : stock}
                            </span>
                          </td>
                          {/* Total de línea */}
                          <td className="px-3 py-2.5 text-right">
                            <span className="text-sm font-bold tabular-nums text-slate-900">{formatGs(item.total_linea)}</span>
                          </td>
                          {/* Quitar */}
                          <td className="px-2 py-2.5 text-center">
                            <button
                              type="button"
                              onClick={() => handleEliminarLinea(idx)}
                              className="rounded p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600"
                              title="Quitar producto"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Totales + Cobro (vuelto) */}
              <div className="mt-5 flex justify-end">
                <div className="w-full space-y-3 lg:w-80">
                  <div className="space-y-1.5">
                    <div className="flex justify-between text-sm text-gray-600">
                      <span>Subtotal</span>
                      <span className="tabular-nums font-medium">{formatGs(totalSubtotal)}</span>
                    </div>
                    <div className="flex justify-between text-sm text-gray-600">
                      <span>IVA</span>
                      <span className="tabular-nums font-medium">
                        {totalIva > 0 ? formatGs(totalIva) : "—"}
                      </span>
                    </div>
                    <div className="flex justify-between text-base font-bold text-gray-900 pt-2 border-t border-gray-200">
                      <span>TOTAL</span>
                      <span className="tabular-nums">{formatGs(totalGeneral)}</span>
                    </div>
                  </div>

                  {tipoVenta === "CONTADO" && (
                    <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-2.5">
                      <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">Cobro</p>
                      <div className="grid grid-cols-3 gap-1.5">
                        {([
                          { v: "efectivo", label: "Efectivo" },
                          { v: "transferencia", label: "Transferencia" },
                          { v: "tarjeta", label: "Tarjeta/Débito" },
                        ] as { v: MetodoPago; label: string }[]).map((m) => (
                          <button
                            key={m.v}
                            type="button"
                            onClick={() => handleSelectMetodo(m.v)}
                            className={`text-xs py-2 rounded-md border transition-colors ${
                              metodoPago === m.v
                                ? "border-[#0EA5E9] bg-[#0EA5E9]/10 text-[#0EA5E9] font-medium"
                                : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                            }`}
                          >
                            {m.label}
                          </button>
                        ))}
                      </div>

                      {/* Efectivo: monto recibido + vuelto, sin datos extra */}
                      {metodoPago === "efectivo" && (
                        <div className="space-y-1.5">
                          <MontoInput
                            value={montoRecibido}
                            onChange={(n) => setMontoRecibido(String(n))}
                            placeholder="Monto recibido (Gs.) — opcional"
                            className={inputClass}
                            decimals={false}
                          />
                          {montoRecibidoNum > 0 && (
                            <div className="flex justify-between text-sm">
                              <span className="text-gray-600">{vuelto >= 0 ? "Vuelto" : "Falta"}</span>
                              <span className={`font-bold tabular-nums ${vuelto >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                                {formatGs(Math.abs(vuelto))}
                              </span>
                            </div>
                          )}
                        </div>
                      )}

                      {/* Transferencia / Tarjeta: resumen compacto + editar */}
                      {(metodoPago === "transferencia" || metodoPago === "tarjeta") && (
                        <div className="rounded-md border border-slate-200 bg-white px-3 py-2 text-xs space-y-1">
                          <div className="flex items-center justify-between">
                            <span className="font-medium text-slate-700">
                              {metodoPago === "transferencia" ? "Transferencia" : "Tarjeta / Débito"}
                            </span>
                            <button type="button" onClick={() => { setEntidadQuery(""); setCobroModalOpen(true); }} className="text-sky-600 font-medium hover:underline">
                              Editar
                            </button>
                          </div>
                          <p className="text-slate-500">
                            Entidad: <span className="text-slate-700">{entidadSel ? `${entidadSel.codigo ? entidadSel.codigo + " · " : ""}${entidadSel.nombre}` : "— sin especificar —"}</span>
                          </p>
                          {pagoReferencia.trim() && <p className="text-slate-500">Comprobante: <span className="text-slate-700">{pagoReferencia}</span></p>}
                          {metodoPago === "transferencia" && pagoTitular.trim() && (
                            <p className="text-slate-500">Titular: <span className="text-slate-700">{pagoTitular}</span></p>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </>
          )}

          {/* Error confirmar */}
          {errorVenta && (
            <div className="mt-4 flex items-start gap-2 bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-xs text-red-700">
              <span className="text-base leading-none mt-0.5">⚠</span>
              <span className="font-medium">{errorVenta}</span>
            </div>
          )}

          {/* Acciones — stack vertical full-width en mobile (mas facil de tappear),
              fila en sm+. Confirmar en orden visual primero (primary). */}
          <div className="mt-6 flex flex-col-reverse sm:flex-row gap-3">
            <button
              type="button"
              onClick={() => router.push("/ventas")}
              className="border border-slate-200 px-6 py-3 rounded-lg text-sm hover:bg-slate-50 transition-colors min-h-[48px] w-full sm:w-auto"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={!ventaValida || guardando}
              aria-busy={guardando}
              className="bg-[#0EA5E9] hover:bg-[#0284C7] text-white px-6 py-3 rounded-lg text-sm font-medium transition-colors shadow-sm disabled:opacity-40 disabled:cursor-not-allowed active:scale-95 min-h-[48px] w-full sm:w-auto"
            >
              {guardando ? "Guardando…" : "Confirmar venta"}
            </button>
          </div>

        </div>

      </form>

      <ProductPickerModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onAgregar={handleAgregarDesdePicker}
        excludeIds={items.map((i) => i.producto_id)}
        moneda={moneda}
        tipoCambio={tipoCambioNum}
        ivaDefault="10%"
        tipoPrecioDefault={clienteSel?.nivel_precio ?? "minorista"}
      />

      {/* Modal de cobro (transferencia / tarjeta-débito) */}
      {cobroModalOpen && (metodoPago === "transferencia" || metodoPago === "tarjeta") && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setCobroModalOpen(false)}>
          <div className="w-full max-w-sm rounded-xl bg-white p-5 shadow-xl space-y-3" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-800">
                {metodoPago === "transferencia" ? "Datos de transferencia" : "Datos de tarjeta / débito"}
              </h3>
              <button type="button" onClick={() => setCobroModalOpen(false)} className="text-slate-400 hover:text-slate-700 text-lg leading-none">✕</button>
            </div>

            <div>
              <label className="block text-xs text-gray-600 mb-1">
                {metodoPago === "tarjeta" ? "Entidad / banco / POS" : "Entidad / banco"}
              </label>
              <input
                type="text"
                value={entidadQuery}
                onChange={(e) => setEntidadQuery(e.target.value)}
                placeholder="Buscar por código o nombre…"
                className={inputClass}
                autoFocus
              />
              <div className="mt-1 max-h-40 overflow-auto rounded-lg border border-slate-100">
                {entidadesFiltradas.length === 0 ? (
                  <p className="px-3 py-2 text-xs text-gray-400">Sin entidades. Cargalas en Configuración → Entidades bancarias.</p>
                ) : (
                  entidadesFiltradas.map((en) => (
                    <button
                      key={en.id}
                      type="button"
                      onClick={() => { setPagoEntidadId(en.id); setEntidadQuery(""); }}
                      className={`block w-full text-left px-3 py-1.5 text-sm hover:bg-slate-50 ${pagoEntidadId === en.id ? "bg-sky-50" : ""}`}
                    >
                      {en.codigo && <span className="font-mono text-xs text-slate-400 mr-2">{en.codigo}</span>}
                      {en.nombre}
                    </button>
                  ))
                )}
              </div>
              {entidadSel && <p className="mt-1 text-[11px] text-emerald-600">Seleccionada: {entidadSel.nombre}</p>}
            </div>

            {metodoPago === "transferencia" && (
              <div>
                <label className="block text-xs text-gray-600 mb-1">Titular que transfirió</label>
                <input type="text" value={pagoTitular} onChange={(e) => setPagoTitular(e.target.value)} placeholder="Nombre del titular" className={inputClass} />
              </div>
            )}

            <div>
              <label className="block text-xs text-gray-600 mb-1">N° de comprobante / referencia</label>
              <input type="text" value={pagoReferencia} onChange={(e) => setPagoReferencia(e.target.value)} placeholder="Comprobante / transacción" className={inputClass} />
            </div>

            <button type="button" onClick={() => setCobroModalOpen(false)} className="w-full rounded-lg bg-[#0EA5E9] py-2 text-sm font-medium text-white hover:bg-[#0284C7]">
              Listo
            </button>
          </div>
        </div>
      )}

      {/* Modal de confirmación: venta sin stock suficiente */}
      {confirmSinStockOpen && faltantes.length > 0 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setConfirmSinStockOpen(false)}>
          <div className="w-full max-w-lg rounded-xl bg-white p-5 shadow-xl space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start gap-2">
              <span className="text-amber-500 text-xl leading-none">⚠</span>
              <div>
                <h3 className="text-sm font-semibold text-slate-800">Hay productos/insumos sin stock suficiente</h3>
                <p className="text-xs text-slate-500 mt-0.5">Revisá el detalle. Podés vender igual: el stock quedará negativo y se registrará el movimiento de salida.</p>
              </div>
            </div>

            <div className="overflow-x-auto rounded-lg border border-slate-200">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="bg-slate-50 text-slate-600 text-xs">
                    <th className="py-2 px-3 font-medium">Producto / Insumo</th>
                    <th className="py-2 px-3 font-medium text-right">Stock actual</th>
                    <th className="py-2 px-3 font-medium text-right">Solicitado</th>
                    <th className="py-2 px-3 font-medium text-right">Faltante</th>
                  </tr>
                </thead>
                <tbody>
                  {faltantes.map((f) => (
                    <tr key={f.producto_id} className="border-t border-slate-100">
                      <td className="py-2 px-3">
                        <span className="font-medium text-slate-800">{f.nombre}</span>
                        <span className={`ml-2 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${f.tipo === "insumo" ? "bg-amber-100 text-amber-700" : "bg-slate-100 text-slate-600"}`}>
                          {f.tipo === "insumo" ? "Insumo" : "Producto"}
                        </span>
                      </td>
                      <td className="py-2 px-3 text-right tabular-nums">{f.stock_actual}</td>
                      <td className="py-2 px-3 text-right tabular-nums">{f.solicitado}</td>
                      <td className="py-2 px-3 text-right tabular-nums font-semibold text-red-600">{f.faltante}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex flex-col-reverse sm:flex-row gap-2 sm:justify-end">
              <button type="button" onClick={() => setConfirmSinStockOpen(false)} className="rounded-lg border border-slate-200 px-4 py-2 text-sm hover:bg-slate-50">
                Cancelar
              </button>
              <button type="button" disabled={guardando} aria-busy={guardando} onClick={() => void confirmarVentaSinStock()} className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-medium text-white hover:bg-amber-600 disabled:opacity-50 disabled:cursor-not-allowed">
                {guardando ? "Guardando…" : "Confirmar venta de todos modos"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal chico para crear un cliente sin salir del flujo de la venta. */}
      {modalNuevoCliente && (
        <NuevoClienteRapidoModal
          nombreInicial={clienteQuery.trim() || undefined}
          onClose={() => setModalNuevoCliente(false)}
          onCreado={(c: NuevoClienteCreado) => {
            // Insertamos el nuevo cliente en la lista local y lo seleccionamos.
            setClientes((prev) => [
              ...prev,
              {
                id: c.id,
                label: c.nombre,
                ruc: c.ruc,
                usa_nota_remision: false,
                nivel_precio: "minorista",
              },
            ]);
            setClienteId(c.id);
            setClienteQuery("");
            setModalNuevoCliente(false);
            // Refresco pasivo para pescar campos derivados (empresa, nombre_facturacion, etc.).
            void fetchClientes();
          }}
        />
      )}
    </div>
  );
}
