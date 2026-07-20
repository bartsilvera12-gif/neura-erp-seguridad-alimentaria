/**
 * Peso del producto: conversión entre lo que ve el usuario y lo que se guarda.
 *
 * En la base el peso vive SIEMPRE en gramos (`productos.peso_gramos`). La unidad
 * elegida (`peso_unidad`) es solo presentación. Toda conversión pasa por acá:
 * si cada pantalla multiplicara por 1000 por su cuenta, tarde o temprano una se
 * olvida y un flete sale mil veces más caro.
 */

export type PesoUnidad = "g" | "kg";

export const PESO_UNIDADES: { value: PesoUnidad; label: string }[] = [
  { value: "g", label: "Gramos (g)" },
  { value: "kg", label: "Kilogramos (kg)" },
];

export function esPesoUnidad(v: unknown): v is PesoUnidad {
  return v === "g" || v === "kg";
}

/** Lo que escribió el usuario, en su unidad → gramos para guardar. */
export function aGramos(valor: number, unidad: PesoUnidad): number {
  return unidad === "kg" ? valor * 1000 : valor;
}

/** Gramos de la base → el número a mostrar en la unidad elegida. */
export function desdeGramos(gramos: number, unidad: PesoUnidad): number {
  const v = unidad === "kg" ? gramos / 1000 : gramos;
  // 4 decimales alcanzan para 0,1 g expresado en kg y evitan que la división
  // arrastre ruido de punto flotante hasta el input.
  return Math.round(v * 10000) / 10000;
}

/**
 * Kilogramos, que es la unidad en la que se cotiza el flete.
 * Es el punto de entrada para cualquier fórmula de costeo.
 */
export function aKilos(gramos: number): number {
  return gramos / 1000;
}

/**
 * Flete que le corresponde a un producto según su peso.
 *
 * Fórmula base del costeo de importación: peso en kilos × costo de envío por
 * kilo. Se deja acá, y no dentro de una pantalla, para que compras, reportes y
 * cualquier costeo futuro usen exactamente el mismo cálculo.
 *
 * Devuelve null si falta el peso: es mejor mostrar "sin peso cargado" que
 * costear un producto importado como si el flete fuera cero.
 */
export function fletePorProducto(
  pesoGramos: number | null | undefined,
  costoPorKilo: number,
  cantidad = 1
): number | null {
  if (pesoGramos == null || !(pesoGramos > 0)) return null;
  if (!(costoPorKilo > 0)) return 0;
  return aKilos(pesoGramos) * costoPorKilo * cantidad;
}

/** Texto legible del peso, eligiendo la unidad que menos ceros arrastre. */
export function formatPeso(gramos: number | null | undefined, unidad?: PesoUnidad): string {
  if (gramos == null || !(gramos > 0)) return "—";
  // Sin preferencia guardada: por encima de 1 kg se lee mejor en kilos.
  const u: PesoUnidad = unidad ?? (gramos >= 1000 ? "kg" : "g");
  const v = desdeGramos(gramos, u);
  return `${v.toLocaleString("es-PY", { maximumFractionDigits: 4 })} ${u}`;
}
