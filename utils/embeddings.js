const { ai } = require('./gemini');

const MODEL = process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-001';
// Debe coincidir con vector(768) en supabase/schema.sql
const DIMENSIONS = 768;
const BATCH_SIZE = 100;
const MAX_ATTEMPTS = 4;
const RETRYABLE_STATUSES = [429, 500, 503, 504];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// taskType: 'RETRIEVAL_DOCUMENT' al indexar, 'RETRIEVAL_QUERY' al buscar.
// No hay fallback entre modelos: documentos y consultas deben estar en el mismo espacio vectorial.
async function embedBatch(texts, taskType, attempt = 1) {
  try {
    const res = await ai.models.embedContent({
      model: MODEL,
      contents: texts,
      config: { taskType, outputDimensionality: DIMENSIONS },
    });
    return res.embeddings.map((e) => e.values);
  } catch (error) {
    if (!RETRYABLE_STATUSES.includes(error?.status) || attempt >= MAX_ATTEMPTS) throw error;
    await sleep(1000 * 2 ** (attempt - 1));
    return embedBatch(texts, taskType, attempt + 1);
  }
}

async function embedTexts(texts, taskType) {
  const vectors = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    vectors.push(...(await embedBatch(texts.slice(i, i + BATCH_SIZE), taskType)));
  }
  return vectors;
}

module.exports = { embedTexts, EMBEDDING_DIMENSIONS: DIMENSIONS };
