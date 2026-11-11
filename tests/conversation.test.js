const {
  buildHistoryWindow,
  formatCalendarMemory,
  isValidSessionId,
  parsePrivacyAcceptance,
} = require('../utils/conversation');

function turns(count, size = 10) {
  const messages = [];
  for (let i = 0; i < count; i++) {
    messages.push({ role: 'user', content: `pregunta ${i} ${'x'.repeat(size)}` });
    messages.push({ role: 'assistant', content: `respuesta ${i} ${'y'.repeat(size)}` });
  }
  return messages;
}

describe('buildHistoryWindow', () => {
  test('una conversación corta entra completa y no fija nada', () => {
    const { history, pinnedFirst } = buildHistoryWindow(turns(3));
    expect(history).toHaveLength(6);
    expect(pinnedFirst).toBeNull();
  });

  test('sin mensajes devuelve historial vacío', () => {
    expect(buildHistoryWindow([])).toEqual({ history: [], pinnedFirst: null });
  });

  test('respeta el presupuesto de caracteres y siempre empieza en user y alterna', () => {
    const { history } = buildHistoryWindow(turns(30, 2000));
    const chars = history.reduce((acc, m) => acc + m.content.length, 0);
    expect(chars).toBeLessThanOrEqual(24000);
    history.forEach((m, i) => expect(m.role).toBe(i % 2 === 0 ? 'user' : 'assistant'));
  });

  test('conserva los turnos más recientes', () => {
    const { history } = buildHistoryWindow(turns(30, 2000));
    expect(history[history.length - 1].content).toMatch(/^respuesta 29/);
  });

  test('no supera 60 mensajes aunque sobre presupuesto', () => {
    const { history } = buildHistoryWindow(turns(50, 1));
    expect(history).toHaveLength(60);
  });

  test('fija el primer mensaje del cliente cuando queda fuera de la ventana', () => {
    const messages = turns(30, 2000);
    messages[0] = { role: 'user', content: 'Hola, soy Ana' };
    const { pinnedFirst } = buildHistoryWindow(messages);
    expect(pinnedFirst).toBe('Hola, soy Ana');
  });

  test('el primer mensaje fijado se recorta a 500 caracteres', () => {
    const messages = turns(30, 2000);
    messages[0] = { role: 'user', content: 'z'.repeat(800) };
    expect(buildHistoryWindow(messages).pinnedFirst).toHaveLength(500);
  });

  test('devuelve solo role y content', () => {
    const { history } = buildHistoryWindow([
      { role: 'user', content: 'a', createdAt: new Date() },
      { role: 'assistant', content: 'b', model: 'gemini-x' },
    ]);
    expect(history).toEqual([
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ]);
  });
});

describe('formatCalendarMemory', () => {
  test('omite eventos borrados después de crearse', () => {
    const memory = formatCalendarMemory([
      { action: 'create', eventId: 'e1', summary: 'Cita 1', start: 'a', end: 'b' },
      { action: 'delete', eventId: 'e1' },
      { action: 'create', eventId: 'e2', summary: 'Cita 2', start: 'c', end: 'd' },
    ]);
    expect(memory).toContain('eventId: e2');
    expect(memory).not.toContain('e1');
  });

  test('sin acciones devuelve texto vacío', () => {
    expect(formatCalendarMemory([])).toBe('');
  });
});

describe('validaciones', () => {
  test('isValidSessionId solo acepta UUID', () => {
    expect(isValidSessionId('123e4567-e89b-42d3-a456-426614174000')).toBe(true);
    expect(isValidSessionId('abc')).toBe(false);
    expect(isValidSessionId(undefined)).toBe(false);
  });

  test('parsePrivacyAcceptance acepta fechas válidas y rechaza futuras o inválidas', () => {
    expect(parsePrivacyAcceptance(new Date().toISOString())).toBeInstanceOf(Date);
    expect(parsePrivacyAcceptance('no es fecha')).toBeNull();
    expect(parsePrivacyAcceptance(new Date(Date.now() + 86400000).toISOString())).toBeNull();
    expect(parsePrivacyAcceptance(undefined)).toBeNull();
  });
});
