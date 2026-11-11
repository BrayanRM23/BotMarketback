// Recuperación: filtro por estado del documento, aislamiento por bot y umbral de similitud.
// Supabase y los embeddings se simulan: no hay llamadas de red.

const mockRpc = jest.fn();
const mockEmbedTexts = jest.fn();

jest.mock('../utils/supabase', () => ({ getSupabase: () => ({ rpc: mockRpc }) }));
jest.mock('../utils/embeddings', () => ({ embedTexts: (...args) => mockEmbedTexts(...args) }));

const { retrieveContext } = require('../utils/rag');

function row(overrides = {}) {
  return {
    chunk_id: 1,
    doc_id: 'doc-1',
    doc_filename: 'menu.pdf',
    doc_status: 'ready',
    chunk_bot_id: 'botA',
    chunk_content: 'Contenido',
    chunk_metadata: {},
    relevance: 0.03,
    similarity: 0.8,
    ...overrides,
  };
}

beforeEach(() => {
  mockRpc.mockReset();
  mockEmbedTexts.mockReset();
  mockEmbedTexts.mockResolvedValue([[0.1, 0.2, 0.3]]);
  delete process.env.RAG_MIN_SIMILARITY;
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

test('consulta la búsqueda solo con el bot pedido', async () => {
  mockRpc.mockResolvedValue({ data: [], error: null });
  await retrieveContext('botA', '¿Cuál es el horario?');
  expect(mockRpc).toHaveBeenCalledWith(
    'match_knowledge',
    expect.objectContaining({ p_bot_id: 'botA', query_text: '¿Cuál es el horario?' })
  );
});

test('descarta fragmentos de documentos que no están en estado ready', async () => {
  mockRpc.mockResolvedValue({
    data: [
      row({ chunk_content: 'listo' }),
      row({ chunk_content: 'en proceso', doc_status: 'processing' }),
      row({ chunk_content: 'con error', doc_status: 'error' }),
    ],
    error: null,
  });
  const result = await retrieveContext('botA', 'pregunta');
  expect(result.text).toContain('listo');
  expect(result.text).not.toContain('en proceso');
  expect(result.text).not.toContain('con error');
  expect(result.kept).toBe(1);
});

test('descarta fragmentos de otro bot aunque la base los devuelva', async () => {
  mockRpc.mockResolvedValue({
    data: [row({ chunk_content: 'propio' }), row({ chunk_content: 'ajeno', chunk_bot_id: 'botB' })],
    error: null,
  });
  const result = await retrieveContext('botA', 'pregunta');
  expect(result.text).toContain('propio');
  expect(result.text).not.toContain('ajeno');
});

test('aplica el umbral de similitud configurable', async () => {
  process.env.RAG_MIN_SIMILARITY = '0.7';
  mockRpc.mockResolvedValue({
    data: [row({ chunk_content: 'alto', similarity: 0.75 }), row({ chunk_content: 'bajo', similarity: 0.6 })],
    error: null,
  });
  const result = await retrieveContext('botA', 'pregunta');
  expect(result.text).toContain('alto');
  expect(result.text).not.toContain('bajo');
  expect(result.topSimilarity).toBe(0.75);
});

test('sin fragmentos por encima del umbral devuelve texto vacío', async () => {
  mockRpc.mockResolvedValue({ data: [row({ similarity: 0.2 })], error: null });
  const result = await retrieveContext('botA', 'pregunta fuera de tema');
  expect(result.text).toBe('');
  expect(result.total).toBe(1);
});

test('si falla el embedding usa solo palabras clave y no aplica umbral', async () => {
  mockEmbedTexts.mockRejectedValue(new Error('cuota agotada'));
  mockRpc.mockResolvedValue({ data: [row({ similarity: null, chunk_content: 'por palabra clave' })], error: null });
  const result = await retrieveContext('botA', 'precio');
  expect(mockRpc).toHaveBeenCalledWith('match_knowledge', expect.objectContaining({ query_embedding: null }));
  expect(result.mode).toBe('keyword');
  expect(result.text).toContain('por palabra clave');
});

test('un error de la base de datos se propaga', async () => {
  mockRpc.mockResolvedValue({ data: null, error: new Error('fallo de red') });
  await expect(retrieveContext('botA', 'pregunta')).rejects.toThrow('fallo de red');
});
