export type TipoIvaVenta = "EXENTA" | "5%" | "10%";
export type TipoVenta   = "CONTADO" | "CREDITO";
export type MonedaVenta = "GS" | "USD";
export type MetodoPago  = "efectivo" | "tarjeta" | "transferencia";
export type EstadoVenta = "pendiente" | "completada" | "anulada";
/** Nivel de precio elegido para la línea de venta.
 *  'costo' se conserva SOLO como histórico (ventas viejas); ya no se ofrece en la UI. */
export type TipoPrecioVenta = "minorista" | "mayorista" | "distribuidor" | "costo";

/** Un ítem dentro de una venta (una línea de producto). */
export interface LineaVenta {
  producto_id:           string;
  producto_nombre:       string;
  sku:                   string;
  cantidad:              number;
  precio_venta_original: number;  // en la moneda elegida
  precio_venta:          number;  // siempre en GS
  tipo_iva:              TipoIvaVenta;
  /** Nivel de precio aplicado: minorista (precio_venta) | mayorista (precio_mayorista) | costo (costo_promedio). */
  tipo_precio?:          TipoPrecioVenta;
  subtotal:              number;  // precio_venta × cantidad
  monto_iva:             number;
  total_linea:           number;  // subtotal + monto_iva
  /**
   * Naturaleza de la salida:
   *  - `venta`   → cobrada, exige precio > 0.
   *  - `muestra` / `regalo` → precio 0, IVA 0, total 0, PERO descuenta stock
   *    igual que una venta y guarda el costo real para el reporte.
   */
  tipo_salida?:          TipoSalidaVenta;
  /** Motivo/observación breve. Obligatorio en muestra y regalo. */
  motivo_salida?:        string | null;
  /** Costo promedio del producto en PYG al momento de la venta (snapshot). */
  costo_unitario_snapshot_pyg?: number;
  costo_total_snapshot_pyg?:    number;
  /** subtotal − costo_total. Negativa en muestras/regalos. */
  ganancia_pyg?:         number;
}

/** Tipo de salida de una línea de venta. */
export type TipoSalidaVenta = "venta" | "muestra" | "regalo";

export const TIPOS_SALIDA_SIN_CARGO: readonly TipoSalidaVenta[] = ["muestra", "regalo"];

/** ¿La línea sale sin cobrar (muestra o regalo)? */
export function esSalidaSinCargo(t: TipoSalidaVenta | undefined | null): boolean {
  return t === "muestra" || t === "regalo";
}

/** Cabecera de venta: condiciones comerciales + totales consolidados. */
export interface Venta {
  /** UUID en base de datos (antes del bloque DB-first era numérico local). */
  id:             string;
  numero_control: string;   // VTA-000001, VTA-000002, …

  items: LineaVenta[];       // 1 o más productos

  moneda:      MonedaVenta;
  tipo_cambio: number;       // 1 si moneda === "GS"

  subtotal:  number;         // Σ subtotal de ítems
  monto_iva: number;         // Σ monto_iva de ítems
  total:     number;         // Σ total_linea de ítems

  tipo_venta: TipoVenta;
  plazo_dias?: number;       // solo si tipo_venta === "CREDITO"

  metodo_pago?: MetodoPago;  // En lo de Mari: efectivo/tarjeta/transferencia

  /** La venta emite nota de remisión (documento no fiscal). */
  genera_nota_remision?: boolean;
  /** Número de nota de remisión (NR-XXXXXX) si genera_nota_remision. */
  nota_remision_numero?: string | null;

  fecha: string;             // ISO string, generado automáticamente

  estado?: EstadoVenta;
  anulada_at?: string | null;
  anulacion_motivo?: string | null;

  /** Cliente asociado a la venta. null cuando la venta fue a consumidor final sin ficha. */
  cliente_id?: string | null;
  /** Nombre para mostrar en listados de Caja (prioriza nombre_facturacion → empresa
   *  → nombre_contacto → nombre). null cuando no hay cliente. */
  cliente_nombre?: string | null;
  /** Factura ERP asociada (puente venta→factura). null si la venta no emitió factura. */
  factura_id?: string | null;
  numero_factura?: string | null;
  /** Estado SIFEN de la factura electrónica: borrador | generado | firmado |
   *  enviado | en_proceso | aprobado | rechazado | error_envio | cancelado.
   *  El UI usa este dato para permitir anular la venta cuando el DE nunca
   *  llegó a SET (estados no-aceptados). null si no hay factura. */
  factura_estado_sifen?: string | null;
}
