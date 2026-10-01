"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import PresupuestoForm, {
  type PresupuestoFormInicial,
} from "@/app/presupuestos/components/PresupuestoForm";
import type { IvaTipoPresupuesto } from "@/lib/presupuestos/types";

function asIva(v: unknown): IvaTipoPresupuesto {
  return v === "EXENTA" || v === "5%" ? v : "10%";
}

/** `fecha_entrega` puede venir como date o timestamp; el input date necesita YYYY-MM-DD. */
function soloFecha(v: unknown): string {
  const s = typeof v === "string" ? v.trim() : "";
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : "";
}

export default function EditarPresupuestoPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [inicial, setInicial] = useState<PresupuestoFormInicial | null>(null);
  const [numeroControl, setNumeroControl] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithSupabaseSession(`/api/presupuestos/${id}`, { cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body?.success === false) {
        setError(body?.error ?? "No se pudo cargar el presupuesto.");
        return;
      }
      const p = body.data.presupuesto as Record<string, unknown>;
      const items = (body.data.items ?? []) as Record<string, unknown>[];

      // Un presupuesto convertido ya se reflejó en un pedido o una venta:
      // editarlo dejaría esos documentos mintiendo. El server lo rechaza igual.
      if (p.estado === "convertido" || p.convertido_pedido_id || p.convertido_venta_id) {
        setError("Este presupuesto ya fue convertido; no se puede editar.");
        return;
      }

      setNumeroControl(String(p.numero_control ?? ""));
      setInicial({
        cliente_id: p.cliente_id ? String(p.cliente_id) : null,
        moneda: String(p.moneda ?? "PYG"),
        cliente_nombre: String(p.cliente_nombre ?? ""),
        cliente_ruc: p.cliente_ruc ? String(p.cliente_ruc) : null,
        cliente_telefono: p.cliente_telefono ? String(p.cliente_telefono) : null,
        cliente_direccion: p.cliente_direccion ? String(p.cliente_direccion) : null,
        validez_dias: p.validez_dias != null ? Number(p.validez_dias) : null,
        forma_pago: p.forma_pago ? String(p.forma_pago) : null,
        plazo_entrega: p.plazo_entrega ? String(p.plazo_entrega) : null,
        fecha_entrega: soloFecha(p.fecha_entrega) || null,
        observaciones: p.observaciones ? String(p.observaciones) : null,
        items: items.map((it) => ({
          producto_id: it.producto_id ? String(it.producto_id) : null,
          producto_nombre: String(it.producto_nombre ?? ""),
          sku: it.sku ? String(it.sku) : null,
          cantidad: Number(it.cantidad) || 0,
          unidad_medida: it.unidad_medida ? String(it.unidad_medida) : null,
          precio_unitario: Number(it.precio_unitario) || 0,
          iva_tipo: asIva(it.iva_tipo),
          descuento: Number(it.descuento) || 0,
        })),
      });
    } catch {
      setError("Error de red al cargar el presupuesto.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  if (loading) {
    return (
      <div className="p-6 flex items-center gap-2 text-sm text-gray-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Cargando…
      </div>
    );
  }

  if (error || !inicial) {
    return (
      <div className="p-6 space-y-3">
        <div className="rounded-md bg-red-50 border border-red-200 p-3 text-sm text-red-700">
          {error ?? "Presupuesto no encontrado"}
        </div>
        <Link href={`/presupuestos/${id}`} className="text-sm text-[#4FAEB2] hover:underline">
          Volver al presupuesto
        </Link>
      </div>
    );
  }

  return (
    <PresupuestoForm
      modo="editar"
      presupuestoId={id}
      numeroControl={numeroControl}
      inicial={inicial}
    />
  );
}
