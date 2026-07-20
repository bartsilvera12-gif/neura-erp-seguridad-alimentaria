import type { NextRequest } from "next/server";
import { getAuthWithRol, isAdmin } from "@/lib/middleware/auth";
import { resolveApiAuthContext } from "@/lib/middleware/api-auth-context";
import type { Prospecto } from "@/lib/crm/types";

/**
 * Alcance de visibilidad del CRM para el usuario que hace la request.
 *
 * - Administrador / supervisor: ve todos los prospectos de la empresa.
 * - Cualquier otro rol (comercial, usuario): ve SOLO los que tiene asignados
 *   por `responsable_usuario_id`.
 *
 * `verTodos: false` con `usuarioId: null` es el caso peligroso: no se pudo
 * resolver a qué usuario del catálogo corresponde la sesión. Ahí el filtro debe
 * devolver CERO prospectos, nunca todos — devolver todo "porque no sabemos
 * quién es" es exactamente el agujero que el pedido marca como inaceptable.
 */
export interface CrmScope {
  verTodos: boolean;
  usuarioId: string | null;
}

/** Roles que ven el pipeline completo. El resto queda acotado a lo propio. */
export async function resolveCrmScope(request: NextRequest): Promise<CrmScope | null> {
  const auth = await getAuthWithRol(request);
  if (!auth) return null;

  if (isAdmin(auth)) return { verTodos: true, usuarioId: null };
  // El supervisor supervisa: necesita ver el pipeline entero para repartirlo.
  if ((auth.rol ?? "").toLowerCase().includes("supervisor")) {
    return { verTodos: true, usuarioId: null };
  }

  const r = await resolveApiAuthContext(request);
  const usuarioId = r.ok ? r.ctx.usuarioCatalogId ?? null : null;
  return { verTodos: false, usuarioId };
}

/**
 * Filtra en memoria la lista ya traída de la base.
 *
 * El filtro va acá y no en el SQL porque las dos vías de lectura del CRM
 * (Postgres directo y PostgREST) comparten este paso; duplicar la condición en
 * cada query sería otra oportunidad de que una de las dos quede sin proteger.
 * La lista de una empresa es chica, así que el costo es irrelevante.
 */
export function aplicarScopeCrm<T extends Pick<Prospecto, "responsable_usuario_id">>(
  items: T[],
  scope: CrmScope
): T[] {
  if (scope.verTodos) return items;
  if (!scope.usuarioId) return [];
  return items.filter((p) => p.responsable_usuario_id === scope.usuarioId);
}

/** ¿Este usuario puede tocar (ver/editar/borrar) este prospecto puntual? */
export function puedeAccederProspecto(
  prospecto: Pick<Prospecto, "responsable_usuario_id">,
  scope: CrmScope
): boolean {
  if (scope.verTodos) return true;
  if (!scope.usuarioId) return false;
  return prospecto.responsable_usuario_id === scope.usuarioId;
}
