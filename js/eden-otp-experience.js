const OTP_SELECTOR = [
    'input[data-eden-otp]',
    'input[autocomplete="one-time-code"]',
    'input[name="emailCode"]',
    'input[name="phoneCode"]',
    'input[name="phoneRemovalCode"]'
].join(',');

const instances = new WeakMap();
let pageObserver = null;

function mapLocalizedDigit(char) {
    const codePoint = char.codePointAt(0);
    if (codePoint >= 0x0e50 && codePoint <= 0x0e59) return String(codePoint - 0x0e50);
    if (codePoint >= 0x0660 && codePoint <= 0x0669) return String(codePoint - 0x0660);
    if (codePoint >= 0x06f0 && codePoint <= 0x06f9) return String(codePoint - 0x06f0);
    return char;
}

function normalizeOtp(value, length) {
    return Array.from(String(value || ''))
        .map(mapLocalizedDigit)
        .join('')
        .replace(/\D/g, '')
        .slice(0, length);
}

function otpLength(input, options = {}) {
    const fromOptions = Number(options.length || input.dataset.edenOtpLength);
    const fromAttribute = Number(input.getAttribute('maxlength'));
    return Math.max(1, Math.min(12, fromOptions || fromAttribute || 6));
}

function inferTone(input, options = {}) {
    if (options.tone) return options.tone;
    const key = `${input.id || ''} ${input.name || ''} ${input.dataset.edenOtp || ''}`.toLowerCase();
    if (key.includes('removal')) return 'danger';
    if (key.includes('email')) return 'email';
    if (key.includes('forgot')) return 'reset';
    if (key.includes('register')) return 'signup';
    return 'secure';
}

function stateFromValue(value, length) {
    return value.length >= length ? 'complete' : 'idle';
}

function setInstanceState(instance, state, message = '') {
    instance.shell.dataset.state = state || stateFromValue(instance.input.value, instance.length);
    instance.field.dataset.state = instance.shell.dataset.state;
    instance.message.textContent = message || '';
    instance.message.hidden = !message;

    if (state === 'error') {
        instance.field.classList.remove('eden-otp-shake');
        window.requestAnimationFrame(() => instance.field.classList.add('eden-otp-shake'));
    }
}

function syncInstance(instance, options = {}) {
    const clean = normalizeOtp(instance.input.value, instance.length);
    const changed = clean !== instance.value;
    if (clean !== instance.input.value) instance.input.value = clean;
    instance.value = clean;

    instance.slots.forEach((slot, index) => {
        const digit = clean[index] || '';
        const filled = Boolean(digit);
        const active = index === clean.length && clean.length < instance.length;
        slot.classList.toggle('is-filled', filled);
        slot.classList.toggle('is-active', active);
        slot.querySelector('.eden-otp-digit').textContent = digit;
    });

    const nextState = stateFromValue(clean, instance.length);
    const currentState = instance.shell.dataset.state;
    if (options.forceState) {
        setInstanceState(instance, options.forceState, options.message || '');
    } else if (
        changed &&
        (currentState === 'error' || currentState === 'success' || currentState === 'complete')
    ) {
        setInstanceState(instance, nextState);
    } else if (!currentState || currentState === 'idle' || currentState === 'complete') {
        setInstanceState(instance, nextState);
    }

    instance.field.classList.toggle('is-disabled', instance.input.disabled);
    instance.field.classList.toggle('is-readonly', instance.input.readOnly);
    instance.field.style.setProperty('--eden-otp-progress', `${clean.length / instance.length}`);
}

function buildShell(length) {
    const shell = document.createElement('div');
    shell.className = 'eden-otp-shell';
    shell.setAttribute('aria-hidden', 'true');
    shell.dataset.state = 'idle';

    const track = document.createElement('div');
    track.className = 'eden-otp-track';

    const slots = Array.from({ length }, (_, index) => {
        const slot = document.createElement('span');
        slot.className = 'eden-otp-slot';
        slot.style.setProperty('--otp-index', String(index));

        const digit = document.createElement('span');
        digit.className = 'eden-otp-digit';
        slot.appendChild(digit);

        return slot;
    });

    slots.forEach(slot => track.appendChild(slot));

    const message = document.createElement('span');
    message.className = 'eden-otp-message';
    message.hidden = true;

    shell.append(track, message);
    return { shell, slots, message };
}

export function enhanceOtpInput(input, options = {}) {
    if (!input || instances.has(input)) return instances.get(input) || null;
    if (!(input instanceof HTMLInputElement)) return null;

    const length = otpLength(input, options);
    const { shell, slots, message } = buildShell(length);
    const field = document.createElement('div');
    field.className = 'eden-otp-field';
    field.dataset.tone = inferTone(input, options);
    field.dataset.state = 'idle';

    input.classList.add('eden-otp-native');
    input.setAttribute('inputmode', 'numeric');
    input.setAttribute('autocomplete', 'one-time-code');
    input.setAttribute('maxlength', String(length));
    input.setAttribute('pattern', '[0-9]*');

    input.parentNode.insertBefore(field, input);
    field.append(input, shell);

    const instance = {
        field,
        input,
        length,
        message,
        shell,
        slots,
        value: ''
    };
    instances.set(input, instance);

    input.addEventListener('input', () => syncInstance(instance));
    input.addEventListener('paste', event => {
        const pasted = event.clipboardData?.getData('text');
        if (!pasted) return;
        event.preventDefault();
        input.value = normalizeOtp(pasted, length);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    input.addEventListener('focus', () => field.classList.add('is-focused'));
    input.addEventListener('blur', () => field.classList.remove('is-focused'));
    field.addEventListener('animationend', () => field.classList.remove('eden-otp-shake'));

    const attributeObserver = new MutationObserver(() => syncInstance(instance));
    attributeObserver.observe(input, { attributes: true, attributeFilter: ['disabled', 'readonly', 'value'] });
    instance.attributeObserver = attributeObserver;

    syncInstance(instance);
    return instance;
}

export function enhanceOtpInputs(root = document) {
    if (!root?.querySelectorAll) return [];
    return Array.from(root.querySelectorAll(OTP_SELECTOR))
        .map(input => enhanceOtpInput(input))
        .filter(Boolean);
}

export function autoEnhanceOtpInputs(root = document) {
    const enhanced = enhanceOtpInputs(root);
    if (!pageObserver && document.body) {
        pageObserver = new MutationObserver(mutations => {
            mutations.forEach(mutation => {
                mutation.addedNodes.forEach(node => {
                    if (!(node instanceof Element)) return;
                    if (node.matches?.(OTP_SELECTOR)) enhanceOtpInput(node);
                    enhanceOtpInputs(node);
                });
            });
        });
        pageObserver.observe(document.body, { childList: true, subtree: true });
    }
    return enhanced;
}

export function setOtpUiStatus(target, state = 'idle', message = '') {
    const input = typeof target === 'string' ? document.querySelector(target) : target;
    const instance = enhanceOtpInput(input);
    if (!instance) return;
    syncInstance(instance, { forceState: state, message });
}

export function clearOtpUiStatus(target) {
    const input = typeof target === 'string' ? document.querySelector(target) : target;
    const instance = enhanceOtpInput(input);
    if (!instance) return;
    syncInstance(instance, { forceState: stateFromValue(instance.input.value, instance.length) });
}
