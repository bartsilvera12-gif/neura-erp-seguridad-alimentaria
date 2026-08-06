import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { crearPresupuesto, parseItemsPresupuesto } from "@/lib/presupuestos/server/presupuestos-pg";

const PRESU_COLS =
  "id, cliente_id, cliente_nombre, cliente_ruc, cliente_telefono, cliente_direccion, " +
  "numero_control, estado, moneda, subtotal, monto_iva, descuento_total, total, validez_dias, " +
  "fecha, fecha_vencimiento, forma_pago, plazo_entrega, fecha_entrega, observaciones, " +
  "convertido_pedido_id, convertido_venta_id, created_at, updated_at";

/** GET /api/presupuestos — listado (opcional ?estado=). */
export async function GET(request: NextRequest) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    const estado = new URL(request.url).searchParams.get("estado");
    let q = ctx.supabase
      .from("presupuestos")
      .select(PRESU_COLS)
      .eq("empresa_id", ctx.auth.empresa_id)
      .order("fecha", { ascending: false })
      .limit(500);
    if (estado) q = q.eq("estado", estado);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return NextResponse.json(successResponse({ presupuestos: data ?? [] }));
  } catch (err) {
    console.error("[/api/presupuestos GET]", err instanceof Error ? err.message : err);
    return NextResponse.json(errorResponse("No se pudieron cargar los presupuestos."), { status: 500 });
  }
}

/** POST /api/presupuestos — crear. NO descuenta stock. */
export async function POST(request: NextRequest) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json(errorResponse("JSON inválido."), { status: 400 });
    }

    const items = parseItemsPresupuesto(body.items);
    if (!items) {
      return NextResponse.json(errorResponse("El presupuesto debe tener al menos un ítem válido."), { status: 400 });
    }
    const clienteNombre = String(body.cliente_nombre ?? "").trim();
    if (!clienteNombre) {
      return NextResponse.json(errorResponse("El nombre del cliente es obligatorio."), { status: 400 });
    }
    const validezRaw = body.validez_dias;
    const validez =
      validezRaw === null || validezRaw === undefined || String(validezRaw).trim() === ""
        ? null
        : Math.max(0, parseInt(String(validezRaw), 10) || 0) || null;

    const { id, numero_control } = await crearPresupuesto(ctx.supabase, ctx.auth.empresa_id, {
      cliente_id: body.cliente_id ? String(body.cliente_id) : null,
      cliente_nombre: clienteNombre,
      cliente_ruc: body.cliente_ruc ? String(body.cliente_ruc) : null,
      cliente_telefono: body.cliente_telefono ? String(body.cliente_telefono) : null,
      cliente_direccion: body.cliente_direccion ? String(body.cliente_direccion) : null,
      moneda: body.moneda === "USD" ? "USD" : "PYG",
      validez_dias: validez,
      forma_pago: body.forma_pago ? String(body.forma_pago) : null,
      plazo_entrega: body.plazo_entrega ? String(body.plazo_entrega) : null,
      fecha_entrega: (() => {
        const v = body.fecha_entrega;
        if (v == null) return null;
        const s = String(v).trim();
        return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
      })(),
      observaciones: body.observaciones ? String(body.observaciones).slice(0, 4000) : null,
      items,
    });

    return NextResponse.json(successResponse({ id, numero_control }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "No se pudo crear el presupuesto.";
    const status = /obligatorio|al menos un|inválid/i.test(msg) ? 400 : 500;
    console.error("[/api/presupuestos POST]", msg);
    return NextResponse.json(errorResponse(msg), { status });
  }
}
