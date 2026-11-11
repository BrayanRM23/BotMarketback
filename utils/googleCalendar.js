const { google } = require('googleapis');
const { encrypt, decrypt } = require('./encrypt');

// Google Calendar API requires RFC 3339 format with timezone (e.g. "2026-04-28T10:00:00Z")
// Gemini sometimes omits the timezone suffix — this adds 'Z' (UTC) as a safe fallback
function toRFC3339(dateStr) {
  if (!dateStr) return dateStr;
  if (/Z$|[+-]\d{2}:\d{2}$/.test(dateStr)) return dateStr;
  return dateStr + 'Z';
}

function getOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

function getAuthorizationUrl(botId) {
  const oauth2Client = getOAuth2Client();
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/tasks',
    ],
    state: botId,
  });
}

async function exchangeCodeForTokens(code) {
  const oauth2Client = getOAuth2Client();
  const { tokens } = await oauth2Client.getToken(code);
  return {
    accessToken: encrypt(tokens.access_token),
    refreshToken: encrypt(tokens.refresh_token),
    expiryDate: tokens.expiry_date,
  };
}

function getAuthenticatedClient(calendarData) {
  const oauth2Client = getOAuth2Client();
  oauth2Client.setCredentials({
    access_token: decrypt(calendarData.accessToken),
    refresh_token: decrypt(calendarData.refreshToken),
    expiry_date: calendarData.expiryDate,
  });
  return oauth2Client;
}

async function listCalendars(auth) {
  const calendar = google.calendar({ version: 'v3', auth });
  const res = await calendar.calendarList.list();
  return (res.data.items || []).map((c) => ({
    id: c.id,
    summary: c.summary,
    primary: c.primary || false,
  }));
}

async function checkFreeBusy(auth, calendarId, startDateTime, endDateTime) {
  const calendar = google.calendar({ version: 'v3', auth });
  const res = await calendar.freebusy.query({
    requestBody: {
      timeMin: toRFC3339(startDateTime),
      timeMax: toRFC3339(endDateTime),
      items: [{ id: calendarId }],
    },
  });
  const busy = res.data.calendars?.[calendarId]?.busy || [];
  return { busy, isFree: busy.length === 0 };
}

async function listEvents(auth, calendarId, timeMin, timeMax, maxResults = 10) {
  const calendar = google.calendar({ version: 'v3', auth });
  const res = await calendar.events.list({
    calendarId,
    timeMin: toRFC3339(timeMin),
    timeMax: toRFC3339(timeMax),
    maxResults,
    singleEvents: true,
    orderBy: 'startTime',
  });
  return (res.data.items || []).map((e) => ({
    id: e.id,
    summary: e.summary,
    description: e.description,
    start: e.start?.dateTime || e.start?.date,
    end: e.end?.dateTime || e.end?.date,
    status: e.status,
  }));
}

// Si se pasa `id` y el evento ya existe (409), se devuelve el existente en vez de fallar
async function createEvent(auth, calendarId, eventData) {
  const calendar = google.calendar({ version: 'v3', auth });
  const requestBody = {
    ...(eventData.id && { id: eventData.id }),
    summary: eventData.summary,
    description: eventData.description || '',
    start: { dateTime: toRFC3339(eventData.startDateTime), timeZone: eventData.timeZone || 'UTC' },
    end: { dateTime: toRFC3339(eventData.endDateTime), timeZone: eventData.timeZone || 'UTC' },
  };

  let data;
  let alreadyExisted = false;
  try {
    ({ data } = await calendar.events.insert({ calendarId, requestBody }));
  } catch (error) {
    if (!eventData.id || error.code !== 409) throw error;
    ({ data } = await calendar.events.get({ calendarId, eventId: eventData.id }));
    alreadyExisted = true;

    // Google conserva los eventos borrados como 'cancelled': si el usuario vuelve a pedir
    // ese horario, hay que restaurarlo en vez de reportarlo como creado.
    if (data.status === 'cancelled') {
      ({ data } = await calendar.events.patch({
        calendarId,
        eventId: eventData.id,
        requestBody: { ...requestBody, id: undefined, status: 'confirmed' },
      }));
      alreadyExisted = false;
    }
  }

  return {
    id: data.id,
    summary: data.summary,
    start: data.start?.dateTime,
    end: data.end?.dateTime,
    htmlLink: data.htmlLink,
    alreadyExisted,
  };
}

async function updateEvent(auth, calendarId, eventId, updates) {
  const calendar = google.calendar({ version: 'v3', auth });
  const res = await calendar.events.patch({
    calendarId,
    eventId,
    requestBody: {
      ...(updates.summary && { summary: updates.summary }),
      ...(updates.description !== undefined && { description: updates.description }),
      ...(updates.startDateTime && {
        start: { dateTime: toRFC3339(updates.startDateTime), timeZone: updates.timeZone || 'UTC' },
      }),
      ...(updates.endDateTime && {
        end: { dateTime: toRFC3339(updates.endDateTime), timeZone: updates.timeZone || 'UTC' },
      }),
    },
  });
  return {
    id: res.data.id,
    summary: res.data.summary,
    start: res.data.start?.dateTime,
    end: res.data.end?.dateTime,
  };
}

// 404/410 significa que el evento ya no existe: se considera borrado
async function deleteEvent(auth, calendarId, eventId) {
  const calendar = google.calendar({ version: 'v3', auth });
  try {
    await calendar.events.delete({ calendarId, eventId });
  } catch (error) {
    if (error.code === 404 || error.code === 410) {
      return { deleted: true, eventId, alreadyDeleted: true };
    }
    throw error;
  }
  return { deleted: true, eventId, alreadyDeleted: false };
}

module.exports = {
  getAuthorizationUrl,
  exchangeCodeForTokens,
  getAuthenticatedClient,
  listCalendars,
  checkFreeBusy,
  listEvents,
  createEvent,
  updateEvent,
  deleteEvent,
};
