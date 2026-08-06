"use client";

import { useParams, useRouter } from "next/navigation";
import ProspectoDetalleForm from "@/app/crm/components/ProspectoDetalleForm";

export default function EditProspectoPage() {
  const params = useParams();
  const router = useRouter();
  if (!params) return null;
  const id = params.id as string;

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      {/* Sin `onUpdated`: el formulario ya se recarga solo. Navegar al funnel en
          cada guardado expulsaba de la pantalla al agregar una nota o cambiar
          de etapa — la vía normal de edición en móvil. */}
      <ProspectoDetalleForm
        id={id}
        variant="page"
        onDeleted={() => router.push("/crm")}
        onCancel={() => router.push("/crm")}
      />
    </div>
  );
}
