"use client";

import { useEffect, useState } from "react";

/** Formatea número con separador de miles (Paraguay: 1.200.000) */
export function formatMontoDisplay(value: number | string, decimals = true): string {
  const n = typeof value === "string" ? parseMontoInput(value) : value;
  if (isNaN(n) || (typeof value === "number" && isNaN(value))) return "";
  return n.toLocaleString("es-PY", {
    minimumFractionDigits: decimals ? 0 : 0,
    maximumFractionDigits: decimals ? 2 : 0,
  });
}

/** Parsea string con formato a número (acepta "1.200.000", "1.234,50", "1234.56") */
export function parseMontoInput(value: string): number {
  if (!value || !value.trim()) return 0;
  const v = value.replace(/\s/g, "");
  if (v.includes(",")) {
    const [intPart, decPart] = v.split(",");
    const n = parseFloat((intPart || "").replace(/\./g, "") + "." + (decPart || "0"));
    return isNaN(n) ? 0 : n;
  }
  const parts = v.split(".");
  if (parts.length === 1) return parseFloat(parts[0]) || 0;
  const last = parts[parts.length - 1] || "";
  if (last.length <= 2 && /^\d+$/.test(last)) {
    return parseFloat(parts.slice(0, -1).join("") + "." + last) || 0;
  }
  return parseFloat(parts.join("")) || 0;
}

/** Valor del prop (number|string) a número, o null si está vacío. */
function propToNum(value: number | string): number | null {
  if (value === "" || value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const t = String(value).trim();
  if (t === "") return null;
  return parseMontoInput(t);
}

type MontoInputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "onChange"> & {
  value: number | string;
  onChange: (value: number) => void;
  /** Si true, permite decimales. Default: true */
  decimals?: boolean;
};

/**
 * Input de monto con separador de miles.
 *
 * Mantiene el texto que el usuario está tecleando (estado interno) y recién
 * reformatea con separador de miles al perder el foco. Así se pueden escribir
 * decimales con coma O punto sin que el reformateo en vivo "coma" el separador
 * (bug: al teclear "67," quedaba en "67" y terminaba guardando 6774).
 *
 * El texto solo se re-sincroniza desde el prop cuando el NÚMERO del prop difiere
 * del que representa el texto actual, de modo que una edición externa se refleja
 * pero la escritura en curso del usuario no se pisa.
 */
export default function MontoInput({
  value,
  onChange,
  decimals = true,
  className = "",
  onBlur,
  ...rest
}: MontoInputProps) {
  const [text, setText] = useState<string>(() => {
    const n = propToNum(value);
    return n === null ? "" : formatMontoDisplay(n, decimals);
  });

  // Re-sincroniza desde el prop solo si cambió el número (no mientras el usuario
  // teclea algo que representa el mismo valor, p. ej. "67," ↔ 67).
  useEffect(() => {
    const propNum = propToNum(value);
    const textNum = text.trim() === "" ? null : parseMontoInput(text);
    if (propNum !== textNum) {
      setText(propNum === null ? "" : formatMontoDisplay(propNum, decimals));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, decimals]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    setText(raw);
    onChange(parseMontoInput(raw));
  };

  const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    const n = parseMontoInput(text);
    setText(text.trim() === "" ? "" : formatMontoDisplay(n, decimals));
    onBlur?.(e);
  };

  return (
    <input
      type="text"
      inputMode="decimal"
      value={text}
      onChange={handleChange}
      onBlur={handleBlur}
      className={className}
      {...rest}
    />
  );
}
