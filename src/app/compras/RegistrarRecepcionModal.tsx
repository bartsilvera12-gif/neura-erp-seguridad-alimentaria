"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X, PackageCheck, AlertTriangle, History } from "lucide-react";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";

interface LineaOrden {
  compra_id: string;
  producto_id: string;
  producto_nombre: string;
  cantidad: number;
  cantidad_recibida: number;
  pendiente: number;
  estado_recepcion: string;
  costo_unitario: number;
  fecha_estimada_llegada: string | null;
}

interface RecepcionPrevia {
  id: string;
  fecha_recepcion: string;
  observaciones: string | null;
  proxima_entrega_estimada: string | null;
  usuario_nombre: string | null;
  items: Array<{ producto_nombre: string | null; cantidad_recibida: number }>;
}

const inputClass =
  "w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none transition-shadow duration-150 focus:border-[#4FAEB2] focus:ring-2 focus:ring-[#4FAEB2]/20";
const btnPrimario =
  "inline-flex items-center gap-2 rounded-lg bg-[#4FAEB2] px-4 py-2 text-sm font-semibold text-white shadow-sm transition-[transform,background-color] duration-150 ease-out hover:bg-[#3F8E91] active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50";
const btnSecundario =
  "inline-flex items-center gap-2 rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 transition-[transform,background-color] duration-150 ease-out hover:bg-slate-50 active:scale-[0.97]";

function formatGs(v: number) {
  return `Gs. ${Math.round(v).toLocaleString("es-PY")}`;
}

/**
 * Registrar recepción de una orden de compra.
 *
 * Muestra por producto: pedido / recibido antes / pendiente, y deja cargar lo
 * que llega en esta entrega. El stock se mueve SOLO por lo recibido.
 *
 * La clave de idempotencia se genera una vez al abrir: si el usuario hace doble
 * clic o se corta la red y reintenta, el backend detecta la repetición y no
 * duplica el stock.
 */
export default function RegistrarRecepcionModal({
  numeroControl,
  open,
  onClose,
  onRecepcionRegistrada,
}: {
  numeroControl: string;
  open: boolean;
  onClose: () => void;
  onRecepcionRegistrada?: () => void;
}) {
  const [lineas, setLineas] = useState<LineaOrden[]>([]);
  const [previas, setPrevias] = useState<RecepcionPrevia[]>([]);
  const [cargando, setCargando] = useState(true);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verHistorial, setVerHistorial] = useState(false);

  const [cantidades, setCantidades] = useState<Record<string, string>>({});
  const [observaciones, setObservaciones] = useState("");
  const [proximaEntrega, setProximaEntrega] = useState("");

  // Idempotencia: una clave por apertura del modal.
  const idempotencyKey = useRef<string>("");
  const enviandoRef = useRef(false);

  const cargar = useCallback(async () => {
    setCargando(true);
    try {
      const res = await fetchWithSupabaseSession(
        `/api/compras/${encodeURIComponent(numeroControl)}/recepciones`,
        { cache: "no-store" }
      );
      const j = await res.json();
      if (!res.ok || !j?.success) throw new Error(j?.error ?? "No se pudo cargar la orden.");
      setLineas((j.data?.lineas ?? []) as LineaOrden[]);
      setPrevias((j.data?.recepciones ?? []) as RecepcionPrevia[]);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al cargar");
    } finally {
      setCargando(false);
    }
  }, [numeroControl]);

  useEffect(() => {
    if (!open) return;
    idempotencyKey.current = `rec-${numeroControl}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setCantidades({});
    setObservaciones("");
    setProximaEntrega("");
    setVerHistorial(false);
    void cargar();
  }, [open, numeroControl, cargar]);

  const pendientes = useMemo(() => lineas.filter((l) => l.pendiente > 0), [lineas]);

  const totalARecibir = useMemo(
    () =>
      pendientes.reduce((s, l) => {
        const n = Number(cantidades[l.compra_id] ?? 0);
        return s + (Number.isFinite(n) && n > 0 ? n : 0);
      }, 0),
    [pendientes, cantidades]
  );

  /** ¿Queda saldo después de esta entrega? Entonces conviene pedir fecha estimada. */
  const quedaSaldo = useMemo(
    () =>
      pendientes.some((l) => {
        const n = Number(cantidades[l.compra_id] ?? 0);
        return l.pendiente - (Number.isFinite(n) ? n : 0) > 0;
      }),
    [pendientes, cantidades]
  );

  function setCantidad(compraId: string, valor: string, max: number) {
    const n = Number(valor);
    if (valor !== "" && (!Number.isFinite(n) || n < 0)) return;
    if (n > max) {
      setCantidades((p) => ({ ...p, [compraId]: String(max) }));
      return;
    }
    setCantidades((p) => ({ ...p, [compraId]: valor }));
  }

  function recibirTodo() {
    const next: Record<string, string> = {};
    for (const l of pendientes) next[l.compra_id] = String(l.pendiente);
    setCantidades(next);
  }

  async function handleGuardar(e: React.FormEvent) {
    e.preventDefault();
    if (enviandoRef.current) return;          // guard síncrono anti doble clic
    if (totalARecibir <= 0) {
      setError("Cargá al menos una cantidad recibida.");
      return;
    }
    enviandoRef.current = true;
    setGuardando(true);
    setError(null);
    try {
      const items = pendientes
        .map((l) => ({ compra_id: l.compra_id, cantidad_recibida: Number(cantidades[l.compra_id] ?? 0) }))
        .filter((i) => i.cantidad_recibida > 0);

      const res = await fetchWithSupabaseSession(
        `/api/compras/${encodeURIComponent(numeroControl)}/recepciones`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            items,
            observaciones,
            proxima_entrega_estimada: quedaSaldo ? proximaEntrega || null : null,
            idempotency_key: idempotencyKey.current,
          }),
        }
      );
      const j = await res.json();
      if (!res.ok || !j?.success) throw new Error(j?.error ?? "No se pudo registrar la recepción.");

      onRecepcionRegistrada?.();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al registrar");
    } finally {
      enviandoRef.current = false;
      setGuardando(false);
    }
  }

  if (!open) return null;

  return (
    <div className="zentra-overlay-in fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4 py-10 backdrop-blur-[2px]">
      <form
        onSubmit={handleGuardar}
        className="zentra-modal-in w-full max-w-3xl rounded-xl border border-slate-200 bg-white p-5 shadow-2xl"
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#4FAEB2]/12 text-[#3F8E91]">
              <PackageCheck className="h-5 w-5" />
            </span>
            <div>
              <p className="text-sm font-semibold text-slate-900">Registrar recepción</p>
              <p className="text-xs text-slate-500">
                Orden <span className="font-mono">{numeroControl}</span> · el stock sube solo por lo que recibas
              </p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600">
            <X className="h-4 w-4" />
          </button>
        </div>

        {error && (
          <div className="mb-3 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {cargando ? (
          <div className="space-y-2 py-6">
            {[0, 1].map((i) => (
              <div key={i} className="h-12 animate-pulse rounded-lg bg-slate-100" />
            ))}
          </div>
        ) : pendientes.length === 0 ? (
          <div className="rounded-xl bg-emerald-50 px-4 py-8 text-center text-sm text-emerald-700">
            Esta orden ya fue recibida por completo.
          </div>
        ) : (
          <>
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                Productos pendientes
              </p>
              <button type="button" onClick={recibirTodo} className="text-xs font-medium text-[#3F8E91] hover:underline">
                Recibir todo lo pendiente
              </button>
            </div>

            <div className="overflow-x-auto rounded-xl border border-slate-200">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-[11px] font-bold uppercase tracking-wide text-slate-500">
                    <th className="px-3 py-2.5 text-left">Producto</th>
                    <th className="px-3 py-2.5 text-right">Pedido</th>
                    <th className="px-3 py-2.5 text-right">Recibido</th>
                    <th className="px-3 py-2.5 text-right">Pendiente</th>
                    <th className="px-3 py-2.5 text-right">Recibo ahora</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {pendientes.map((l) => (
                    <tr key={l.compra_id} className="transition-colors hover:bg-slate-50/70">
                      <td className="px-3 py-2.5">
                        <p className="font-medium text-slate-800">{l.producto_nombre}</p>
                        <p className="text-[11px] text-slate-400">{formatGs(l.costo_unitario)} c/u</p>
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-slate-600">{l.cantidad}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-slate-500">{l.cantidad_recibida}</td>
                      <td className="px-3 py-2.5 text-right">
                        <span className="font-semibold tabular-nums text-amber-600">{l.pendiente}</span>
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <input
                          type="number"
                          min={0}
                          max={l.pendiente}
                          step="any"
                          value={cantidades[l.compra_id] ?? ""}
                          onChange={(e) => setCantidad(l.compra_id, e.target.value, l.pendiente)}
                          placeholder="0"
                          className="h-9 w-24 rounded-md border border-slate-200 px-2 text-right text-sm tabular-nums outline-none focus:border-[#4FAEB2] focus:ring-2 focus:ring-[#4FAEB2]/20"
                          aria-label={`Cantidad recibida de ${l.producto_nombre}`}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <label className="mb-1.5 block text-sm font-medium text-slate-700" htmlFor="obs">
                  Observación de la entrega
                </label>
                <input
                  id="obs"
                  className={inputClass}
                  value={observaciones}
                  onChange={(e) => setObservaciones(e.target.value)}
                  placeholder="Ej: llegó incompleto, faltan 3 cajas"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium text-slate-700" htmlFor="prox">
                  Próxima entrega estimada
                </label>
                <input
                  id="prox"
                  type="date"
                  className={inputClass}
                  value={proximaEntrega}
                  onChange={(e) => setProximaEntrega(e.target.value)}
                  disabled={!quedaSaldo}
                />
                <p className="mt-1 text-xs text-slate-400">
                  {quedaSaldo
                    ? "Queda saldo: con esta fecha la campanita te avisa."
                    : "Se habilita si queda mercadería pendiente."}
                </p>
              </div>
            </div>
          </>
        )}

        {previas.length > 0 && (
          <div className="mt-4 border-t border-slate-100 pt-3">
            <button
              type="button"
              onClick={() => setVerHistorial((v) => !v)}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-[#3F8E91]"
            >
              <History className="h-3.5 w-3.5" />
              {verHistorial ? "Ocultar" : "Ver"} recepciones anteriores ({previas.length})
            </button>
            {verHistorial && (
              <ul className="mt-2 space-y-2">
                {previas.map((r) => (
                  <li key={r.id} className="rounded-lg border border-slate-200 bg-slate-50/60 px-3 py-2 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-slate-700">
                        {new Date(r.fecha_recepcion).toLocaleString("es-PY", { timeZone: "America/Asuncion" })}
                      </span>
                      <span className="text-slate-400">{r.usuario_nombre ?? "—"}</span>
                    </div>
                    <p className="mt-0.5 text-slate-500">
                      {r.items.map((i) => `${i.cantidad_recibida}× ${i.producto_nombre ?? ""}`).join(" · ")}
                    </p>
                    {r.observaciones && <p className="mt-0.5 italic text-slate-400">{r.observaciones}</p>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="mt-5 flex items-center justify-between gap-2">
          <span className="text-xs text-slate-500">
            {totalARecibir > 0 ? `Vas a recibir ${totalARecibir} unidad${totalARecibir === 1 ? "" : "es"}` : ""}
          </span>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className={btnSecundario}>Cancelar</button>
            <button type="submit" disabled={guardando || totalARecibir <= 0} className={btnPrimario}>
              <PackageCheck className="h-4 w-4" />
              {guardando ? "Registrando…" : "Registrar recepción"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
