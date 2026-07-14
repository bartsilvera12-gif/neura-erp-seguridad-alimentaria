/**
 * Carga el catálogo de productos de Seguridad Alimentaria (PDF "CATALOGO SA").
 *
 * Fuente: catálogo comercial del cliente — 56 productos, códigos 1001-1040 y
 * 1100-1117 (1111 y 1112 no existen en el catálogo). El PDF no trae precios ni
 * costos ni stock: se cargan en 0 y se completan luego desde Inventario.
 *
 * Idempotente: la tabla productos no tiene unique sobre (empresa_id, sku), así
 * que se filtran los SKU ya existentes antes de insertar.
 *
 * Ejecutar: npx tsx scripts/cargar-catalogo-seguridad-alimentaria.ts
 */
import { config } from "dotenv";
import path from "node:path";
import pg from "pg";

config({ path: path.resolve(process.cwd(), ".env.local") });

const EMPRESA_ID = "17908c42-c297-4506-bcb7-547ccecfe53a";
const SCHEMA = "seguridadalimentariaerp";
const IVA = "10%";

type Item = { sku: string; nombre: string; categoria: string; descripcion: string };

/** Categorías tal como las agrupa el catálogo (secciones con ►). */
const CATEGORIAS = [
  "Marcadores y bolígrafos",
  "Oficina",
  "Producción",
  "Mezcla y manipulación",
  "Portapapeles y dispensadores",
  "Control de plagas",
  "Insumos de producción",
  "Insumos de exportación",
  "Insumos de mantenimiento",
];

const PRODUCTOS: Item[] = [
  // ── Marcadores y bolígrafos ───────────────────────────────────────────────
  { sku: "1001", nombre: "Bolígrafo detectable", categoria: "Marcadores y bolígrafos", descripcion: "Bolígrafo de una sola pieza: sin piezas pequeñas, minimiza el riesgo de contaminación. Materiales aprobados por la UE y la FDA para contacto con alimentos. Colores de tinta: azul y negro." },
  { sku: "1003", nombre: "Marcador permanente detectable", categoria: "Marcadores y bolígrafos", descripcion: "Marcador permanente robusto, no tóxico y detectable, para escribir en todas las superficies. Retráctil: no necesita tapa. Color de tinta: negro." },
  { sku: "1004", nombre: "Marcador de pizarra blanca detectable", categoria: "Marcadores y bolígrafos", descripcion: "Marcador retráctil para pizarra blanca, carcasa azul con punta redonda. Color de tinta: azul." },
  { sku: "1005", nombre: "Marcador para carne detectable", categoria: "Marcadores y bolígrafos", descripcion: "Tinta apta para carne de secado rápido, evita que se destiña en el producto. Colores de tinta: azul y rojo." },
  { sku: "1006", nombre: "Marcador para alimentos detectable", categoria: "Marcadores y bolígrafos", descripcion: "Marcador retráctil para alimento y carne, carcasa azul. Tinta apta para alimentos de secado rápido. Color de tinta: negro." },
  { sku: "1020", nombre: "Bolígrafo elefante detectable", categoria: "Marcadores y bolígrafos", descripcion: "Fabricado con polímero detectable, diseño de una sola pieza que reduce la contaminación por cuerpos extraños. Colores de tinta: azul y rojo." },
  { sku: "1021", nombre: "Resaltador detectable", categoria: "Marcadores y bolígrafos", descripcion: "Cáscara azul, disponible en versión retráctil y no retráctil. Color de tinta: amarillo." },
  { sku: "1034", nombre: "Portamina detectable", categoria: "Marcadores y bolígrafos", descripcion: "Portamina metálica color azul para detección visual. Clip, punta y extremo de metal magnético." },
  { sku: "1036", nombre: "Bolígrafo retráctil 4 en 1 detectable", categoria: "Marcadores y bolígrafos", descripcion: "Bolígrafo retráctil cuatro en uno en carcasa azul estándar. Colores de tinta: azul, negro, rojo y verde." },

  // ── Oficina ───────────────────────────────────────────────────────────────
  { sku: "1002", nombre: "Plancheta de aluminio detectable", categoria: "Oficina", descripcion: "Tapa de placa de aluminio con pinza de metal. Tamaño A4: 312 x 228 mm." },
  { sku: "1007", nombre: "Bandas de goma detectables", categoria: "Oficina", descripcion: "Bandas de goma detectables color azul, diseñadas para la industria alimentaria, con materiales aprobados como seguros para alimentos. Tamaño: 80 x 6 x 1 mm." },
  { sku: "1011", nombre: "Presilladora sin grampa detectable", categoria: "Oficina", descripcion: "Polímero detectable. Sujeta hasta 5 hojas mediante corte, plegado y fijación, sin grampas. Color azul. Tamaño: 60 x 40 mm." },
  { sku: "1016", nombre: "Tijera de metal detectable", categoria: "Oficina", descripcion: "Uso general, hojas de acero inoxidable. Disponible en 15 cm y 18 cm." },
  { sku: "1017", nombre: "Regla de metal detectable", categoria: "Oficina", descripcion: "Acero inoxidable, resistente, con marcas de medición en cm y pulgadas. Disponible en 30 cm." },
  { sku: "1023", nombre: "Clips de papel detectable", categoria: "Oficina", descripcion: "Polímero detectable color azul. Elimina la necesidad de grapas en entornos de procesamiento de alimentos." },
  { sku: "1035", nombre: "Pegatina detectable", categoria: "Oficina", descripcion: "Pegatina detectable con tira de aluminio. Color azul. Cuadrado de 10 mm." },
  { sku: "1037", nombre: "Regla de plástico detectable", categoria: "Oficina", descripcion: "Polímero detectable con medidas métricas. Disponible en 15 cm y 30 cm." },

  // ── Producción ────────────────────────────────────────────────────────────
  { sku: "1012", nombre: "Barbijo detectable", categoria: "Producción", descripcion: "Barbijo detectable desechable, sin tejer. Permite respirar con facilidad. Talle único. Color azul." },
  { sku: "1013", nombre: "Curitas adhesivas detectables", categoria: "Producción", descripcion: "Curitas adhesivas detectables de metal, color azul, con detección dual (metal y rayos X). Cumplen BRCGS y HACCP; aprobadas por FDA 21 CFR parte 807. Tamaños: 19 x 72 mm y 51 x 72 mm." },
  { sku: "1014", nombre: "Cintillo de seguridad detectable", categoria: "Producción", descripcion: "Cintillos reutilizables y detectables para asegurar y agrupar artículos. Color azul. Tamaño: 250 x 7,5 mm." },
  { sku: "1015", nombre: "Cadena de seguridad con soporte detectable para bolígrafo", categoria: "Producción", descripcion: "Cadena de seguridad de 762 mm con anillo y clip en cada extremo, con soporte detectable para bolígrafos sin clip. Material: acero inoxidable. El bolígrafo se vende por separado." },
  { sku: "1018", nombre: "Cordón de silicona para anteojo detectable", categoria: "Producción", descripcion: "Cordón de silicona metal detectable para anteojos. Mantiene los anteojos sujetos al cuello. Reutilizable. Color azul." },
  { sku: "1019", nombre: "Cofia azul detectable", categoria: "Producción", descripcion: "Cofia plisada, no tejida, desechable y detectable con metal. Banda elástica de doble costura, transpirable. Talle único. Color azul." },
  { sku: "1024", nombre: "Porta tarjetas de identificación de doble cara detectable", categoria: "Producción", descripcion: "Porta tarjetas / deslizador de doble cara detectable, sujeta dos tarjetas simultáneamente. Tamaño: 97 x 70 mm. Color azul." },
  { sku: "1025", nombre: "Tapones para oídos detectables", categoria: "Producción", descripcion: "Protección auditiva detectable para centros de procesamiento. Reutilizables. Color azul." },
  { sku: "1026", nombre: "Caja de almacenamiento para tapones de oídos detectables", categoria: "Producción", descripcion: "Polímero totalmente detectable. Dos secciones (oído izquierdo y derecho) y tres orificios de drenaje, apta para tapones recién lavados." },
  { sku: "1027", nombre: "Porta llavero detectable", categoria: "Producción", descripcion: "Para colgar objetos del cuello, con anilla y clip. Cierre de seguridad detectable que permite recolocar el llavero si se rompe. Color azul. Tamaño: 480 mm." },
  { sku: "1031", nombre: "Cinta adhesiva doble faz detectable", categoria: "Producción", descripcion: "Cinta adhesiva blanca multiuso de fuerte adhesión, ideal para superficies húmedas, rugosas o difíciles. Resistencia: -10 a 70 grados. Tamaño: 1 m x 25 mm. Color blanco." },

  // ── Mezcla y manipulación ─────────────────────────────────────────────────
  { sku: "1008", nombre: "Navaja retráctil detectable", categoria: "Mezcla y manipulación", descripcion: "Detectable, desechable y retráctil, con hoja de 13 mm. Uso ambidiestro. Mango de nailon resistente detectable. Uso: cartón. Dimensiones: 130 x 25 x 15 mm. Color azul." },
  { sku: "1009", nombre: "Raspador manual detectable", categoria: "Mezcla y manipulación", descripcion: "Raspador manual de polipropileno para raspar y limpiar. Ideal para cocinas, áreas de preparación de alimentos y plantas de fabricación." },
  { sku: "1010", nombre: "Vaso de muestreo detectable", categoria: "Mezcla y manipulación", descripcion: "Vaso de muestreo de 250 ml en polímero detectable, aprobado para contacto con alimentos por la UE y la FDA." },
  { sku: "1022", nombre: "Espátula azul detectable", categoria: "Mezcla y manipulación", descripcion: "Espátula miniatura detectable de polipropileno duradero y seguro para alimentos. Color azul. Longitud: 160 mm. Ancho de hoja: 17 mm." },
  { sku: "1030", nombre: "Cuchillo pelador detectable", categoria: "Mezcla y manipulación", descripcion: "Cuchillo pelador detectable fabricado con acero Sheffield, de mayor resistencia y durabilidad. Mango ergonómico." },
  { sku: "1033", nombre: "Termómetro con sonda de temperatura para alimentos", categoria: "Mezcla y manipulación", descripcion: "Sonda de temperatura para alimentos totalmente detectable. Rango: -50 a 300 grados. Apagado automático. Carcasa color azul." },
  { sku: "1039", nombre: "Cuchara de plástico detectable", categoria: "Mezcla y manipulación", descripcion: "Cuchara de plástico para una amplia gama de ingredientes y áreas de proceso. Color azul. Tamaño: 155 x 50 x 40 mm. Mango: 90 mm." },

  // ── Portapapeles y dispensadores ──────────────────────────────────────────
  { sku: "1028", nombre: "Portadocumentos de acero inoxidable detectable", categoria: "Portapapeles y dispensadores", descripcion: "Soporte para portapapeles de acero inoxidable, montaje en pared, color plata. Admite portapapeles A4. Tamaño: 247 x 243 x 40 mm." },
  { sku: "1029", nombre: "Portadocumento tipo sobre plástico detectable", categoria: "Portapapeles y dispensadores", descripcion: "Portapapel de plástico detectable montable en pared. Sostiene portapapeles A4. Color azul. Tamaño: 220 x 310 x 25 mm." },
  { sku: "1032", nombre: "Dispensador de bolígrafos detectable", categoria: "Portapapeles y dispensadores", descripcion: "Dispensador de bolígrafos montable en pared, mantiene los bolígrafos detectables organizados y accesibles. Tamaño: 150 x 155 x 95 mm. Color azul." },
  { sku: "1038", nombre: "Bolsillo / soporte para archivos detectable", categoria: "Portapapeles y dispensadores", descripcion: "Bolsillo de archivos detectable montado en pared, permite almacenar múltiples archivos cerca de donde se necesitan. Tamaño A4. Color azul." },
  { sku: "1040", nombre: "Dispensador de tapones para oídos detectables", categoria: "Portapapeles y dispensadores", descripcion: "Dispensador con capacidad para 30 pares de tapones. Montable en pared con dos orificios para tornillos. Color azul. Tamaño: 140 x 105 x 90 mm." },

  // ── Control de plagas ─────────────────────────────────────────────────────
  { sku: "1106", nombre: "Lámpara UV (set completo)", categoria: "Control de plagas", descripcion: "Trampa de luz UV con lámina adhesiva para insectos voladores. Elimina moscas, mosquitos y polillas sin dejar partículas en el aire. Silenciosa, sin olores y no tóxica." },
  { sku: "1107", nombre: "Láminas adhesivas", categoria: "Control de plagas", descripcion: "Lámina adhesiva de repuesto para trampa de luz UV. Captura los insectos sin dejarlos a la vista." },
  { sku: "1108", nombre: "Tubos fluorescentes UV 15 W", categoria: "Control de plagas", descripcion: "Tubo fluorescente ultravioleta de 15 W de repuesto para trampa de luz UV." },
  { sku: "1109", nombre: "Reactancia electrónica con zócalos y conectores", categoria: "Control de plagas", descripcion: "Reactancia electrónica con zócalos y conectores para trampa de luz UV." },
  { sku: "1110", nombre: "Gel repelente contra aves", categoria: "Control de plagas", descripcion: "Producto diseñado para repeler palomas y murciélagos. Actúa al contacto, sin provocar daño ni consecuencias." },
  { sku: "1115", nombre: "Tierra de diatomeas bolsa de 20 kg", categoria: "Control de plagas", descripcion: "Insecticida, fungicida y fertilizante ecológico natural compuesto por algas fosilizadas rico en sílice. Actúa físicamente deshidratando las plagas al cortar su exoesqueleto." },

  // ── Insumos de producción ─────────────────────────────────────────────────
  { sku: "1102", nombre: "Guantes de nitrilo azul", categoria: "Insumos de producción", descripcion: "Guantes de nitrilo color azul para producción de alimentos." },
  { sku: "1103", nombre: "Guantes de látex", categoria: "Insumos de producción", descripcion: "Guantes de látex para producción de alimentos." },
  { sku: "1104", nombre: "Tapaboca azul", categoria: "Insumos de producción", descripcion: "Tapaboca color azul para producción de alimentos." },
  { sku: "1105", nombre: "Cofia blanca", categoria: "Insumos de producción", descripcion: "Cofia color blanco para producción de alimentos." },

  // ── Insumos de exportación ────────────────────────────────────────────────
  { sku: "1100", nombre: "Temcoatliner para container de 20'", categoria: "Insumos de exportación", descripcion: "Revestimiento térmico de alto rendimiento para proteger mercancías sensibles de temperaturas extremas durante el transporte en contenedor de 20 pies. Refleja hasta el 97% de la radiación térmica." },
  { sku: "1101", nombre: "Temcoatliner para container de 40'", categoria: "Insumos de exportación", descripcion: "Revestimiento térmico de alto rendimiento para proteger mercancías sensibles de temperaturas extremas durante el transporte en contenedor de 40 pies. Refleja hasta el 97% de la radiación térmica." },
  { sku: "1116", nombre: "Termógrafo (datalogger)", categoria: "Insumos de exportación", descripcion: "Registrador de datos de un solo uso para monitorear temperatura durante almacenamiento y transporte. Almacena hasta 10.000 lecturas, se conecta por USB y exporta informe PDF. Rango de medición: -10 a 30 grados." },
  { sku: "1117", nombre: "Absorbente de 1 kg", categoria: "Insumos de exportación", descripcion: "Absorbente de humedad de 1 kg. Elimina el exceso de humedad, moho y malos olores en espacios de hasta 35-40 m². Compuesto por cloruro de calcio o sílice gel." },

  // ── Insumos de mantenimiento ──────────────────────────────────────────────
  { sku: "1113", nombre: "Aceite penetrante grado alimenticio 311 g", categoria: "Insumos de mantenimiento", descripcion: "Aceite penetrante de grado alimenticio. Presentación: 311 g." },
  { sku: "1114", nombre: "Lubricante grado alimenticio 340 g", categoria: "Insumos de mantenimiento", descripcion: "Lubricante de grado alimenticio. Presentación: 340 g." },
];

async function main() {
  const url =
    process.env.SUPABASE_DB_URL?.trim() ||
    process.env.DIRECT_URL?.trim() ||
    process.env.DATABASE_URL?.trim();
  if (!url) throw new Error("Falta SUPABASE_DB_URL / DATABASE_URL en .env.local");

  const client = new pg.Client({
    connectionString: url,
    ssl: url.includes("supabase") ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();

  try {
    await client.query("BEGIN");

    // 1) Categorías (idempotente por nombre).
    const catIds = new Map<string, string>();
    for (const nombre of CATEGORIAS) {
      const existente = await client.query(
        `SELECT id FROM ${SCHEMA}.categorias_productos WHERE empresa_id = $1 AND nombre = $2 LIMIT 1`,
        [EMPRESA_ID, nombre]
      );
      if (existente.rows[0]) {
        catIds.set(nombre, existente.rows[0].id);
        continue;
      }
      const creada = await client.query(
        `INSERT INTO ${SCHEMA}.categorias_productos (empresa_id, nombre) VALUES ($1, $2) RETURNING id`,
        [EMPRESA_ID, nombre]
      );
      catIds.set(nombre, creada.rows[0].id);
    }

    // 2) Productos: solo los SKU que aún no existen.
    const yaCargados = await client.query(
      `SELECT sku FROM ${SCHEMA}.productos WHERE empresa_id = $1`,
      [EMPRESA_ID]
    );
    const existentes = new Set(yaCargados.rows.map((r: { sku: string }) => r.sku));

    let insertados = 0;
    for (const p of PRODUCTOS) {
      if (existentes.has(p.sku)) continue;
      await client.query(
        `INSERT INTO ${SCHEMA}.productos
           (empresa_id, nombre, sku, descripcion, categoria_principal_id, tipo_iva,
            precio_venta, costo_promedio, stock_actual, stock_minimo,
            unidad_medida, es_vendible, controla_stock, activo)
         VALUES ($1, $2, $3, $4, $5, $6, 0, 0, 0, 0, 'Unidad', true, true, true)`,
        [EMPRESA_ID, p.nombre, p.sku, p.descripcion, catIds.get(p.categoria), IVA]
      );
      insertados++;
    }

    await client.query("COMMIT");

    console.log(`Categorías: ${catIds.size}`);
    console.log(`Productos insertados: ${insertados} (omitidos por SKU ya existente: ${PRODUCTOS.length - insertados})`);
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
