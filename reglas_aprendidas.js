// Reglas aprendidas de casos reales validados por arquitectos (ground truth manual).
// Se inyectan siempre como parte del system prompt, tanto para el análisis
// geométrico/semántico del notebook (Celda 4) como para el análisis normativo
// del dossier en la web — ambos pasan por este mismo worker.
//
// Cómo agregar una regla nueva: cada vez que un ground truth revele un patrón
// de error o una convención específica de este tipo de proyectos, agregar una
// entrada acá. No reemplaza el ground truth (que sigue siendo la fuente para
// medir recall/precisión) — esto es lo que se le devuelve al modelo para que
// no repita el mismo error la próxima vez.

export const REGLAS_APRENDIDAS = [
  {
    fecha: "2026-07-22",
    origen: "Ground truth Plaza Pedro de Valdivia (Nivel 1)",
    regla:
      "Una línea segmentada/discontinua en el plano puede representar una viga estructural, no un muro. No asumas automáticamente que toda línea discontinua es un muro o límite de recinto — verifica el contexto (rótulos cercanos, tipo de trazo) antes de clasificarla.",
  },
  {
    fecha: "2026-07-22",
    origen: "Ground truth Plaza Pedro de Valdivia (Nivel 1 y Nivel 2)",
    regla:
      "En proyectos de este tipo (locales comerciales/oficinas pequeñas), 'salida de emergencia' generalmente no tiene un símbolo gráfico propio y distinto en el plano — corresponde funcionalmente a las puertas que dan directo al exterior del edificio. Al identificar salidas de emergencia, buscá puertas exteriores en vez de un ícono específico. No asumas que un nivel sin puertas exteriores directas (ej. un piso alto accesible solo por escalera interna) tiene salidas de emergencia propias.",
  },
];

/**
 * Construye el bloque de reglas aprendidas para el system prompt. Vacío si no hay reglas.
 * `origen`/`fecha` son metadata de trazabilidad para quien mantiene este archivo (de qué
 * caso salió la regla) — no viajan al prompt: este bloque se inyecta en TODO análisis,
 * de cualquier comuna o proyecto, y el nombre de un caso de prueba puntual no le aporta
 * nada al modelo ni debería aparecer en el análisis de un proyecto ajeno.
 */
export function buildReglasAprendidasSystem() {
  if (!REGLAS_APRENDIDAS.length) return "";

  const bloque = REGLAS_APRENDIDAS.map((r) => `- ${r.regla}`).join("\n");

  return `INSTRUCCIÓN: Las siguientes son reglas aprendidas de casos reales validados por arquitectos. Aplicalas al interpretar el plano y al analizar el expediente:\n\n${bloque}`;
}
