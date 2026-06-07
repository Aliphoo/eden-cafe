const {
  httpFunction,
} = require('../security/authz');
const {
  SERVICE_TYPE,
  OPEN_MINUTES,
  CLOSE_MINUTES,
  SLOT_MINUTES,
  normalizeBranchId,
  normalizeTiming,
  normalizeDate,
  normalizeDuration,
  normalizePackageCode,
  timeFromMinutes,
  generateSlotKeys,
} = require('../shared/time');
const {
  loadLaneResources,
  readSlotLocksOutsideTransaction,
  isActiveLock,
} = require('../shared/locks');

async function countAvailableLanes(db, branchId, slotKeys) {
  const lanes = await loadLaneResources(db, branchId);
  let availableCount = 0;
  for (const lane of lanes) {
    const locks = await readSlotLocksOutsideTransaction(db, branchId, lane.resource_id, slotKeys);
    const conflict = locks.find(lock => lock.snap.exists && isActiveLock(lock.data, new Date()));
    if (!conflict) availableCount += 1;
  }
  return { availableCount, laneCount: lanes.length };
}

async function suggestedTimes(db, branchId, bookingDate, durationMinutes, requestedStartTime = '') {
  const suggestions = [];
  for (let minute = OPEN_MINUTES; minute + durationMinutes <= CLOSE_MINUTES; minute += SLOT_MINUTES) {
    const startTime = timeFromMinutes(minute);
    if (requestedStartTime && startTime === requestedStartTime) continue;
    const timing = normalizeTiming({
      booking_date: bookingDate,
      start_time: startTime,
      duration_minutes: durationMinutes,
      package_code: normalizePackageCode(durationMinutes),
    });
    const { availableCount } = await countAvailableLanes(db, branchId, generateSlotKeys(timing));
    if (availableCount > 0) suggestions.push(startTime);
    if (suggestions.length >= 8) break;
  }
  return suggestions;
}

const getArcheryAvailability = httpFunction(async ({ db, data }) => {
  const branchId = normalizeBranchId(data.branch_id);
  const bookingDate = normalizeDate(data.booking_date || data.date);
  const durationMinutes = normalizeDuration(data.duration_minutes || data.durationMinutes || data.package_minutes || 60);
  const timing = normalizeTiming({
    booking_date: bookingDate,
    start_time: data.start_time || data.startTime || data.time,
    duration_minutes: durationMinutes,
    package_code: data.package_code || data.packageCode,
  });
  const slotKeys = generateSlotKeys(timing);
  const { availableCount, laneCount } = await countAvailableLanes(db, branchId, slotKeys);

  return {
    service_type: SERVICE_TYPE,
    branch_id: branchId,
    timezone: 'Asia/Bangkok',
    booking_date: timing.booking_date,
    start_time: timing.start_time,
    end_time: timing.end_time,
    duration_minutes: timing.duration_minutes,
    available: availableCount > 0,
    available_lane_count: availableCount,
    total_lane_count: laneCount,
    suggested_start_times: availableCount > 0
      ? []
      : await suggestedTimes(db, branchId, timing.booking_date, timing.duration_minutes, timing.start_time),
    reason: availableCount > 0 ? '' : 'NO_LANE_AVAILABLE',
  };
}, {
  name: 'getArcheryAvailability',
  methods: ['GET', 'POST'],
  optionalAuth: true,
});

module.exports = {
  getArcheryAvailability,
  countAvailableLanes,
};
