const { buildChunks, splitText } = require('../utils/chunker');

describe('splitText', () => {
  test('un texto corto queda en un solo fragmento', () => {
    expect(splitText('Hola mundo')).toEqual(['Hola mundo']);
  });

  test('un texto vacío no genera fragmentos', () => {
    expect(splitText('   ')).toEqual([]);
  });

  test('un texto largo se parte en fragmentos de como máximo 900 caracteres', () => {
    const text = 'Esta es una oración de prueba. '.repeat(200);
    const pieces = splitText(text);
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) expect(piece.length).toBeLessThanOrEqual(900);
  });

  test('los fragmentos consecutivos se solapan para no perder contexto', () => {
    const text = Array.from({ length: 300 }, (_, i) => `palabra${i}`).join(' ');
    const [first, second] = splitText(text);
    const tail = first.slice(-60);
    expect(second.includes(tail.split(' ').slice(-2).join(' '))).toBe(true);
  });
});

describe('buildChunks', () => {
  test('texto de PDF conserva el número de página', () => {
    const [chunk] = buildChunks({ type: 'text', page: 3, text: 'Horario: 8 a 6' });
    expect(chunk.content).toBe('[Página 3]\nHorario: 8 a 6');
    expect(chunk.metadata).toEqual({ page: 3 });
  });

  test('texto sin página (TXT, DOCX) se etiqueta como Texto', () => {
    const [chunk] = buildChunks({ type: 'text', text: 'Contenido' });
    expect(chunk.content).toBe('[Texto]\nContenido');
    expect(chunk.metadata).toEqual({});
  });

  test('filas de Excel repiten hoja y encabezados como "columna: valor"', () => {
    const chunks = buildChunks({
      type: 'rows',
      sheet: 'Precios',
      header: ['SKU', 'Producto', 'Precio'],
      rows: [
        ['A1', 'Café', '5000'],
        ['B2', '', '7000'],
      ],
      startRow: 2,
    });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe(
      '[Hoja: Precios, filas 2-3]\nSKU: A1 | Producto: Café | Precio: 5000\nSKU: B2 | Precio: 7000'
    );
    expect(chunks[0].metadata).toEqual({ sheet: 'Precios', rowStart: 2, rowEnd: 3 });
  });

  test('cada fragmento de tabla agrupa como máximo 10 filas', () => {
    const rows = Array.from({ length: 25 }, (_, i) => [`fila${i}`]);
    const chunks = buildChunks({ type: 'rows', sheet: 'H', header: ['Col'], rows, startRow: 2 });
    expect(chunks).toHaveLength(3);
    expect(chunks[2].metadata).toEqual({ sheet: 'H', rowStart: 22, rowEnd: 26 });
  });

  test('filas completamente vacías no generan fragmentos', () => {
    const chunks = buildChunks({ type: 'rows', sheet: 'H', header: ['A'], rows: [[''], ['  ']], startRow: 2 });
    expect(chunks).toEqual([]);
  });

  test('un tipo de segmento desconocido se ignora', () => {
    expect(buildChunks({ type: 'imagen' })).toEqual([]);
  });
});
