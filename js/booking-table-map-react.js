(function () {
    const { useEffect, useMemo, useState } = window.React || {};
    const rootEl = document.getElementById('eden-table-map-root');

    if (!window.React || !window.ReactDOM || !rootEl) {
        return;
    }

    const h = React.createElement;

    const DEFAULT_ZONES = [
        { id: 'indoor', label: 'Indoor', hint: 'Quiet AC seating', x: 5, y: 7, w: 37, h: 38 },
        { id: 'outdoor', label: 'Outdoor', hint: 'Open-air cafe terrace', x: 48, y: 7, w: 47, h: 28 },
        { id: 'garden', label: 'Garden', hint: 'Green wellness corner', x: 5, y: 52, w: 37, h: 39 },
        { id: 'riverside', label: 'Riverside', hint: 'Relaxed scenic zone', x: 48, y: 43, w: 47, h: 22 },
        { id: 'private', label: 'Private Zone', hint: 'Semi-private table area', x: 48, y: 71, w: 47, h: 20 }
    ];

    const DEFAULT_TABLES = [
        { id: 'in-01', code: 'IN-01', zone: 'Indoor', seats: 2, shape: 'round', x: 11, y: 20, status: 'available' },
        { id: 'in-02', code: 'IN-02', zone: 'Indoor', seats: 4, shape: 'rect', x: 24, y: 20, status: 'available' },
        { id: 'in-03', code: 'IN-03', zone: 'Indoor', seats: 4, shape: 'rect', x: 11, y: 34, status: 'booked' },
        { id: 'in-04', code: 'IN-04', zone: 'Indoor', seats: 6, shape: 'wide', x: 25, y: 34, status: 'available' },
        { id: 'out-01', code: 'OUT-01', zone: 'Outdoor', seats: 2, shape: 'round', x: 55, y: 19, status: 'available' },
        { id: 'out-02', code: 'OUT-02', zone: 'Outdoor', seats: 4, shape: 'rect', x: 69, y: 18, status: 'available' },
        { id: 'out-03', code: 'OUT-03', zone: 'Outdoor', seats: 4, shape: 'rect', x: 83, y: 18, status: 'unavailable' },
        { id: 'gd-01', code: 'GD-01', zone: 'Garden', seats: 4, shape: 'rect', x: 11, y: 65, status: 'available' },
        { id: 'gd-02', code: 'GD-02', zone: 'Garden', seats: 4, shape: 'rect', x: 25, y: 65, status: 'available' },
        { id: 'gd-03', code: 'GD-03', zone: 'Garden', seats: 2, shape: 'round', x: 18, y: 80, status: 'available' },
        { id: 'rs-01', code: 'RS-01', zone: 'Riverside', seats: 4, shape: 'rect', x: 56, y: 53, status: 'available' },
        { id: 'rs-02', code: 'RS-02', zone: 'Riverside', seats: 4, shape: 'rect', x: 72, y: 53, status: 'booked' },
        { id: 'rs-03', code: 'RS-03', zone: 'Riverside', seats: 2, shape: 'round', x: 87, y: 53, status: 'available' },
        { id: 'pv-01', code: 'PV-01', zone: 'Private Zone', seats: 6, shape: 'wide', x: 57, y: 80, status: 'available' },
        { id: 'pv-02', code: 'PV-02', zone: 'Private Zone', seats: 6, shape: 'wide', x: 78, y: 80, status: 'available' }
    ];

    const statusText = {
        available: 'ว่าง',
        selected: 'เลือกอยู่',
        booked: 'จองแล้ว',
        unavailable: 'ปิดใช้งาน'
    };

    function clampPercent(value, fallback = 0) {
        const number = Number(value);
        return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : fallback;
    }

    function getInputValue(id, fallback = '') {
        const el = document.getElementById(id);
        return el ? el.value : fallback;
    }

    function getMaxTablesAllowed(guests) {
        if (guests >= 1 && guests <= 4) return 1;
        if (guests >= 5 && guests <= 8) return 2;
        if (guests >= 9 && guests <= 12) return 3;
        return 0;
    }

    function readFormSnapshot() {
        return {
            date: getInputValue('date'),
            time: getInputValue('arrival-time'),
            guests: Number(getInputValue('guests', '1')) || 1,
            name: getInputValue('name'),
            phone: getInputValue('phone')
        };
    }

    function normalizeCloudLayout(rows) {
        const zones = [];
        const tables = [];
        (Array.isArray(rows) ? rows : []).forEach(row => {
            if (!row || row.mapEnabled === false) return;
            if (row.kind === 'zone') {
                zones.push({
                    id: row.id,
                    label: row.name || row.label || row.id,
                    hint: row.hint || '',
                    x: clampPercent(row.x, 5),
                    y: clampPercent(row.y, 5),
                    w: Math.max(5, Math.min(100, Number(row.w) || 30)),
                    h: Math.max(5, Math.min(100, Number(row.h) || 25))
                });
                return;
            }
            if (row.kind !== 'table') return;
            tables.push({
                id: row.id,
                code: row.code || String(row.id || '').toUpperCase(),
                zone: row.zone || row.tableZone || 'Indoor',
                seats: Math.max(1, Number(row.seats || row.capacity) || 4),
                shape: ['round', 'rect', 'wide'].includes(row.shape) ? row.shape : 'rect',
                x: clampPercent(row.x, 10),
                y: clampPercent(row.y, 10),
                status: ['available', 'booked', 'unavailable'].includes(row.status) ? row.status : 'available'
            });
        });
        return {
            zones: zones.length ? zones : DEFAULT_ZONES,
            tables: tables.length ? tables : DEFAULT_TABLES
        };
    }

    function waitForTableLoader() {
        if (typeof window.fetchTablesFromCloud === 'function') {
            return Promise.resolve(window.fetchTablesFromCloud);
        }
        return new Promise(resolve => {
            let attempts = 0;
            const timer = window.setInterval(() => {
                attempts += 1;
                if (typeof window.fetchTablesFromCloud === 'function') {
                    window.clearInterval(timer);
                    resolve(window.fetchTablesFromCloud);
                } else if (attempts >= 12) {
                    window.clearInterval(timer);
                    resolve(null);
                }
            }, 250);
        });
    }

    function TableMapApp() {
        const [selectedIds, setSelectedIds] = useState([]);
        const [form, setForm] = useState(readFormSnapshot());
        const [cloudBookedIds, setCloudBookedIds] = useState([]);
        const [layout, setLayout] = useState({ zones: DEFAULT_ZONES, tables: DEFAULT_TABLES });
        const maxAllowed = getMaxTablesAllowed(form.guests);
        const overLimit = form.guests > 12;

        const tables = useMemo(() => layout.tables.map(table => {
            if (cloudBookedIds.includes(table.id) && table.status === 'available') {
                return { ...table, status: 'booked' };
            }
            return table;
        }), [cloudBookedIds, layout.tables]);

        const selectedTables = useMemo(
            () => tables.filter(table => selectedIds.includes(table.id)),
            [selectedIds, tables]
        );

        useEffect(() => {
            let cancelled = false;
            async function loadLayout() {
                try {
                    const loader = await waitForTableLoader();
                    if (!loader) return;
                    const rows = await loader();
                    const nextLayout = normalizeCloudLayout(rows);
                    if (!cancelled) setLayout(nextLayout);
                } catch (error) {
                    console.warn('Using default table map layout:', error);
                }
            }
            loadLayout();
            return () => { cancelled = true; };
        }, []);

        useEffect(() => {
            const inputIds = ['date', 'arrival-time', 'guests', 'name', 'phone', 'booking-notes'];
            const refresh = () => setForm(readFormSnapshot());
            inputIds.forEach(id => document.getElementById(id)?.addEventListener('input', refresh));
            inputIds.forEach(id => document.getElementById(id)?.addEventListener('change', refresh));
            refresh();
            return () => {
                inputIds.forEach(id => document.getElementById(id)?.removeEventListener('input', refresh));
                inputIds.forEach(id => document.getElementById(id)?.removeEventListener('change', refresh));
            };
        }, []);

        useEffect(() => {
            const liveTableIds = new Set(tables.map(table => table.id));
            const shouldClear = overLimit || selectedIds.length > maxAllowed || selectedIds.some(id => !liveTableIds.has(id));
            if (shouldClear && selectedIds.length > 0) setSelectedIds([]);
        }, [overLimit, maxAllowed, selectedIds, tables]);

        useEffect(() => {
            let cancelled = false;
            async function loadBookedTables() {
                if (typeof window.fetchTableAvailability !== 'function' || !form.date || !form.time) {
                    setCloudBookedIds([]);
                    return;
                }
                try {
                    const result = await window.fetchTableAvailability({ date: form.date, time: form.time });
                    if (!cancelled) setCloudBookedIds(Array.isArray(result) ? result : []);
                } catch (error) {
                    console.warn('Unable to load table availability yet:', error);
                    if (!cancelled) setCloudBookedIds([]);
                }
            }
            loadBookedTables();
            return () => { cancelled = true; };
        }, [form.date, form.time]);

        useEffect(() => {
            const payload = {
                selectedIds,
                selectedTables,
                maxAllowed,
                overLimit,
                tableNo: selectedTables.map(table => table.code).join(', '),
                tableZone: [...new Set(selectedTables.map(table => table.zone))].join(', '),
                canSubmit: !overLimit && selectedTables.length > 0 && selectedTables.length <= maxAllowed
            };

            const hiddenInput = document.getElementById('selected-table-ids');
            if (hiddenInput) hiddenInput.value = selectedIds.join(',');

            window.EdenTableMap = {
                tables,
                zones: layout.zones,
                getSelection: () => payload,
                reset: () => setSelectedIds([]),
                setBookedTableIds: (ids) => setCloudBookedIds(Array.isArray(ids) ? ids : [])
            };

            window.dispatchEvent(new CustomEvent('eden:table-selection-change', { detail: payload }));
        }, [selectedIds, selectedTables, maxAllowed, overLimit, tables, layout.zones]);

        function handleTableClick(table) {
            if (table.status !== 'available') return;
            if (overLimit) {
                alert('กรุณาติดต่อร้านโดยตรง');
                return;
            }
            if (selectedIds.includes(table.id)) {
                setSelectedIds(current => current.filter(id => id !== table.id));
                return;
            }
            if (selectedIds.length >= maxAllowed) {
                alert('จำนวนโต๊ะที่เลือกเกินเงื่อนไข');
                return;
            }
            setSelectedIds(current => [...current, table.id]);
        }

        return h('div', { className: 'eden-table-map' },
            h('div', { className: 'eden-map-head' },
                h('div', null,
                    h('p', { className: 'eden-map-eyebrow' }, 'Eden Cafe Table Map'),
                    h('h3', null, 'เลือกโต๊ะแบบ Interactive'),
                    h('p', { className: 'eden-map-subtitle' }, 'คลิกเลือกโต๊ะได้เหมือนเลือกที่นั่ง ลูกค้าจะเห็นสถานะว่าง/จองแล้ว/ปิดใช้งานทันที')
                ),
                h('div', { className: 'eden-map-limit' }, overLimit ? 'กรุณาติดต่อร้านโดยตรง' : 'เลือกได้สูงสุด ' + maxAllowed + ' โต๊ะ')
            ),
            h('div', { className: 'eden-map-legend' },
                ['available', 'selected', 'booked', 'unavailable'].map(status =>
                    h('div', { key: status, className: 'eden-map-legend-item' },
                        h('span', { className: 'eden-map-dot is-' + status }),
                        h('span', null, statusText[status])
                    )
                )
            ),
            h('div', { className: 'eden-map-notice ' + (overLimit ? 'is-danger' : '') },
                overLimit
                    ? 'จำนวนลูกค้ามากกว่า 12 คน กรุณาติดต่อร้านโดยตรง'
                    : 'จำนวนลูกค้า ' + form.guests + ' คน เลือกได้สูงสุด ' + maxAllowed + ' โต๊ะ'
            ),
            h('div', { className: 'eden-map-scroll' },
                h('div', { className: 'eden-map-stage' },
                    h('div', { className: 'eden-map-divider vertical' }),
                    h('div', { className: 'eden-map-divider horizontal' }),
                    layout.zones.map(zone => h('div', {
                        key: zone.id,
                        className: 'eden-map-zone',
                        style: { left: zone.x + '%', top: zone.y + '%', width: zone.w + '%', height: zone.h + '%' }
                    },
                        h('div', { className: 'eden-map-zone-title' }, zone.label),
                        h('div', { className: 'eden-map-zone-hint' }, zone.hint)
                    )),
                    h('div', { className: 'eden-map-walkway' }, 'Walkway'),
                    tables.map(table => {
                        const status = selectedIds.includes(table.id) ? 'selected' : table.status;
                        return h('button', {
                            key: table.id,
                            type: 'button',
                            disabled: table.status !== 'available' || overLimit,
                            onClick: () => handleTableClick(table),
                            className: 'eden-map-table shape-' + table.shape + ' is-' + status,
                            style: { left: table.x + '%', top: table.y + '%' },
                            'aria-label': table.code + ' ' + table.zone + ' ' + statusText[status]
                        },
                            h('span', { className: 'eden-map-table-code' }, table.code),
                            h('span', { className: 'eden-map-table-seats' }, table.seats + ' seats')
                        );
                    })
                )
            ),
            h('div', { className: 'eden-map-summary-grid' },
                h('div', { className: 'eden-map-summary-card' },
                    h('h4', null, 'สรุปการเลือกโต๊ะ'),
                    selectedTables.length === 0
                        ? h('p', { className: 'muted' }, 'ยังไม่ได้เลือกโต๊ะ')
                        : h('div', { className: 'eden-map-chip-list' }, selectedTables.map(table =>
                            h('span', { key: table.id, className: 'eden-map-chip' }, table.code + ' · ' + table.zone)
                        )),
                    h('p', { className: 'eden-map-seat-total' }, 'รวมที่นั่งโดยประมาณ: ' + selectedTables.reduce((sum, table) => sum + table.seats, 0) + ' seats')
                ),
                h('div', { className: 'eden-map-summary-card is-soft' },
                    h('h4', null, 'สรุปการจอง'),
                    h('dl', { className: 'eden-map-summary-list' },
                        h('div', null, h('dt', null, 'วันที่'), h('dd', null, form.date || '-')),
                        h('div', null, h('dt', null, 'เวลา'), h('dd', null, form.time || '-')),
                        h('div', null, h('dt', null, 'จำนวนคน'), h('dd', null, form.guests || '-')),
                        h('div', null, h('dt', null, 'โซน'), h('dd', null, [...new Set(selectedTables.map(table => table.zone))].join(', ') || '-')),
                        h('div', null, h('dt', null, 'หมายเลขโต๊ะ'), h('dd', null, selectedTables.map(table => table.code).join(', ') || '-')),
                        h('div', null, h('dt', null, 'ชื่อ'), h('dd', null, form.name || '-')),
                        h('div', null, h('dt', null, 'เบอร์โทร'), h('dd', null, form.phone || '-'))
                    )
                )
            )
        );
    }

    ReactDOM.createRoot(rootEl).render(h(TableMapApp));
})();
