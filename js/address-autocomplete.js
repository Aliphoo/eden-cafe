// Thai Address Autocomplete (Supports Thai & English)
// Uses the bundled TH_ADDRESS_DB dataset from db_bilingual.js.

(() => {
    let addressData = null;
    let dropdown = null;
    let currentFocus = -1;
    let activeGroup = null;
    let suppressAddressEvents = false;
    const boundInputs = new WeakSet();

    function escapeHTML(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function loadAddressData() {
        if (addressData) return addressData;
        if (Array.isArray(window.TH_ADDRESS_DB)) {
            addressData = window.TH_ADDRESS_DB.map(item => ({
                subdistrictNameTh: item.sdTh || '',
                subdistrictNameEn: item.sdEn || '',
                districtNameTh: item.dTh || '',
                districtNameEn: item.dEn || '',
                provinceNameTh: item.pTh || '',
                provinceNameEn: item.pEn || '',
                postalCode: String(item.zip || '')
            }));
        } else {
            addressData = [];
            console.error('Address dataset is not loaded. Include db_bilingual.js before address-autocomplete.js');
        }
        return addressData;
    }

    function ensureDropdown() {
        if (dropdown) return dropdown;
        dropdown = document.createElement('ul');
        dropdown.className = 'address-autocomplete-dropdown';
        document.body.appendChild(dropdown);
        document.addEventListener('click', event => {
            if (!dropdown.contains(event.target) && !activeGroup?.inputs.includes(event.target)) closeDropdown();
        });
        return dropdown;
    }

    function closeDropdown() {
        if (dropdown) dropdown.classList.remove('show');
        currentFocus = -1;
    }

    function resolveElement(root, selectorOrElement) {
        if (!selectorOrElement) return null;
        if (selectorOrElement instanceof Element) return selectorOrElement;
        if (typeof selectorOrElement !== 'string') return null;
        return root.querySelector(selectorOrElement) || document.querySelector(selectorOrElement);
    }

    function resolveGroup(options = {}) {
        const root = options.root instanceof Element || options.root instanceof Document ? options.root : document;
        const subdistrictInput = resolveElement(root, options.subdistrict || '#subdistrict');
        const districtInput = resolveElement(root, options.district || '#district');
        const provinceInput = resolveElement(root, options.province || '#province');
        const zipcodeInput = resolveElement(root, options.zipcode || '#zipcode');
        if (!subdistrictInput || !districtInput || !provinceInput || !zipcodeInput) return null;
        return {
            subdistrictInput,
            districtInput,
            provinceInput,
            zipcodeInput,
            inputs: [subdistrictInput, districtInput, provinceInput, zipcodeInput]
        };
    }

    function positionDropdown(input) {
        const list = ensureDropdown();
        const rect = input.getBoundingClientRect();
        list.style.top = (rect.bottom + window.scrollY) + 'px';
        list.style.left = (rect.left + window.scrollX) + 'px';
        list.style.width = rect.width + 'px';
    }

    function inputLooksEnglish(input) {
        const value = String(input.value || '');
        return /^[a-zA-Z0-9\s.\-]+$/.test(value) && /[a-zA-Z]/.test(value);
    }

    function emitAddressFieldEvents(group) {
        group.inputs.forEach(input => {
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
        });
    }

    function fillAddress(group, item, useEnglish) {
        suppressAddressEvents = true;
        try {
            if (useEnglish) {
                group.subdistrictInput.value = item.subdistrictNameEn || item.subdistrictNameTh;
                group.districtInput.value = item.districtNameEn || item.districtNameTh;
                group.provinceInput.value = item.provinceNameEn || item.provinceNameTh;
            } else {
                group.subdistrictInput.value = item.subdistrictNameTh;
                group.districtInput.value = item.districtNameTh;
                group.provinceInput.value = item.provinceNameTh;
            }
            group.zipcodeInput.value = item.postalCode;
            emitAddressFieldEvents(group);
        } finally {
            suppressAddressEvents = false;
        }
        closeDropdown();
    }

    function renderMatches(matches, input, group) {
        const list = ensureDropdown();
        list.innerHTML = '';
        if (!matches.length) {
            closeDropdown();
            return;
        }

        const useEnglish = inputLooksEnglish(input);
        matches.forEach(item => {
            const li = document.createElement('li');
            li.innerHTML = `<strong>${escapeHTML(item.subdistrictNameTh)}</strong> - ${escapeHTML(item.districtNameTh)} - ${escapeHTML(item.provinceNameTh)} - <strong>${escapeHTML(item.postalCode)}</strong>
                            <div style="font-size:0.8rem; color:#888;">${escapeHTML(item.subdistrictNameEn)} - ${escapeHTML(item.districtNameEn)} - ${escapeHTML(item.provinceNameEn)}</div>`;
            li.addEventListener('mousedown', () => fillAddress(group, item, useEnglish));
            list.appendChild(li);
        });

        activeGroup = group;
        positionDropdown(input);
        list.classList.add('show');
    }

    function startsWith(value, term) {
        return String(value || '').toLowerCase().startsWith(term);
    }

    function handleInput(event, group) {
        if (suppressAddressEvents) return;
        const input = event.target;
        const term = String(input.value || '').trim().toLowerCase();
        const rows = loadAddressData();
        if (!term || !rows.length) {
            closeDropdown();
            return;
        }

        const matches = [];
        for (let i = 0; i < rows.length; i += 1) {
            const item = rows[i];
            let isMatch = false;
            if (input === group.zipcodeInput) {
                isMatch = startsWith(item.postalCode, term);
            } else if (input === group.subdistrictInput) {
                isMatch = startsWith(item.subdistrictNameTh, term) || startsWith(item.subdistrictNameEn, term);
            } else if (input === group.districtInput) {
                isMatch = startsWith(item.districtNameTh, term) || startsWith(item.districtNameEn, term);
            } else if (input === group.provinceInput) {
                isMatch = startsWith(item.provinceNameTh, term) || startsWith(item.provinceNameEn, term);
            }
            if (isMatch) {
                matches.push(item);
                if (matches.length >= 10) break;
            }
        }

        renderMatches(matches, input, group);
    }

    function addActive(items) {
        if (!items || !items.length) return;
        for (let i = 0; i < items.length; i += 1) {
            items[i].classList.remove('autocomplete-active');
        }
        if (currentFocus >= items.length) currentFocus = 0;
        if (currentFocus < 0) currentFocus = items.length - 1;
        items[currentFocus].classList.add('autocomplete-active');
    }

    function handleKeyDown(event) {
        const list = ensureDropdown();
        if (!list.classList.contains('show')) return;
        const items = list.getElementsByTagName('li');
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            currentFocus += 1;
            addActive(items);
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            currentFocus -= 1;
            addActive(items);
        } else if (event.key === 'Enter') {
            event.preventDefault();
            if (currentFocus > -1 && items[currentFocus]) {
                items[currentFocus].dispatchEvent(new MouseEvent('mousedown'));
            }
        } else if (event.key === 'Escape') {
            closeDropdown();
        }
    }

    function initAddressAutocomplete(options = {}) {
        const group = resolveGroup(options);
        if (!group) return false;
        loadAddressData();
        ensureDropdown();
        group.inputs.forEach(input => {
            input.setAttribute('autocomplete', 'off');
            if (boundInputs.has(input)) return;
            boundInputs.add(input);
            input.addEventListener('input', event => handleInput(event, group));
            input.addEventListener('keydown', handleKeyDown);
            input.addEventListener('focus', event => handleInput(event, group));
            input.addEventListener('blur', () => window.setTimeout(closeDropdown, 200));
        });
        return true;
    }

    window.EdenAddressAutocomplete = {
        ...(window.EdenAddressAutocomplete || {}),
        init: initAddressAutocomplete
    };
    window.initAddressAutocomplete = initAddressAutocomplete;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => initAddressAutocomplete());
    } else {
        window.setTimeout(() => initAddressAutocomplete(), 0);
    }
})();
