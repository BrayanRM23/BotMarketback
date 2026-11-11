const { getSupabase } = require('./supabase');
const { embedTexts } = require('./embeddings');

const MATCH_COUNT = 6;
const MAX_CONTEXT_CHARS = 6000;
const DEFAULT_MIN_SIMILARITY = 0.55;

// Similitud coseno mínima (0 a 1) para considerar relevante un fragmento.
// Se lee en cada llamada para poder ajustarla sin tocar código (RAG_MIN_SIMILARITY).
function getMinSimilarity() {
  const value = Number.parseFloat(process.env.RAG_MIN_SIMILARITY);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : DEFAULT_MIN_SIMILARITY;
}

/**
 * Busca los fragmentos relevantes del bot para la consulta.
 * Devuelve { text, kept, total, topSimilarity, mode }:
 * - text: fragmentos formateados para el prompt ('' si ninguno es relevante)
 * - mode: 'hybrid' (con embedding y umbral) o 'keyword' (el embedding falló; sin umbral)
 * Si el embedding falla, sigue con búsqueda solo por palabras clave en vez de romper el chat.
 */
async function retrieveContext(botId, query) {
  const empty = { text: '', kept: 0, total: 0, topSimilarity: null, mode: 'hybrid' };
  if (!query.trim()) return empty;

  let queryEmbedding = null;
  try {
    [queryEmbedding] = await embedTexts([query], 'RETRIEVAL_QUERY');
  } catch (error) {
    console.error('No se pudo generar el embedding de la consulta, usando solo palabras clave:', error);
  }

  const { data, error } = await getSupabase().rpc('match_knowledge', {
    p_bot_id: String(botId),
    query_text: query,
    query_embedding: queryEmbedding ? JSON.stringify(queryEmbedding) : null,
    match_count: MATCH_COUNT,
  });
  if (error) throw error;

  const mode = queryEmbedding ? 'hybrid' : 'keyword';
  const minSimilarity = getMinSimilarity();
  const rows = data || [];

  // La función SQL ya filtra por bot y por estado; se repite aquí como segunda barrera
  const candidates = rows.filter(
    (row) => row.chunk_bot_id === String(botId) && row.doc_status === 'ready'
  );
  const relevant =
    mode === 'hybrid'
      ? candidates.filter((row) => typeof row.similarity === 'number' && row.similarity >= minSimilarity)
      : candidates;

  const similarities = candidates.map((row) => row.similarity).filter((s) => typeof s === 'number');
  const topSimilarity = similarities.length ? Math.max(...similarities) : null;

  // Solo métricas, sin contenido: sirve para calibrar RAG_MIN_SIMILARITY con los logs
  console.log(
    `[RAG] bot=${botId} modo=${mode} umbral=${minSimilarity} top=${topSimilarity?.toFixed(3) ?? 'n/a'} ` +
      `usados=${relevant.length}/${candidates.length}`
  );

  const parts = [];
  let total = 0;
  for (const row of relevant) {
    const source = row.doc_filename + (row.chunk_metadata?.page ? `, página ${row.chunk_metadata.page}` : '');
    const block = `[Fuente: ${source}]\n${row.chunk_content}`;
    if (total + block.length > MAX_CONTEXT_CHARS) break;
    parts.push(block);
    total += block.length;
  }

  return {
    text: parts.join('\n\n'),
    kept: parts.length,
    total: candidates.length,
    topSimilarity,
    mode,
  };
}

module.exports = { retrieveContext, getMinSimilarity };
