// Calibración de RAG_MIN_SIMILARITY: muestra la similitud de los fragmentos que recupera
// cada pregunta, para ver dónde está el corte entre preguntas con y sin respuesta.
//
// Uso (desde BotMarketback, con el .env configurado):
//   node scripts/rag-check.js <botId> "pregunta 1" "pregunta 2" ...
//
// Imprime el texto de los fragmentos: úsalo solo en local.

require('dotenv').config();
const { getSupabase } = require('../utils/supabase');
const { embedTexts } = require('../utils/embeddings');
const { getMinSimilarity } = require('../utils/rag');

async function main() {
  const [botId, ...questions] = process.argv.slice(2);
  if (!botId || !questions.length) {
    console.log('Uso: node scripts/rag-check.js <botId> "pregunta 1" "pregunta 2" ...');
    process.exit(1);
  }

  const threshold = getMinSimilarity();
  console.log(`Umbral actual (RAG_MIN_SIMILARITY): ${threshold}\n`);

  for (const question of questions) {
    const [embedding] = await embedTexts([question], 'RETRIEVAL_QUERY');
    const { data, error } = await getSupabase().rpc('match_knowledge', {
      p_bot_id: botId,
      query_text: question,
      query_embedding: JSON.stringify(embedding),
      match_count: 6,
    });
    if (error) throw error;

    const rows = (data || []).sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));
    console.log(`Pregunta: ${question}`);
    if (!rows.length) console.log('  (sin fragmentos)');
    for (const row of rows) {
      const sim = row.similarity?.toFixed(3) ?? 'n/a';
      const mark = (row.similarity ?? 0) >= threshold ? 'PASA' : '----';
      const preview = row.chunk_content.replace(/\s+/g, ' ').slice(0, 90);
      console.log(`  ${mark} ${sim}  ${row.doc_filename}  ${preview}`);
    }
    console.log('');
  }
}

main().catch((error) => {
  console.error('Error:', error.message || error);
  process.exit(1);
});
