/**
 * Membrete (encabezado) común para todos los documentos imprimibles del ERP.
 * Devuelve HTML con estilos inline para no depender del CSS de cada endpoint
 * (evita duplicar el markup del encabezado en cada documento).
 *
 * SOLO presentación: no toca datos de negocio.
 *
 * PENDIENTE DE ALTA COMERCIAL: los datos de la empresa (actividad económica,
 * teléfono, dirección, logo) todavía no fueron provistos por el cliente. Se
 * dejan configurables por entorno y vacíos por defecto; el membrete omite las
 * líneas sin valor en vez de mostrar datos de otra empresa.
 */

function envList(name: string): string[] {
  return (process.env[name] ?? "")
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);
}

export const EMPRESA_DOC = {
  nombre: process.env.NEURA_CLIENT_NAME?.trim() || "Seguridad Alimentaria",
  actividad: envList("NEURA_EMPRESA_ACTIVIDAD"),
  telefono: process.env.NEURA_EMPRESA_TELEFONO?.trim() || "",
  direccion: envList("NEURA_EMPRESA_DIRECCION"),
  /** Logo del cliente (alta calidad, sin fondo). Servido desde /public. Vacío = sin logo. */
  logoUrl: process.env.NEURA_EMPRESA_LOGO_URL?.trim() || "",
};

function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Membrete A4: logo a la izquierda, datos comerciales a la derecha, línea divisoria.
 * `origin` opcional para URL absoluta del logo (útil al imprimir/guardar PDF).
 */
export function membreteA4(origin = ""): string {
  const e = EMPRESA_DOC;
  const logo = e.logoUrl ? (origin ? `${origin}${e.logoUrl}` : e.logoUrl) : "";
  return `
  <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:18px;border-bottom:2px solid #2E7D32;padding-bottom:12px;margin-bottom:16px;">
    ${
      logo
        ? `<div style="flex:0 0 auto;">
      <img src="${esc(logo)}" alt="${esc(e.nombre)}" style="max-width:180px;max-height:92px;width:auto;height:auto;object-fit:contain;display:block;" />
    </div>`
        : ""
    }
    <div style="flex:1;min-width:0;text-align:right;font-size:11px;color:#374151;line-height:1.55;">
      <div style="font-size:14px;font-weight:800;color:#1f2937;">${esc(e.nombre)}</div>
      ${e.actividad.map((a) => `<div style="color:#6b7280;">${esc(a)}</div>`).join("")}
      ${e.telefono ? `<div style="margin-top:4px;"><strong>Tel:</strong> ${esc(e.telefono)}</div>` : ""}
      ${e.direccion.length ? `<div>${e.direccion.map(esc).join(" · ")}</div>` : ""}
    </div>
  </div>`;
}

/**
 * Membrete compacto para ticket angosto (58/80mm): logo arriba, datos centrados.
 */
export function membreteTicket(origin = ""): string {
  const e = EMPRESA_DOC;
  const logo = e.logoUrl ? (origin ? `${origin}${e.logoUrl}` : e.logoUrl) : "";
  return `
  <div style="text-align:center;padding-bottom:6px;margin-bottom:6px;border-bottom:1px dashed #000;">
    ${
      logo
        ? `<img src="${esc(logo)}" alt="${esc(e.nombre)}" style="max-width:150px;max-height:72px;width:auto;height:auto;object-fit:contain;display:inline-block;margin:0 auto 4px;" />`
        : ""
    }
    <div style="font-weight:700;font-size:12px;">${esc(e.nombre)}</div>
    ${e.telefono ? `<div style="font-size:10px;">Tel: ${esc(e.telefono)}</div>` : ""}
    ${e.direccion.map((d) => `<div style="font-size:10px;">${esc(d)}</div>`).join("")}
  </div>`;
}
