const express = require('express');
const { GoogleGenAI } = require('@google/genai');
const Bot = require('../models/Bot');
const authMiddleware = require('../middleware/authMiddleware');
const gcal = require('../utils/googleCalendar');

const router = express.Router();
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

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
        summary: args.summary,
        description: args.description || '',
        startDateTime: args.startDateTime,
        endDateTime: args.endDateTime,
        timeZone: timezone,
      });
      result = { success: true, event };
      logEntry = { action: 'create', eventId: event.id, summary: event.summary };
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
      await gcal.deleteEvent(auth, calendarId, args.eventId);
      result = { success: true, message: 'Evento eliminado correctamente.' };
      logEntry = { action: 'delete', eventId: args.eventId, summary: args.summary || '' };
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
    const { name, description } = req.body;

    const bot = await Bot.findOneAndUpdate(
      { _id: req.params.id, user: req.user.id },
      { name, description },
      { new: true }
    );

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
    return res.json({ bot });
  } catch (error) {
    console.error('Error en endpoint público de bot:', error);
    return res.status(500).json({ message: 'Error en el servidor.' });
  }
});

// ─── Chat con el bot — Gemini + function calling de Calendar ────────────────

router.post('/:id/chat', async (req, res) => {
  try {
    const bot = await Bot.findById(req.params.id).select(
      'name description googleCalendar calendarLog'
    );
    if (!bot) {
      return res.status(404).json({ message: 'Bot no encontrado.' });
    }

    const { message, history = [] } = req.body;
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ message: 'El mensaje es obligatorio.' });
    }

    // ── Construir system prompt ───────────────────────────────────────────
    const context = (bot.description || '').trim();
    let systemPrompt = context
      ? `Eres el asistente "${bot.name}". Actúa según esta base de conocimiento:\n\n${context}\n\nResponde siempre en el mismo idioma que el usuario, de forma clara y útil.`
      : `Eres el asistente "${bot.name}". Responde de forma clara y útil en el mismo idioma que el usuario.`;

    const cal = bot.googleCalendar;
    const calConnected = cal?.connected;
    const permissions = cal?.permissions || {};

    if (calConnected) {
      const timezone = cal.timezone || 'America/Bogota';
      const today = new Date().toLocaleString('es-CO', { timeZone: timezone });
      systemPrompt += `\n\n--- Google Calendar ---\nTienes acceso al calendario del negocio. Fecha y hora actual: ${today} (zona horaria: ${timezone}).`;

      if (cal.instructions?.trim()) {
        systemPrompt += `\n\nInstrucciones específicas para citas/eventos:\n${cal.instructions.trim()}`;
      }

      if (cal.customFields?.length) {
        systemPrompt += `\n\nAntes de crear cualquier evento DEBES recolectar estos datos del cliente: ${cal.customFields.join(', ')}.`;
      }

      systemPrompt +=
        '\n\nNUNCA crees ni elimines eventos sin pedir confirmación explícita al usuario primero.';
    }

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
    let currentContents = contents;
    const MAX_ITERATIONS = 5;

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const requestConfig = {
        systemInstruction: systemPrompt,
        ...(tools && { tools }),
      };

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: currentContents,
        config: requestConfig,
      });

      // Verificar si Gemini quiere llamar una función
      const candidate = response.candidates?.[0];
      const parts = candidate?.content?.parts || [];
      const functionCallPart = parts.find((p) => p.functionCall);

      if (functionCallPart && calConnected) {
        const { name: funcName, args: funcArgs } = functionCallPart.functionCall;

        let funcResult;
        try {
          funcResult = await executeCalendarFunction(funcName, funcArgs, bot);
        } catch (calError) {
          console.error(`Error ejecutando ${funcName}:`, calError);
          funcResult = { error: `No se pudo ejecutar la acción: ${calError.message}` };
        }

        // Agregar respuesta del modelo + resultado de la función al historial
        currentContents = [
          ...currentContents,
          { role: 'model', parts },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  name: funcName,
                  response: funcResult,
                },
              },
            ],
          },
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
      return res.status(502).json({ message: 'No se pudo generar una respuesta.' });
    }

    await Bot.findByIdAndUpdate(req.params.id, { $inc: { totalConversations: 1 } });

    return res.json({ reply: finalText.trim() });
  } catch (error) {
    console.error('Error en chat del bot:', error);
    return res.status(500).json({
      message: error?.message?.includes('API key')
        ? 'Configura GEMINI_API_KEY en el servidor.'
        : 'Error al generar la respuesta.',
    });
  }
});

module.exports = router;
