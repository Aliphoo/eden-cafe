import assert from 'node:assert/strict';

const SLOT_MINUTES = 15;
const OPEN_MINUTES = 10 * 60;
const CLOSE_MINUTES = 20 * 60;

function timeFromMinutes(value) {
  const minutes = Math.max(0, Math.floor(Number(value) || 0));
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function minutesFromTime(value) {
  const [hours, minutes] = String(value || '00:00').split(':').map(Number);
  return (hours * 60) + minutes;
}

function laneId(number) {
  return `LANE_${String(number).padStart(2, '0')}`;
}

function slotId(lane, date, minute) {
  return `${lane}_${date.replace(/-/g, '')}_${timeFromMinutes(minute).replace(':', '')}`;
}

function slots(lane, date, startTime, durationMinutes) {
  const start = minutesFromTime(startTime);
  const end = start + durationMinutes;
  assert(start >= OPEN_MINUTES, 'start is inside business hours');
  assert(end <= CLOSE_MINUTES, 'end is inside business hours');
  assert.equal(start % SLOT_MINUTES, 0, 'start aligns to a 15-minute slot');
  const ids = [];
  for (let minute = start; minute < end; minute += SLOT_MINUTES) {
    ids.push(slotId(lane, date, minute));
  }
  return ids;
}

function isActive(lock, now) {
  if (!lock) return false;
  if (lock.status === 'HELD') return !lock.expiresAt || lock.expiresAt > now;
  return lock.status === 'CONFIRMED' || lock.status === 'CHECKED_IN';
}

class ArcheryLockBook {
  constructor(now = Date.now()) {
    this.now = now;
    this.locks = new Map();
    this.bookings = new Map();
    this.payments = new Map();
  }

  create({ bookingId, lane, date, startTime, durationMinutes, status = 'HELD', holdMs = 10 * 60 * 1000 }) {
    const ids = slots(lane, date, startTime, durationMinutes);
    const conflict = ids.find(id => isActive(this.locks.get(id), this.now));
    if (conflict) return { ok: false, status: 409, conflict };
    const start = minutesFromTime(startTime);
    const booking = {
      id: bookingId,
      lane,
      date,
      startTime,
      endTime: timeFromMinutes(start + durationMinutes),
      status,
      payment: 'PENDING',
    };
    this.bookings.set(bookingId, booking);
    ids.forEach(id => this.locks.set(id, {
      id,
      bookingId,
      status,
      expiresAt: status === 'HELD' ? this.now + holdMs : null,
    }));
    return { ok: true, booking };
  }

  confirm(bookingId) {
    const booking = this.bookings.get(bookingId);
    assert(booking, 'booking exists');
    slots(booking.lane, booking.date, booking.startTime, minutesFromTime(booking.endTime) - minutesFromTime(booking.startTime))
      .forEach(id => {
        const lock = this.locks.get(id);
        assert.equal(lock?.bookingId, bookingId, 'lock belongs to booking');
        assert(isActive(lock, this.now), 'lock is active before confirm');
        lock.status = 'CONFIRMED';
        lock.expiresAt = null;
      });
    booking.status = 'CONFIRMED';
  }

  extend(bookingId, newEndTime) {
    const booking = this.bookings.get(bookingId);
    const oldEnd = minutesFromTime(booking.endTime);
    const newEnd = minutesFromTime(newEndTime);
    const extraIds = [];
    for (let minute = oldEnd; minute < newEnd; minute += SLOT_MINUTES) {
      extraIds.push(slotId(booking.lane, booking.date, minute));
    }
    const conflict = extraIds.find(id => isActive(this.locks.get(id), this.now));
    if (conflict) return { ok: false, status: 409, conflict };
    extraIds.forEach(id => this.locks.set(id, { id, bookingId, status: 'CONFIRMED' }));
    booking.endTime = newEndTime;
    return { ok: true };
  }

  move(bookingId, newLane) {
    const booking = this.bookings.get(bookingId);
    const duration = minutesFromTime(booking.endTime) - minutesFromTime(booking.startTime);
    const newIds = slots(newLane, booking.date, booking.startTime, duration);
    const conflict = newIds.find(id => isActive(this.locks.get(id), this.now));
    if (conflict) return { ok: false, status: 409, conflict };
    slots(booking.lane, booking.date, booking.startTime, duration)
      .forEach(id => this.locks.set(id, { ...this.locks.get(id), status: 'RELEASED' }));
    newIds.forEach(id => this.locks.set(id, { id, bookingId, status: 'CONFIRMED' }));
    booking.lane = newLane;
    return { ok: true };
  }

  recordCounterPayment(bookingId, idempotencyKey) {
    const booking = this.bookings.get(bookingId);
    assert(booking, 'booking exists before payment');
    if (this.payments.has(idempotencyKey)) return { ok: true, duplicate: true };
    if (booking.payment === 'PAID_ONLINE' || booking.payment === 'PAID_COUNTER') {
      return { ok: false, status: 409 };
    }
    this.payments.set(idempotencyKey, { bookingId });
    booking.payment = 'PAID_COUNTER';
    return { ok: true, duplicate: false };
  }
}

const book = new ArcheryLockBook(Date.parse('2026-06-07T03:00:00Z'));

const online = book.create({ bookingId: 'online-1', lane: laneId(3), date: '2026-06-08', startTime: '13:00', durationMinutes: 60 });
assert.equal(online.ok, true, 'online booking can hold Lane 3 13:00-14:00');
const walkInSameSlot = book.create({ bookingId: 'walkin-1', lane: laneId(3), date: '2026-06-08', startTime: '13:00', durationMinutes: 60, status: 'CONFIRMED' });
assert.equal(walkInSameSlot.status, 409, 'walk-in is rejected while online hold is active');

book.confirm('online-1');
const secondConfirmed = book.create({ bookingId: 'walkin-2', lane: laneId(3), date: '2026-06-08', startTime: '13:15', durationMinutes: 60, status: 'CONFIRMED' });
assert.equal(secondConfirmed.status, 409, 'overlapping confirmed booking is rejected');

const expiredBook = new ArcheryLockBook(Date.parse('2026-06-07T03:00:00Z'));
assert.equal(expiredBook.create({ bookingId: 'hold-old', lane: laneId(4), date: '2026-06-08', startTime: '15:00', durationMinutes: 60, holdMs: 1 }).ok, true);
expiredBook.now += 2;
assert.equal(expiredBook.create({ bookingId: 'hold-new', lane: laneId(4), date: '2026-06-08', startTime: '15:00', durationMinutes: 60 }).ok, true, 'expired hold frees the slot');

const extendBook = new ArcheryLockBook();
assert.equal(extendBook.create({ bookingId: 'a', lane: laneId(5), date: '2026-06-08', startTime: '10:00', durationMinutes: 60, status: 'CONFIRMED' }).ok, true);
assert.equal(extendBook.create({ bookingId: 'b', lane: laneId(5), date: '2026-06-08', startTime: '11:00', durationMinutes: 60, status: 'CONFIRMED' }).ok, true);
assert.equal(extendBook.create({ bookingId: 'c', lane: laneId(6), date: '2026-06-08', startTime: '10:00', durationMinutes: 60, status: 'CONFIRMED' }).ok, true);
assert.equal(extendBook.extend('a', '11:30').status, 409, 'extend rejects when it hits another booking');
assert.equal(extendBook.move('a', laneId(6)).status, 409, 'move rejects when target lane/time is occupied');
assert.equal(extendBook.move('a', laneId(7)).ok, true, 'move succeeds to a free lane');

const paymentBook = new ArcheryLockBook();
paymentBook.create({ bookingId: 'paid-online', lane: laneId(7), date: '2026-06-08', startTime: '12:00', durationMinutes: 60, status: 'CONFIRMED' });
paymentBook.bookings.get('paid-online').payment = 'PAID_ONLINE';
assert.equal(paymentBook.recordCounterPayment('paid-online', 'counter-ref').status, 409, 'counter payment rejects after online payment');

console.log('archery lock tests passed');
