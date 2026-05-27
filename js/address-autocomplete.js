// Thai Address Autocomplete (Supports Thai & English)
// Using data from thailand-geography-json

document.addEventListener('DOMContentLoaded', () => {
    const subdistrictInput = document.getElementById('subdistrict');
    const districtInput = document.getElementById('district');
    const provinceInput = document.getElementById('province');
    const zipcodeInput = document.getElementById('zipcode');

    if (!subdistrictInput || !districtInput || !provinceInput || !zipcodeInput) return;

    let addressData = [];

    function escapeHTML(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // Create dropdown container
    const dropdown = document.createElement('ul');
    dropdown.className = 'address-autocomplete-dropdown';
    document.body.appendChild(dropdown);

    // Use the bundled address dataset to avoid depending on external runtime data.
    if (Array.isArray(window.TH_ADDRESS_DB)) {
        addressData = window.TH_ADDRESS_DB.map(item => ({
            subdistrictNameTh: item.sdTh,
            subdistrictNameEn: item.sdEn,
            districtNameTh: item.dTh,
            districtNameEn: item.dEn,
            provinceNameTh: item.pTh,
            provinceNameEn: item.pEn,
            postalCode: item.zip
        }));
    } else {
        console.error("Address dataset is not loaded. Include db_bilingual.js before address-autocomplete.js");
    }

    let currentFocus = -1;
    let currentInput = null;

    function closeDropdown() {
        dropdown.classList.remove('show');
        currentFocus = -1;
    }

    function positionDropdown(input) {
        const rect = input.getBoundingClientRect();
        dropdown.style.top = (rect.bottom + window.scrollY) + 'px';
        dropdown.style.left = (rect.left + window.scrollX) + 'px';
        dropdown.style.width = rect.width + 'px';
    }

    function renderMatches(matches, input) {
        dropdown.innerHTML = '';
        if (matches.length === 0) {
            closeDropdown();
            return;
        }
        
        const val = input.value;
        const isEnglish = /^[a-zA-Z0-9\s.\-]+$/.test(val) && /[a-zA-Z]/.test(val);

        matches.forEach((item, index) => {
            const li = document.createElement('li');
            li.innerHTML = `<strong>${escapeHTML(item.subdistrictNameTh)}</strong> - ${escapeHTML(item.districtNameTh)} - ${escapeHTML(item.provinceNameTh)} - <strong>${escapeHTML(item.postalCode)}</strong>
                            <div style="font-size:0.8rem; color:#888;">${escapeHTML(item.subdistrictNameEn)} - ${escapeHTML(item.districtNameEn)} - ${escapeHTML(item.provinceNameEn)}</div>`;
            li.addEventListener('mousedown', () => {
                if (isEnglish) {
                    subdistrictInput.value = item.subdistrictNameEn || item.subdistrictNameTh;
                    districtInput.value = item.districtNameEn || item.districtNameTh;
                    provinceInput.value = item.provinceNameEn || item.provinceNameTh;
                } else {
                    subdistrictInput.value = item.subdistrictNameTh;
                    districtInput.value = item.districtNameTh;
                    provinceInput.value = item.provinceNameTh;
                }
                zipcodeInput.value = item.postalCode;
                closeDropdown();
            });
            dropdown.appendChild(li);
        });

        positionDropdown(input);
        dropdown.classList.add('show');
    }

    function handleInput(e) {
        currentInput = e.target;
        const val = currentInput.value.trim().toLowerCase();
        
        if (!val || addressData.length === 0) {
            closeDropdown();
            return;
        }

        // Search logic (Supports TH and EN)
        const isZipcode = currentInput === zipcodeInput;
        const matches = [];
        
        for (let i = 0; i < addressData.length; i++) {
            const item = addressData[i];
            let isMatch = false;

            if (isZipcode) {
                isMatch = item.postalCode && item.postalCode.toString().startsWith(val);
            } else if (currentInput === subdistrictInput) {
                isMatch = item.subdistrictNameTh.startsWith(val) || 
                          (item.subdistrictNameEn && item.subdistrictNameEn.toLowerCase().startsWith(val));
            } else if (currentInput === districtInput) {
                isMatch = item.districtNameTh.startsWith(val) || 
                          (item.districtNameEn && item.districtNameEn.toLowerCase().startsWith(val));
            } else if (currentInput === provinceInput) {
                isMatch = item.provinceNameTh.startsWith(val) || 
                          (item.provinceNameEn && item.provinceNameEn.toLowerCase().startsWith(val));
            }

            if (isMatch) {
                matches.push(item);
                if (matches.length >= 10) break; // Limit to 10 results
            }
        }

        renderMatches(matches, currentInput);
    }

    function handleKeyDown(e) {
        if (!dropdown.classList.contains('show')) return;
        const items = dropdown.getElementsByTagName('li');
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            currentFocus++;
            addActive(items);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            currentFocus--;
            addActive(items);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (currentFocus > -1) {
                if (items) items[currentFocus].dispatchEvent(new MouseEvent('mousedown'));
            }
        } else if (e.key === 'Escape') {
            closeDropdown();
        }
    }

    function addActive(items) {
        if (!items) return;
        for (let i = 0; i < items.length; i++) {
            items[i].classList.remove('autocomplete-active');
        }
        if (currentFocus >= items.length) currentFocus = 0;
        if (currentFocus < 0) currentFocus = items.length - 1;
        items[currentFocus].classList.add('autocomplete-active');
    }

    [subdistrictInput, districtInput, provinceInput, zipcodeInput].forEach(input => {
        input.addEventListener('input', handleInput);
        input.addEventListener('keydown', handleKeyDown);
        input.addEventListener('focus', handleInput); // Show dropdown if already typed
        input.addEventListener('blur', () => setTimeout(closeDropdown, 200));
        
        // Prevent default autocomplete to avoid overlap
        input.setAttribute('autocomplete', 'off');
    });
});
