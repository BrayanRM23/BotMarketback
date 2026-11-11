const TEXT_CHUNK_SIZE = 900;
const TEXT_OVERLAP = 150;
const ROWS_PER_CHUNK = 10;

// Corta texto en trozos de ~size caracteres, prefiriendo cortar en párrafo u oración,
// con solape para no perder contexto entre fragmentos.
function splitText(text, size = TEXT_CHUNK_SIZE, overlap = TEXT_OVERLAP) {
  const clean = text.replace(/\r/g, '').trim();
  if (!clean) return [];
  if (clean.length <= size) return [clean];

  const pieces = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + size, clean.length);
    if (end < clean.length) {
      const window = clean.slice(start, end);
      const cut = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('. '), window.lastIndexOf('\n'));
      if (cut > size * 0.5) end = start + cut + 1;
    }
    pieces.push(clean.slice(start, end).trim());
    if (end >= clean.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return pieces.filter(Boolean);
}

// Segmento de texto (una página de PDF, normalmente):
//   { type: 'text', text, page? }
// Segmento tabular (un lote de filas de una hoja):
//   { type: 'rows', sheet, header: string[], rows: string[][], startRow }
// Cada fila de una tabla se escribe como "columna: valor" con el encabezado repetido,
// para que cada fragmento se entienda por sí solo aunque se recupere aislado.
function buildChunks(segment) {
  if (segment.type === 'text') {
    const label = segment.page ? `Página ${segment.page}` : 'Texto';
    return splitText(segment.text || '').map((piece) => ({
      content: `[${label}]\n${piece}`,
      metadata: segment.page ? { page: segment.page } : {},
    }));
  }

  if (segment.type === 'rows') {
    const sheet = segment.sheet || 'Hoja';
    const header = (segment.header || []).map((h) => String(h ?? '').trim());
    const rows = segment.rows || [];
    const startRow = Number.isInteger(segment.startRow) ? segment.startRow : 1;
    const chunks = [];

    for (let i = 0; i < rows.length; i += ROWS_PER_CHUNK) {
      const group = rows.slice(i, i + ROWS_PER_CHUNK);
      const rowStart = startRow + i;
      const rowEnd = rowStart + group.length - 1;
      const lines = group
        .map((row) =>
          row
            .map((cell, j) => {
              const value = String(cell ?? '').trim();
              if (!value) return null;
              return header[j] ? `${header[j]}: ${value}` : value;
            })
            .filter(Boolean)
            .join(' | ')
        )
        .filter(Boolean);

      if (!lines.length) continue;
      chunks.push({
        content: `[Hoja: ${sheet}, filas ${rowStart}-${rowEnd}]\n${lines.join('\n')}`,
        metadata: { sheet, rowStart, rowEnd },
      });
    }
    return chunks;
  }

  return [];
}

module.exports = { buildChunks, splitText };
