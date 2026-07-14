"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Bell, FileClock, FileWarning } from "lucide-react";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";

interface Notif {
  id: string;
  tipo: string;
  titulo: string;
  mensaje: string;
  documento_id: string | null;
  url: string | null;
  leida: boolean;
  created_at: string;
}

const POLL_MS = 60_000;

/** Ícono por tipo: vencido pesa más que por vencer. */
function IconoNotif({ tipo }: { tipo: string }) {
  const Icon = tipo === "documento_vencido" ? FileWarning : FileClock;
  return <Icon className="h-4 w-4" />;
}

export default function NotificacionesBell() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Notif[]>([]);
  const [noLeidas, setNoLeidas] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  const cargar = useCallback(async () => {
    try {
      const res = await fetchWithSupabaseSession("/api/notificaciones", { cache: "no-store" });
      if (!res.ok) return;
      const j = await res.json();
      const data = j?.data as { notificaciones?: Notif[]; no_leidas?: number } | undefined;
      setItems(data?.notificaciones ?? []);
      setNoLeidas(data?.no_leidas ?? 0);
    } catch {
      /* silencioso: la campanita no debe romper la UI */
    }
  }, []);

  useEffect(() => {
    void cargar();
    const t = setInterval(() => void cargar(), POLL_MS);
    return () => clearInterval(t);
  }, [cargar]);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  async function abrirNotif(n: Notif) {
    // Optimista: marcar leída localmente.
    setItems((prev) => prev.map((x) => (x.id === n.id ? { ...x, leida: true } : x)));
    setNoLeidas((c) => (n.leida ? c : Math.max(0, c - 1)));
    setOpen(false);
    try {
      await fetchWithSupabaseSession(`/api/notificaciones/${n.id}/leer`, { method: "POST" });
    } catch { /* noop */ }
    if (n.url) router.push(n.url);
  }

  async function marcarTodas() {
    setItems((prev) => prev.map((x) => ({ ...x, leida: true })));
    setNoLeidas(0);
    try {
      await fetchWithSupabaseSession("/api/notificaciones/leer-todas", { method: "POST" });
    } catch { /* noop */ }
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="relative rounded-lg p-2 text-slate-500 transition-colors hover:bg-slate-50 hover:text-[#3F8E91]"
        aria-label="Notificaciones"
      >
        <Bell className="h-5 w-5" />
        {noLeidas > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
            {noLeidas > 9 ? "9+" : noLeidas}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-80 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl ring-1 ring-[#4FAEB2]/15">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
            <p className="text-sm font-semibold text-slate-900">Notificaciones</p>
            {items.some((x) => !x.leida) && (
              <button onClick={marcarTodas} className="text-xs font-medium text-[#3F8E91] hover:underline">
                Marcar todas
              </button>
            )}
          </div>
          <div className="max-h-[60vh] overflow-y-auto">
            {items.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-slate-400">
                <Bell className="mx-auto mb-2 h-6 w-6 text-slate-300" />
                Sin notificaciones
              </div>
            ) : (
              <ul className="divide-y divide-slate-100">
                {items.map((n) => (
                  <li key={n.id}>
                    <button
                      type="button"
                      onClick={() => abrirNotif(n)}
                      className={`flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-slate-50 ${n.leida ? "" : "bg-[#4FAEB2]/5"}`}
                    >
                      <span
                        className={`mt-0.5 shrink-0 rounded-lg p-1.5 ${
                          n.leida
                            ? "bg-slate-100 text-slate-400"
                            : n.tipo === "documento_vencido"
                              ? "bg-red-50 text-red-600"
                              : "bg-amber-50 text-amber-600"
                        }`}
                      >
                        <IconoNotif tipo={n.tipo} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="truncate text-xs font-bold text-slate-800">{n.titulo}</span>
                          {!n.leida && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-500" />}
                        </span>
                        <span className="mt-0.5 block text-xs leading-snug text-slate-500">{n.mensaje}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
