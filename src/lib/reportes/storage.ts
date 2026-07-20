import type { EstadoCuentaReporte, ProveedoresReporte, ComprasReporte, VentasReporte, ConciliacionReporte, MuestrasReporte } from "./types";

async function getReporte<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, { credentials: "include", cache: "no-store" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j?.success) return null;
    return j.data as T;
  } catch (e) {
    console.error("[reportes] getReporte:", e);
    return null;
  }
}

const mq = (mes: string) => encodeURIComponent(mes);

export const getEstadoCuentaReporte = (mes: string) =>
  getReporte<EstadoCuentaReporte>(`/api/reportes/estado-cuenta?mes=${mq(mes)}`);
export const getProveedoresReporte = (mes: string) =>
  getReporte<ProveedoresReporte>(`/api/reportes/proveedores?mes=${mq(mes)}`);
export const getComprasReporte = (mes: string) =>
  getReporte<ComprasReporte>(`/api/reportes/compras?mes=${mq(mes)}`);
export const getVentasReporte = (mes: string) =>
  getReporte<VentasReporte>(`/api/reportes/ventas?mes=${mq(mes)}`);
export const getConciliacionReporte = (mes: string) =>
  getReporte<ConciliacionReporte>(`/api/reportes/conciliacion?mes=${mq(mes)}`);

/** Muestras y regalos: rango libre de fechas + filtros opcionales. */
export const getMuestrasReporte = (f: {
  desde: string;
  hasta: string;
  tipo?: string;
  producto?: string;
  cliente?: string;
  usuario?: string;
}) => {
  const qs = new URLSearchParams({ desde: f.desde, hasta: f.hasta });
  for (const k of ["tipo", "producto", "cliente", "usuario"] as const) {
    const v = f[k];
    if (v) qs.set(k, v);
  }
  return getReporte<MuestrasReporte>(`/api/reportes/muestras?${qs.toString()}`);
};
