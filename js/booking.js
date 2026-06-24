import './page-telemetry.js';
import { clearSkeleton, renderSkeleton } from './ui-skeleton.js';

document.addEventListener('DOMContentLoaded', async () => {
    const bookingTypeRadios = document.querySelectorAll('input[name="booking-type-radio"]');
    const tableSelectionGroup = document.getElementById('table-selection-group');
    const roomSelectionGroup = document.getElementById('room-selection-group');
    const addonsGroup = document.getElementById('addons-group');
    const arrivalTimeGroup = document.getElementById('table-arrival-time-group');
    const arrivalTimeSelect = document.getElementById('arrival-time');
    const guestsInput = document.getElementById('guests');
    const notesInput = document.getElementById('booking-notes');
    const roomSelect = document.getElementById('room-type');
    const roomPreviewContainer = document.getElementById('room-preview-container');
    const roomPreviewImg = document.getElementById('room-preview-img');
    const startTimeSelect = document.getElementById('start-time');
    const endTimeSelect = document.getElementById('end-time');
    const summaryDiv = document.getElementById('booking-summary');
    const summaryHours = document.getElementById('summary-hours');
    const summaryPrice = document.getElementById('summary-room-price');
    const bookingForm = document.querySelector('.booking-form');
    const timeSelectionContainer = document.getElementById('time-selection-container');

    let roomsMap = {};

    function setRoomSkeleton(isLoading) {
        if (!roomSelectionGroup) return;
        let skeleton = document.getElementById('room-loading-skeleton');
        if (isLoading) {
            if (!skeleton) {
                skeleton = document.createElement('div');
                skeleton.id = 'room-loading-skeleton';
                skeleton.className = 'room-loading-skeleton';
                roomSelectionGroup.appendChild(skeleton);
            }
            renderSkeleton(skeleton, 'summary', { rows: 3 });
            return;
        }
        if (skeleton) {
            clearSkeleton(skeleton);
            skeleton.remove();
        }
    }

    function todayISO() {
        const now = new Date();
        now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
        return now.toISOString().slice(0, 10);
    }

    function saveBookingHistory(booking) {
        try {
            const history = JSON.parse(localStorage.getItem('eden_booking_history') || '[]');
            const nextHistory = [booking, ...(Array.isArray(history) ? history : [])].slice(0, 20);
            localStorage.setItem('eden_booking_history', JSON.stringify(nextHistory));
        } catch (_) {
            localStorage.setItem('eden_booking_history', JSON.stringify([booking]));
        }
    }

    function getSelectedBookingType() {
        const checked = document.querySelector('input[name="booking-type-radio"]:checked');
        return checked ? checked.value : 'table';
    }

    function applyInitialBookingTypeFromUrl() {
        const params = new URLSearchParams(window.location.search);
        const requestedType = String(params.get('type') || '').toLowerCase();
        if (!['room', 'table'].includes(requestedType)) return;

        const radio = document.querySelector(`input[name="booking-type-radio"][value="${requestedType}"]`);
        if (radio) radio.checked = true;
    }

    function getMaxTablesAllowed(guests) {
        if (guests >= 1 && guests <= 4) return 1;
        if (guests >= 5 && guests <= 8) return 2;
        if (guests >= 9 && guests <= 12) return 3;
        return 0;
    }

    function setRequired(el, required) {
        if (el) el.required = required;
    }

    function waitForWindowFunction(name, timeoutMs = 5000) {
        if (typeof window[name] === 'function') return Promise.resolve(window[name]);
        return new Promise(resolve => {
            const startedAt = Date.now();
            const timer = window.setInterval(() => {
                if (typeof window[name] === 'function') {
                    window.clearInterval(timer);
                    resolve(window[name]);
                } else if (Date.now() - startedAt >= timeoutMs) {
                    window.clearInterval(timer);
                    resolve(null);
                }
            }, 100);
        });
    }

    function handleBookingTypeChange() {
        const bookingType = getSelectedBookingType();
        const isRoom = bookingType === 'room';

        if (tableSelectionGroup) tableSelectionGroup.style.display = isRoom ? 'none' : 'block';
        if (arrivalTimeGroup) arrivalTimeGroup.style.display = isRoom ? 'none' : 'block';
        if (roomSelectionGroup) roomSelectionGroup.style.display = isRoom ? 'block' : 'none';
        if (addonsGroup) addonsGroup.style.display = isRoom ? 'block' : 'none';
        if (timeSelectionContainer) timeSelectionContainer.style.display = isRoom ? 'block' : 'none';

        setRequired(roomSelect, isRoom);
        setRequired(startTimeSelect, isRoom);
        setRequired(endTimeSelect, isRoom);
        setRequired(arrivalTimeSelect, !isRoom);

        if (roomPreviewContainer && !isRoom) roomPreviewContainer.style.display = 'none';
        if (summaryDiv && !isRoom) summaryDiv.style.display = 'none';
        if (isRoom) calculatePrice();
    }

    async function loadRooms() {
        if (!roomSelect) return;
        setRoomSkeleton(true);
        const fetchRoomsFromCloud = await waitForWindowFunction('fetchRoomsFromCloud');
        if (typeof fetchRoomsFromCloud !== 'function') {
            setRoomSkeleton(false);
            return;
        }

        try {
            const rooms = await fetchRoomsFromCloud();
            roomSelect.innerHTML = '<option value="" disabled selected>Select Room / เลือกห้อง</option>';
            rooms.forEach(room => {
                roomsMap[room.id] = room;
                const opt = document.createElement('option');
                opt.value = room.id;
                opt.textContent = room.name + ' (' + room.price + ' THB/hr)';
                roomSelect.appendChild(opt);
            });
        } catch (err) {
            console.error('Error loading rooms:', err);
            roomSelect.innerHTML = '<option value="" disabled selected>Error loading rooms</option>';
        } finally {
            setRoomSkeleton(false);
        }
    }

    function calculatePrice() {
        if (!summaryDiv || getSelectedBookingType() !== 'room') {
            if (summaryDiv) summaryDiv.style.display = 'none';
            return;
        }

        const start = startTimeSelect?.value;
        const end = endTimeSelect?.value;
        const roomId = roomSelect?.value;

        if (start && end && roomId && roomsMap[roomId]) {
            const startHour = Number(start.split(':')[0]) + (start.split(':')[1] === '30' ? 0.5 : 0);
            const endHour = Number(end.split(':')[0]) + (end.split(':')[1] === '30' ? 0.5 : 0);
            const duration = endHour - startHour;

            if (duration <= 0) {
                summaryDiv.style.display = 'none';
                return;
            }

            const pricePerHour = Number(roomsMap[roomId].price) || 0;
            const totalPrice = duration * pricePerHour;
            if (summaryHours) summaryHours.textContent = duration;
            if (summaryPrice) summaryPrice.textContent = totalPrice.toLocaleString();
            summaryDiv.style.display = 'block';
        } else {
            summaryDiv.style.display = 'none';
        }
    }

    function getTableSelection() {
        if (window.EdenTableMap && typeof window.EdenTableMap.getSelection === 'function') {
            return window.EdenTableMap.getSelection();
        }
        return { selectedIds: [], selectedTables: [], tableNo: '', tableZone: '', canSubmit: false, overLimit: false };
    }

    bookingTypeRadios.forEach(radio => radio.addEventListener('change', handleBookingTypeChange));

    if (roomSelect) {
        roomSelect.addEventListener('change', () => {
            const selectedRoom = roomsMap[roomSelect.value];
            if (selectedRoom && selectedRoom.imageUrl && roomPreviewImg && roomPreviewContainer) {
                roomPreviewImg.src = selectedRoom.imageUrl;
                roomPreviewContainer.style.display = 'block';
            } else if (roomPreviewContainer) {
                roomPreviewContainer.style.display = 'none';
            }
            calculatePrice();
        });
    }

    if (startTimeSelect) startTimeSelect.addEventListener('change', calculatePrice);
    if (endTimeSelect) endTimeSelect.addEventListener('change', calculatePrice);

    if (guestsInput) {
        guestsInput.addEventListener('input', () => {
            if (Number(guestsInput.value) < 1) guestsInput.value = 1;
        });
    }

    applyInitialBookingTypeFromUrl();
    handleBookingTypeChange();
    await loadRooms();
    handleBookingTypeChange();
    const dateInput = document.getElementById('date');
    if (dateInput) dateInput.min = todayISO();

    if (!bookingForm) return;

    bookingForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        const name = document.getElementById('name')?.value.trim() || '';
        const phone = document.getElementById('phone')?.value.trim() || '';
        const guests = Number(document.getElementById('guests')?.value || 1);
        const date = document.getElementById('date')?.value || '';
        const startTime = startTimeSelect?.value || '';
        const endTime = endTimeSelect?.value || '';
        const arrivalTime = arrivalTimeSelect?.value || '';
        const note = notesInput?.value.trim() || '';
        const bookingType = getSelectedBookingType();

        if (!name || !phone || !date || !guests) {
            alert('กรุณากรอกข้อมูลให้ครบถ้วน');
            return;
        }

        if (date < todayISO()) {
            alert('กรุณาเลือกวันที่วันนี้หรือวันถัดไป');
            return;
        }

        if (bookingType === 'room') {
            const startHour = Number(startTime.split(':')[0]) + (startTime.split(':')[1] === '30' ? 0.5 : 0);
            const endHour = Number(endTime.split(':')[0]) + (endTime.split(':')[1] === '30' ? 0.5 : 0);
            if (startHour >= endHour) {
                alert('Invalid time range. End time must be after start time.');
                return;
            }
        }

        const submitBtn = bookingForm.querySelector('button[type="submit"]');
        const originalBtnText = submitBtn?.textContent || 'ยืนยันการจอง';
        if (submitBtn) {
            submitBtn.textContent = 'Processing... / กำลังดำเนินการ...';
            submitBtn.disabled = true;
        }

        const bookingData = {
            bookingType,
            name,
            phone,
            guests,
            date,
            note,
            status: 'pending'
        };

        if (bookingType === 'table') {
            const selection = getTableSelection();
            const maxAllowed = getMaxTablesAllowed(guests);

            if (guests > 12 || selection.overLimit) {
                alert('กรุณาติดต่อร้านโดยตรง');
                if (submitBtn) {
                    submitBtn.textContent = originalBtnText;
                    submitBtn.disabled = false;
                }
                return;
            }

            if (!selection.canSubmit || selection.selectedIds.length === 0) {
                alert('กรุณาเลือกโต๊ะบนแผนผัง');
                if (submitBtn) {
                    submitBtn.textContent = originalBtnText;
                    submitBtn.disabled = false;
                }
                return;
            }

            if (selection.selectedIds.length > maxAllowed) {
                alert('จำนวนโต๊ะที่เลือกเกินเงื่อนไข');
                if (submitBtn) {
                    submitBtn.textContent = originalBtnText;
                    submitBtn.disabled = false;
                }
                return;
            }

            bookingData.arrivalTime = arrivalTime;
            bookingData.startTime = arrivalTime;
            bookingData.endTime = '';
            bookingData.tableNo = selection.tableNo;
            bookingData.tableZone = selection.tableZone;
            bookingData.tableIds = selection.selectedIds;
        } else if (bookingType === 'room') {
            bookingData.startTime = startTime;
            bookingData.endTime = endTime;
            bookingData.roomType = roomsMap[roomSelect.value]?.name || '';
            bookingData.price = summaryPrice?.textContent.replace(/,/g, '') || '0';
            bookingData.addons = Array.from(document.querySelectorAll('#addons-group input[type="checkbox"]:checked')).map(cb => cb.value);
        }

        if (typeof window.saveBookingToCloud !== 'function') {
            alert('Booking system is not initialized completely.');
            if (submitBtn) {
                submitBtn.textContent = originalBtnText;
                submitBtn.disabled = false;
            }
            return;
        }

        try {
            const bookingId = await window.saveBookingToCloud(bookingData);
            saveBookingHistory({
                ...bookingData,
                id: bookingId || ('BK-' + Date.now()),
                time: bookingData.arrivalTime || bookingData.startTime || '',
                createdAt: new Date().toISOString()
            });
            alert('Booking submitted successfully! / จองสำเร็จเรียบร้อยแล้ว!');
            bookingForm.reset();
            if (window.EdenTableMap && typeof window.EdenTableMap.reset === 'function') window.EdenTableMap.reset();
            if (roomPreviewContainer) roomPreviewContainer.style.display = 'none';
            if (summaryDiv) summaryDiv.style.display = 'none';
            const tableRadio = document.querySelector('input[name="booking-type-radio"][value="table"]');
            if (tableRadio) {
                tableRadio.checked = true;
                tableRadio.dispatchEvent(new Event('change'));
            }
        } catch (err) {
            console.error('Booking error:', err);
            if (err?.status === 409) {
                alert('โต๊ะที่เลือกถูกจองแล้ว กรุณาเลือกโต๊ะอื่น');
                if (Array.isArray(err.conflictIds) && window.EdenTableMap?.setBookedTableIds) {
                    window.EdenTableMap.setBookedTableIds(err.conflictIds);
                }
            } else {
                alert('Error submitting booking. Please try again. / เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง');
            }
        }

        if (submitBtn) {
            submitBtn.textContent = originalBtnText;
            submitBtn.disabled = false;
        }
    });
});
