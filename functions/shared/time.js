const { Timestamp } = require('./firestore');

const TIMEZONE = 'Asia/Bangkok';
const SERVICE_TYPE = 'ARCHERY';
const RESOURCE_TYPE_ID = 'ARCHERY_LANE';
const OPEN_MINUTES = 10 * 60;
const CLOSE_MINUTES = 20 * 60;
const SLOT_MINUTES = 15;
const HOLD_MINUTES = 10;
const VALID_DURATIONS = new Set([60, 120, 180]);

function apiError(code, statusCode, message, details = {}) {
  const error = new Error(message || code);
  error.code = code;
  error.statusCode = statusCode;
  error.details = details;
  return error;
}

function cleanString(value, maxLength = 200) {
  if (value == null) return '';
  return String(value).trim().slice(0, maxLength);
}

function normalizeBranchId(value) {
  const branchId = cleanString(value, 80);
  if (!branchId) throw apiError('BRANCH_REQUIRED', 400, 'branch_id is required');
  return branchId;
}

function normalizeDate(value) {
  const date = cleanString(value, 20);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw apiError('INVALID_DATE_FORMAT', 400, 'booking_date must be YYYY-MM-DD');
  }
  const [year, month, day] = date.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    Number.isNaN(parsed.getTime())
    || parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) {
    throw apiError('INVALID_DATE_FORMAT', 400, 'booking_date is invalid');
  }
  return date;
}

function normalizeTime(value) {
  const time = cleanString(value, 10).replace('.', ':');
  if (!/^\d{2}:\d{2}$/.test(time)) {
    throw apiError('INVALID_TIME_FORMAT', 400, 'start_time must be HH:mm or HH.mm');
  }
  const [hours, minutes] = time.split(':').map(Number);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    throw apiError('INVALID_TIME_FORMAT', 400, 'start_time is invalid');
  }
  return time;
}

function minutesFromTime(time) {
  const normalized = normalizeTime(time);
  const [hours, minutes] = normalized.split(':').map(Number);
  return (hours * 60) + minutes;
}

function timeFromMinutes(value) {
  const minutes = Math.floor(Number(value) || 0);
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

function normalizeDuration(value) {
  const duration = Math.floor(Number(value) || 0);
  if (!VALID_DURATIONS.has(duration)) {
    throw apiError('INVALID_DURATION', 400, 'duration_minutes must be 60, 120, or 180');
  }
  return duration;
}

function normalizePackageCode(durationMinutes, rawPackageCode = '') {
  const packageCode = cleanString(rawPackageCode, 60).toUpperCase();
  if (packageCode) return packageCode;
  return `ARCHERY_${durationMinutes}`;
}

function dateFromBangkok(date, time) {
  return new Date(`${date}T${time}:00+07:00`);
}

function timestampFromBangkok(date, time) {
  return Timestamp.fromDate(dateFromBangkok(date, time));
}

function normalizeTiming(raw = {}) {
  const bookingDate = normalizeDate(raw.booking_date || raw.date);
  const startTime = normalizeTime(raw.start_time || raw.startTime || raw.time);
  const durationMinutes = normalizeDuration(raw.duration_minutes || raw.durationMinutes || raw.package_minutes || raw.packageMinutes);
  const startMinutes = minutesFromTime(startTime);
  const endMinutes = startMinutes + durationMinutes;
  if (
    startMinutes < OPEN_MINUTES
    || endMinutes > CLOSE_MINUTES
    || startMinutes % 60 !== 0
    || endMinutes % SLOT_MINUTES !== 0
  ) {
    throw apiError('OUTSIDE_OPERATING_HOURS', 400, 'Archery start time must be 10.00-19.00 on the hour and finish by 20.00');
  }
  return {
    booking_date: bookingDate,
    start_time: startTime,
    end_time: timeFromMinutes(endMinutes),
    start_minutes: startMinutes,
    end_minutes: endMinutes,
    duration_minutes: durationMinutes,
    package_code: normalizePackageCode(durationMinutes, raw.package_code || raw.packageCode),
  };
}

function slotKeyFromMinutes(date, minutes) {
  return `${date}T${timeFromMinutes(minutes)}+07:00`;
}

function generateSlotKeys(timing) {
  const keys = [];
  for (let minute = timing.start_minutes; minute < timing.end_minutes; minute += SLOT_MINUTES) {
    keys.push(slotKeyFromMinutes(timing.booking_date, minute));
  }
  return keys;
}

function timingFromBooking(booking = {}) {
  return normalizeTiming({
    booking_date: booking.booking_date || booking.date,
    start_time: booking.start_time || booking.startTime,
    duration_minutes: booking.duration_minutes || booking.package_minutes,
    package_code: booking.package_code,
  });
}

function timestampToDate(value) {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate();
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

module.exports = {
  TIMEZONE,
  SERVICE_TYPE,
  RESOURCE_TYPE_ID,
  OPEN_MINUTES,
  CLOSE_MINUTES,
  SLOT_MINUTES,
  HOLD_MINUTES,
  apiError,
  cleanString,
  normalizeBranchId,
  normalizeDate,
  normalizeTime,
  normalizeDuration,
  normalizePackageCode,
  normalizeTiming,
  minutesFromTime,
  timeFromMinutes,
  timestampFromBangkok,
  dateFromBangkok,
  slotKeyFromMinutes,
  generateSlotKeys,
  timingFromBooking,
  timestampToDate,
};
