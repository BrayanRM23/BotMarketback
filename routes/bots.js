const crypto = require('crypto');
const express = require('express');
const mongoose = require('mongoose');
const Bot = require('../models/Bot');
const authMiddleware = require('../middleware/authMiddleware');
const gcal = require('../utils/googleCalendar');
const { generateWithRetry } = require('../utils/gemini');
const { retrieveContext } = require('../utils/rag');
const { buildSystemPrompt, TONES } = require('../utils/prompt');
const { getConversationTtlDays } = require('../utils/retention');
const {
  isValidSessionId,
  buildHistoryWindow,
  formatCalendarMemory,
  loadConversation,
  saveTurn,
  deleteConversation,
  parsePrivacyAcceptance,
} = require('../utils/conversation');

const router = express.Router();

const MAX_MESSAGE_CHARS = 4000;
// Mensajes más cortos que esto se consideran seguimientos y arrastran contexto para el RAG
const FOLLOW_UP_CHARS = 60;

// Mensajes para el visitante: sin detalles técnicos (esos van al log del servidor)
const CHAT_ERROR_MESSAGES = {
  busy: 'El asistente está recibiendo muchas consultas en este momento. Intenta de nuevo en un minuto.',
  unavailable: 'El asistente no está disponible en este momento. Intenta de nuevo en unos segundos.',
  generic: 'No pude responder a tu mensaje en este momento. Intenta de nuevo en unos segundos.',
};

// ─── Definiciones de herramientas de Calendar para Gemini ───────────────────

function buildCalendarTools(permissions, customFields, defaultDuration) {
  const declarations = [];
  const fieldsHint =
    customFields?.length
      ? `Campos a recolectar obligatoriamente del cliente: ${customFields.join(', ')}.`
      : '';

  if (permissions.viewAvailability) {
    declarations.push({
      name: 'checkAvailability',
      description:
        'Consulta si hay disponibilidad en el calendario para una fecha y hora. Úsalo antes de proponer un horario.',
      parameters: {
        type: 'OBJECT',
        properties: {
          startDateTime: {
            type: 'STRING',
            description: 'Fecha y hora de inicio en RFC 3339 con timezone. SIEMPRE incluir Z o offset. Ej: 2026-04-28T10:00:00Z o 2026-04-28T10:00:00-05:00',
          },
          endDateTime: {
            type: 'STRING',
            description: 'Fecha y hora de fin en RFC 3339 con timezone. SIEMPRE incluir Z o offset. Ej: 2026-04-28T11:00:00Z',
          },
        },
        required: ['startDateTime', 'endDateTime'],
      },
    });
  }

  if (permissions.listEvents) {
    declarations.push({
      name: 'listEvents',
      description: 'Lista los eventos del calendario en un rango de fechas.',
      parameters: {
        type: 'OBJECT',
        properties: {
          timeMin: {
            type: 'STRING',
            description: 'Fecha de inicio del rango en RFC 3339 con timezone. Ej: 2026-04-28T00:00:00Z',
          },
          timeMax: {
            type: 'STRING',
            description: 'Fecha de fin del rango en RFC 3339 con timezone. Ej: 2026-04-28T23:59:59Z',
          },
          maxResults: {
            type: 'NUMBER',
            description: 'Máximo de eventos a retornar (por defecto 10)',
          },
        },
        required: ['timeMin', 'timeMax'],
      },
    });
  }

  if (permissions.createEvents) {
    declarations.push({
      name: 'createEvent',
      description: `Crea un nuevo evento en el calendario. ${fieldsHint} IMPORTANTE: Siempre pide confirmación explícita al usuario antes de llamar esta función.`,
      parameters: {
        type: 'OBJECT',
        properties: {
          summary: { type: 'STRING', description: 'Título del evento' },
          description: {
            type: 'STRING',
            description: 'Descripción con los datos recolectados del cliente',
          },
          startDateTime: {
            type: 'STRING',
            description: `Fecha y hora de inicio en RFC 3339 con timezone. SIEMPRE incluir Z o offset. Duración sugerida: ${defaultDuration} minutos. Ej: 2026-04-28T10:00:00Z`,
          },
          endDateTime: {
            type: 'STRING',
            description: 'Fecha y hora de fin en RFC 3339 con timezone. SIEMPRE incluir Z o offset. Ej: 2026-04-28T11:00:00Z',
          },
        },
        required: ['summary', 'startDateTime', 'endDateTime'],
      },
    });
  }

  if (permissions.editEvents) {
    declarations.push({
      name: 'editEvent',
      description:
        'Edita un evento existente en el calendario. Primero usa listEvents para obtener el eventId.',
      parameters: {
        type: 'OBJECT',
        properties: {
          eventId: { type: 'STRING', description: 'ID del evento a editar' },
          summary: { type: 'STRING', description: 'Nuevo título (opcional)' },
          description: { type: 'STRING', description: 'Nueva descripción (opcional)' },
          startDateTime: {
            type: 'STRING',
            description: 'Nueva fecha y hora de inicio en RFC 3339 con timezone. Ej: 2026-04-28T10:00:00Z (opcional)',
          },
          endDateTime: {
            type: 'STRING',
            description: 'Nueva fecha y hora de fin en RFC 3339 con timezone. Ej: 2026-04-28T11:00:00Z (opcional)',
          },
        },
        required: ['eventId'],
      },
    });
  }

  if (permissions.deleteEvents) {
    declarations.push({
      name: 'deleteEvent',
      description:
        'Elimina un evento del calendario. Siempre confirma con el usuario antes de llamar esta función.',
      parameters: {
        type: 'OBJECT',
        properties: {
          eventId: { type: 'STRING', description: 'ID del evento a eliminar' },
          summary: { type: 'STRING', description: 'Nombre del evento (para confirmar con el usuario)' },
        },
        required: ['eventId'],
      },
    });
  }

  return declarations.length > 0 ? [{ functionDeclarations: declarations }] : null;
}

// ─── Ejecutar una función de calendar solicitada por Gemini ─────────────────

// ID determinístico para createEvent: si el mismo evento se pide otra vez (p. ej. al
// reintentar tras un 503), Google responde 409 y no se duplica. Solo usa caracteres
// hexadecimales, que Google acepta en IDs de evento.
function buildEventId(botId, args) {
  // Mismo criterio que toRFC3339 en utils/googleCalendar.js: sin zona horaria se asume UTC
  const normalizeDate = (value) => {
    const str = String(value ?? '');
    const withZone = /Z$|[+-]\d{2}:\d{2}$/.test(str) ? str : `${str}Z`;
    const t = Date.parse(withZone);
    return Number.isNaN(t) ? str : new Date(t).toISOString();
  };
  const key = [
    String(botId),
    normalizeDate(args.startDateTime),
    normalizeDate(args.endDateTime),
    String(args.summary ?? '').trim().toLowerCase(),
  ].join('|');
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 40);
}

async function executeCalendarFunction(funcName, args, bot) {
  const auth = gcal.getAuthenticatedClient(bot.googleCalendar);
  const calendarId = bot.googleCalendar.calendarId || 'primary';
  const timezone = bot.googleCalendar.timezone || 'America/Bogota';

  let result;
  let logEntry = null;

  switch (funcName) {
    case 'checkAvailability': {
      const data = await gcal.checkFreeBusy(auth, calendarId, args.startDateTime, args.endDateTime);
      result = data.isFree
        ? { available: true, message: 'El horario está libre.' }
        : { available: false, busySlots: data.busy, message: 'El horario tiene conflictos.' };
      logEntry = { action: 'check', summary: `Disponibilidad ${args.startDateTime}` };
      break;
    }
    case 'listEvents': {
      const events = await gcal.listEvents(
        auth,
        calendarId,
        args.timeMin,
        args.timeMax,
        args.maxResults || 10
      );
      result = { events };
      logEntry = { action: 'list', summary: `Listado ${args.timeMin} — ${args.timeMax}` };
      break;
    }
    case 'createEvent': {
      const event = await gcal.createEvent(auth, calendarId, {
        id: buildEventId(bot._id, args),
        summary: args.summary,
        description: args.description || '',
        startDateTime: args.startDateTime,
        endDateTime: args.endDateTime,
        timeZone: timezone,
      });
      result = { success: true, event, alreadyExisted: event.alreadyExisted };
      if (!event.alreadyExisted) {
        logEntry = { action: 'create', eventId: event.id, summary: event.summary };
      }
      break;
    }
    case 'editEvent': {
      const updated = await gcal.updateEvent(auth, calendarId, args.eventId, {
        summary: args.summary,
        description: args.description,
        startDateTime: args.startDateTime,
        endDateTime: args.endDateTime,
        timeZone: timezone,
      });
      result = { success: true, event: updated };
      logEntry = { action: 'edit', eventId: args.eventId, summary: updated.summary };
      break;
    }
    case 'deleteEvent': {
      const deletion = await gcal.deleteEvent(auth, calendarId, args.eventId);
      result = {
        success: true,
        message: deletion.alreadyDeleted
          ? 'El evento ya había sido eliminado.'
          : 'Evento eliminado correctamente.',
      };
      if (!deletion.alreadyDeleted) {
        logEntry = { action: 'delete', eventId: args.eventId, summary: args.summary || '' };
      }
      break;
    }
    default:
      result = { error: 'Función no reconocida.' };
  }

  // Guardar en log (máx 100 entradas)
  if (logEntry) {
    bot.calendarLog.push(logEntry);
    if (bot.calendarLog.length > 100) {
      bot.calendarLog = bot.calendarLog.slice(-100);
    }
    await bot.save();
  }

  return result;
}

// Acción de calendario que se recuerda en la conversación para turnos siguientes
function toCalendarAction(funcName, args, result) {
  if (!result?.success) return null;
  if (funcName === 'createEvent' && result.event?.id) {
    return { action: 'create', eventId: result.event.id, summary: result.event.summary || '', start: result.event.start || '', end: result.event.end || '' };
  }
  if (funcName === 'editEvent' && result.event?.id) {
    return { action: 'edit', eventId: result.event.id, summary: result.event.summary || '', start: result.event.start || '', end: result.event.end || '' };
  }
  if (funcName === 'deleteEvent') {
    return { action: 'delete', eventId: args.eventId || '', summary: args.summary || '' };
  }
  return null;
}

// ─── Rutas de CRUD de Bots ───────────────────────────────────────────────────

// Crear nuevo bot (protegido)
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { name, description } = req.body;

    if (!name) {
      return res.status(400).json({ message: 'El nombre del bot es obligatorio.' });
    }

    const bot = await Bot.create({
      user: req.user.id,
      name,
      description: description || '',
    });

    return res.status(201).json({ bot });
  } catch (error) {
    console.error('Error al crear bot:', error);
    return res.status(500).json({ message: 'Error en el servidor al crear el bot.' });
  }
});

// Listar bots del usuario actual (protegido)
router.get('/', authMiddleware, async (req, res) => {
  try {
    const bots = await Bot.find({ user: req.user.id })
      .select('-googleCalendar.accessToken -googleCalendar.refreshToken -calendarLog')
      .sort({ createdAt: -1 });
    return res.json({ bots });
  } catch (error) {
    console.error('Error al obtener bots:', error);
    return res.status(500).json({ message: 'Error en el servidor al obtener los bots.' });
  }
});

// Obtener un bot específico para editar (protegido)
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const bot = await Bot.findOne({ _id: req.params.id, user: req.user.id }).select(
      '-googleCalendar.accessToken -googleCalendar.refreshToken -calendarLog'
    );
    if (!bot) {
      return res.status(404).json({ message: 'Bot no encontrado.' });
    }
    return res.json({ bot });
  } catch (error) {
    console.error('Error al obtener bot:', error);
    return res.status(500).json({ message: 'Error en el servidor al obtener el bot.' });
  }
});

// Actualizar un bot (protegido)
router.put('/:id', authMiddleware, async (req, res) => {
  try {
    const { name, description, tone, toneNotes } = req.body;

    // Solo se actualizan los campos enviados: un cliente que no conoce el tono no lo borra
    const update = {};
    if (name !== undefined) {
      if (!String(name).trim()) {
        return res.status(400).json({ message: 'El nombre del bot es obligatorio.' });
      }
      update.name = name;
    }
    if (description !== undefined) update.description = description;
    if (tone !== undefined) {
      if (tone !== '' && !TONES.includes(tone)) {
        return res.status(400).json({ message: 'Tono no válido.' });
      }
      update.tone = tone;
    }
    if (toneNotes !== undefined) {
      if (String(toneNotes).length > 500) {
        return res.status(400).json({ message: 'Las indicaciones de tono no pueden superar 500 caracteres.' });
      }
      update.toneNotes = toneNotes;
    }

    const bot = await Bot.findOneAndUpdate(
      { _id: req.params.id, user: req.user.id },
      update,
      { new: true, runValidators: true }
    ).select('-googleCalendar.accessToken -googleCalendar.refreshToken -calendarLog');

    if (!bot) {
      return res.status(404).json({ message: 'Bot no encontrado.' });
    }

    return res.json({ bot });
  } catch (error) {
    console.error('Error al actualizar bot:', error);
    return res.status(500).json({ message: 'Error en el servidor al actualizar el bot.' });
  }
});

// Endpoint público para obtener info básica del bot (para /chat/:botId)
router.get('/public/:id', async (req, res) => {
  try {
    const bot = await Bot.findById(req.params.id).select('name description createdAt');
    if (!bot) {
      return res.status(404).json({ message: 'Bot no encontrado.' });
    }
    // retentionDays alimenta el aviso de privacidad con el valor real de conservación
    return res.json({ bot, retentionDays: getConversationTtlDays() });
  } catch (error) {
    console.error('Error en endpoint público de bot:', error);
    return res.status(500).json({ message: 'Error en el servidor.' });
  }
});

// Restaura la conversación al recargar. El sessionId actúa como capacidad secreta.
router.get('/public/:id/conversation/:sessionId', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id) || !isValidSessionId(req.params.sessionId)) {
      return res.json({ messages: [] });
    }
    const conversation = await loadConversation(req.params.id, req.params.sessionId);
    const messages = (conversation?.messages || []).map((m) => ({ role: m.role, content: m.content }));
    return res.json({ messages });
  } catch (error) {
    console.error('Error al obtener conversación:', error);
    return res.status(500).json({ message: 'Error en el servidor.' });
  }
});

// El visitante borra su conversación. Igual que al leerla, el sessionId es la credencial.
router.delete('/public/:id/conversation/:sessionId', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id) || !isValidSessionId(req.params.sessionId)) {
      return res.status(400).json({ message: 'Conversación no válida.' });
    }
    const deleted = await deleteConversation(req.params.id, req.params.sessionId);
    return res.json({ deleted });
  } catch (error) {
    console.error('Error al borrar conversación:', error);
    return res.status(500).json({ message: 'No se pudo borrar la conversación. Intenta de nuevo.' });
  }
});

// ─── Chat con el bot — Gemini + function calling de Calendar ────────────────

router.post('/:id/chat', async (req, res) => {
  try {
    const bot = await Bot.findById(req.params.id).select(
      'name description tone toneNotes googleCalendar calendarLog knowledgeDocCount'
    );
    if (!bot) {
      return res.status(404).json({ message: 'Bot no encontrado.' });
    }

    const { message, sessionId } = req.body;
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ message: 'El mensaje es obligatorio.' });
    }
    if (message.length > MAX_MESSAGE_CHARS) {
      return res.status(400).json({ message: 'El mensaje es demasiado largo.' });
    }

    // Si la conversación se va a guardar, el visitante debe haber aceptado el aviso de privacidad
    const privacyAcceptedAt = parsePrivacyAcceptance(req.body.privacyAcceptedAt);
    if (isValidSessionId(sessionId) && !privacyAcceptedAt) {
      return res.status(403).json({
        message: 'Debes aceptar el aviso de privacidad para usar el chat.',
        code: 'PRIVACY_REQUIRED',
      });
    }

    // El historial lo decide el servidor: cualquier `history` enviado por el cliente se ignora
    const conversation = isValidSessionId(sessionId)
      ? await loadConversation(bot._id, sessionId)
      : null;
    const storedCalendarActions = conversation?.calendarActions || [];
    const newCalendarActions = [];
    const { history, pinnedFirst } = buildHistoryWindow(conversation?.messages || []);

    // ── Fragmentos relevantes de los documentos (RAG) ─────────────────────
    let knowledge = '';
    let knowledgeStatus = 'none';
    if (bot.knowledgeDocCount > 0) {
      // Mensajes cortos suelen ser seguimientos: se añade el contexto de la vuelta anterior
      const trimmed = message.trim();
      let query = trimmed;
      if (trimmed.length < FOLLOW_UP_CHARS && history.length > 0) {
        const previousUser = [...history].reverse().find((m) => m.role === 'user')?.content || '';
        const lastReply = [...history].reverse().find((m) => m.role === 'assistant')?.content || '';
        query = [previousUser, lastReply.slice(0, 300), trimmed].filter(Boolean).join('\n');
      }
      try {
        const result = await retrieveContext(bot._id, query);
        knowledge = result.text;
        knowledgeStatus = result.text ? 'found' : 'empty';
      } catch (ragError) {
        console.error('Error recuperando fragmentos (se responde sin ellos):', ragError);
        knowledgeStatus = 'failed';
      }
    }

    const cal = bot.googleCalendar;
    const calConnected = cal?.connected;
    const permissions = cal?.permissions || {};

    // ── Construir system prompt ───────────────────────────────────────────
    const systemPrompt = buildSystemPrompt({
      botName: bot.name,
      description: bot.description || '',
      tone: bot.tone || '',
      toneNotes: bot.toneNotes || '',
      knowledge,
      knowledgeStatus,
      pinnedFirst,
      calendarMemory: formatCalendarMemory(storedCalendarActions),
      calendar: calConnected
        ? {
            timezone: cal.timezone,
            instructions: cal.instructions,
            customFields: cal.customFields,
            canCreateEvents: Boolean(permissions.createEvents),
          }
        : null,
    });

    // ── Construir historial de mensajes ───────────────────────────────────
    const contents = [
      ...history.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      })),
      { role: 'user', parts: [{ text: message.trim() }] },
    ];

    // ── Herramientas de calendar (si aplica) ──────────────────────────────
    const tools = calConnected ? buildCalendarTools(permissions, cal.customFields, cal.defaultDuration) : null;

    // ── Llamada a Gemini con posible function calling (máx 5 iteraciones) ─
    let finalText = '';
    let answeredBy = null;
    let currentContents = contents;
    const MAX_ITERATIONS = 5;

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const requestConfig = {
        systemInstruction: systemPrompt,
        ...(tools && { tools }),
      };

      const { response, model } = await generateWithRetry({
        contents: currentContents,
        config: requestConfig,
      });
      answeredBy = model;

      // Verificar si Gemini quiere llamar una función
      const candidate = response.candidates?.[0];
      const parts = candidate?.content?.parts || [];
      const functionCallParts = parts.filter((p) => p.functionCall);

      if (functionCallParts.length && calConnected) {
        // Ejecutar todas las llamadas de la respuesta y devolver todas sus resultados juntos
        const responseParts = [];
        for (const part of functionCallParts) {
          const { name: funcName, args: funcArgs } = part.functionCall;

          let funcResult;
          try {
            funcResult = await executeCalendarFunction(funcName, funcArgs, bot);
            const action = toCalendarAction(funcName, funcArgs, funcResult);
            if (action) newCalendarActions.push(action);
          } catch (calError) {
            console.error(`Error ejecutando ${funcName}:`, calError);
            funcResult = { error: `No se pudo ejecutar la acción: ${calError.message}` };
          }

          responseParts.push({ functionResponse: { name: funcName, response: funcResult } });
        }

        currentContents = [
          ...currentContents,
          { role: 'model', parts },
          { role: 'user', parts: responseParts },
        ];
        continue;
      }

      // Sin function call — obtener texto final
      finalText =
        response.text ??
        parts.find((p) => p.text)?.text ??
        '';
      break;
    }

    if (!finalText) {
      console.error(`Chat del bot ${bot._id}: el modelo ${answeredBy} no devolvió texto.`);
      return res.status(502).json({ message: CHAT_ERROR_MESSAGES.generic, retryable: true });
    }

    // Solo se guardan turnos exitosos: un error nunca entra al historial
    if (isValidSessionId(sessionId)) {
      try {
        await saveTurn({
          botId: bot._id,
          sessionId,
          userText: message.trim(),
          assistantText: finalText.trim(),
          model: answeredBy,
          privacyAcceptedAt,
          calendarActions: newCalendarActions,
        });
      } catch (saveError) {
        console.error('No se pudo guardar el turno de la conversación:', saveError);
      }
    }

    return res.json({ reply: finalText.trim() });
  } catch (error) {
    // El detalle técnico solo queda en el log del servidor; el visitante recibe un mensaje claro
    console.error('Error en chat del bot:', error);

    if (error?.status === 429) {
      return res.status(429).json({ message: CHAT_ERROR_MESSAGES.busy, retryable: true });
    }
    if (error?.status === 500 || error?.status === 503 || error?.status === 504) {
      return res.status(503).json({ message: CHAT_ERROR_MESSAGES.unavailable, retryable: true });
    }
    return res.status(500).json({ message: CHAT_ERROR_MESSAGES.generic, retryable: true });
  }
});

module.exports = router;
