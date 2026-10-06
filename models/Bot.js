const mongoose = require('mongoose');

const calendarLogSchema = new mongoose.Schema(
  {
    action: { type: String, enum: ['create', 'edit', 'delete', 'list', 'check'], required: true },
    eventId: { type: String, default: '' },
    summary: { type: String, default: '' },
    clientData: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

const calendarPermissionsSchema = new mongoose.Schema(
  {
    viewAvailability: { type: Boolean, default: false },
    listEvents: { type: Boolean, default: false },
    createEvents: { type: Boolean, default: false },
    editEvents: { type: Boolean, default: false },
    deleteEvents: { type: Boolean, default: false },
    createTasks: { type: Boolean, default: false },
  },
  { _id: false }
);

const googleCalendarSchema = new mongoose.Schema(
  {
    connected: { type: Boolean, default: false },
    accessToken: { type: String, default: '' },
    refreshToken: { type: String, default: '' },
    expiryDate: { type: Number, default: 0 },
    calendarId: { type: String, default: 'primary' },
    timezone: { type: String, default: 'America/Bogota' },
    permissions: { type: calendarPermissionsSchema, default: () => ({}) },
    instructions: { type: String, default: '' },
    customFields: { type: [String], default: [] },
    defaultDuration: { type: Number, default: 60 },
  },
  { _id: false }
);

const botSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      default: '',
    },
    totalConversations: {
      type: Number,
      default: 0,
    },
    mostAskedQuestions: {
      type: [String],
      default: [],
    },
    googleCalendar: {
      type: googleCalendarSchema,
      default: () => ({}),
    },
    calendarLog: {
      type: [calendarLogSchema],
      default: [],
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('Bot', botSchema);
