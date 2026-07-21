"use client";

import { useEffect, useRef, useState } from "react";
import type { Producto } from "@/lib/inventario/types";

/**
 * Selector multi-producto para el "producto/servicio de interés" de un lead.
 *
 * Reemplaza al viejo PlanSelector: este negocio vende productos de reventa, no
 * planes/suscripciones. Elegís de tu propio inventario; el valor estimado del
 * lead se sugiere sumando los precios, pero queda editable (un lead puede
 * negociar otro monto).
 */
type Props = {
  productos: Producto[];
  selectedIds: string[];
  onToggle: (productoId: string) => void;
  placeholder?: string;
  disabled?: boolean;
};

function norm(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
}

export default function ProductoInteresSelector({
  productos,
  selectedIds,
  onToggle,
  placeholder = "Buscar producto por nombre…",
  disabled = false,
}: Props) {
  const [busqueda, setBusqueda] = useState("");
  const [abierto, setAbierto] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const q = norm(busqueda.trim());
  const filtrados = q
    ? productos.filter((p) => norm(p.nombre).includes(q) || norm(p.sku ?? "").includes(q))
    : productos;

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setAbierto(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <div ref={containerRef} className="relative">
      {/* Chips de productos elegidos */}
      {selectedIds.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {selectedIds.map((id) => {
            const prod = productos.find((p) => p.id === id);
            if (!prod) return null;
            return (
              <span
                key={prod.id}
                className="inline-flex items-center gap-1.5 rounded-lg bg-[#4FAEB2]/10 px-2.5 py-1 text-sm font-medium text-[#3F8E91]"
              >
                {prod.nombre}
                <span className="text-xs text-gray-500">
                  {Number(prod.precio_venta).toLocaleString("es-PY")} ₲
                </span>
                {!disabled && (
                  <button
                    type="button"
                    onClick={() => onToggle(prod.id)}
                    className="ml-0.5 text-gray-400 hover:text-red-600"
                    aria-label="Quitar"
                  >
                    ×
                  </button>
                )}
              </span>
            );
          })}
        </div>
      )}

      {/* Buscador */}
      <div className="relative">
        <input
          type="text"
          value={busqueda}
          onChange={(e) => {
            setBusqueda(e.target.value);
            setAbierto(true);
          }}
          onFocus={() => setAbierto(true)}
          placeholder={placeholder}
          disabled={disabled}
          className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 pr-9 text-sm outline-none focus:outline-none focus:ring-2 focus:ring-[#4FAEB2] disabled:cursor-not-allowed disabled:bg-slate-50"
        />
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-gray-400">▼</span>
      </div>

      {/* Desplegable */}
      {abierto && (
        <div className="absolute z-10 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-lg">
          {filtrados.length === 0 ? (
            <div className="px-4 py-3 text-sm text-gray-500">
              {busqueda.trim() ? "Sin coincidencias" : "No hay productos cargados"}
            </div>
          ) : (
            <ul className="py-1">
              {filtrados.slice(0, 50).map((prod) => {
                const yaSeleccionado = selectedIds.includes(prod.id);
                return (
                  <li key={prod.id}>
                    <button
                      type="button"
                      onClick={() => {
                        onToggle(prod.id);
                        setBusqueda("");
                      }}
                      className={`flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left text-sm transition-colors hover:bg-slate-50 ${
                        yaSeleccionado ? "bg-[#4FAEB2]/5 text-[#3F8E91]" : "text-gray-800"
                      }`}
                    >
                      <span className="truncate">{prod.nombre}</span>
                      <span className="shrink-0 font-mono text-xs text-gray-500">
                        {Number(prod.precio_venta).toLocaleString("es-PY")} ₲
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
