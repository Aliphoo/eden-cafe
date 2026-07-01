const ACTIVE_CLASS = 'gallery-card-active';

function isEnglishPage() {
    return document.documentElement.lang?.toLowerCase().startsWith('en')
        || /(?:^|\/)en(?:\.html)?(?:$|[?#/])/.test(window.location.pathname)
        || /-en\.html$/.test(window.location.pathname);
}

function getLocalizedValue(element, key, lang) {
    return element.dataset[`gallery${key}${lang}`]
        || element.dataset[`gallery${key}${lang === 'En' ? 'Th' : 'En'}`]
        || '';
}

function initGalleryCarousel(root) {
    const viewport = root.querySelector('[data-gallery-viewport]');
    const track = root.querySelector('[data-gallery-track]');
    const cards = Array.from(root.querySelectorAll('[data-gallery-card]'));
    const prevButton = root.querySelector('[data-gallery-prev]');
    const nextButton = root.querySelector('[data-gallery-next]');
    const dotsRoot = root.querySelector('[data-gallery-dots]');
    const status = root.querySelector('[data-gallery-status]');

    if (!viewport || !cards.length) return;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const lang = isEnglishPage() ? 'En' : 'Th';
    let activeIndex = Math.max(0, cards.findIndex(card => card.classList.contains(ACTIVE_CLASS)));
    let suppressClick = false;
    let resizeTimer = 0;
    let dragState = null;
    let scrollFrame = 0;
    let pendingScrollLeft = 0;

    const wrapIndex = index => (index + cards.length) % cards.length;

    function resolveGalleryWidth(customProperty, fallback) {
        const probe = document.createElement('span');
        probe.style.cssText = `position:absolute;visibility:hidden;pointer-events:none;width:var(${customProperty});height:1px;`;
        root.appendChild(probe);
        const width = probe.getBoundingClientRect().width;
        probe.remove();
        return Number.isFinite(width) && width > 0 ? width : fallback;
    }

    function getTargetScrollLeft(activeCard) {
        const viewportStyles = getComputedStyle(viewport);
        const trackStyles = track ? getComputedStyle(track) : null;
        const stableCard = cards.find((card, index) => index !== activeIndex) || activeCard;
        const paddingLeft = parseFloat(viewportStyles.paddingLeft) || 0;
        const gap = parseFloat(trackStyles?.columnGap || trackStyles?.gap || '0') || 0;
        const collapsedWidth = resolveGalleryWidth('--gallery-card-width', stableCard.offsetWidth);
        const activeWidth = resolveGalleryWidth('--gallery-active-width', activeCard.offsetWidth);
        const finalOffsetLeft = paddingLeft + activeIndex * (collapsedWidth + gap);
        const alignOffset = Math.max(0, (viewport.clientWidth - activeWidth) / 2);

        return Math.max(0, finalOffsetLeft - alignOffset);
    }

    function localizeCards() {
        cards.forEach((card, index) => {
            const title = getLocalizedValue(card, 'Title', lang);
            const description = getLocalizedValue(card, 'Description', lang);
            const kicker = getLocalizedValue(card, 'Kicker', lang);
            const titleElement = card.querySelector('[data-gallery-card-title]');
            const descriptionElement = card.querySelector('[data-gallery-card-description]');
            const kickerElement = card.querySelector('[data-gallery-card-kicker]');
            const label = [title, description].filter(Boolean).join(' - ');

            if (titleElement && title) titleElement.textContent = title;
            if (descriptionElement && description) descriptionElement.textContent = description;
            if (kickerElement && kicker) kickerElement.textContent = kicker;
            card.setAttribute('aria-label', `${index + 1}/${cards.length}: ${label || title || 'Gallery image'}`);
        });
    }

    function createDots() {
        if (!dotsRoot) return [];
        dotsRoot.replaceChildren();
        return cards.map((card, index) => {
            const dot = document.createElement('button');
            dot.type = 'button';
            dot.className = 'gallery-carousel-dot';
            dot.setAttribute('aria-label', card.getAttribute('aria-label') || `Gallery image ${index + 1}`);
            dot.addEventListener('click', () => setActive(index, { focus: true }));
            dotsRoot.appendChild(dot);
            return dot;
        });
    }

    let dots = [];

    function snapToActive(options = {}) {
        const activeCard = cards[activeIndex];
        if (!activeCard) return;

        requestAnimationFrame(() => {
            viewport.scrollTo({
                left: getTargetScrollLeft(activeCard),
                behavior: options.instant || reducedMotion.matches ? 'auto' : 'smooth',
            });
        });
    }

    function updateControls() {
        cards.forEach((card, index) => {
            const isActive = index === activeIndex;
            card.classList.toggle(ACTIVE_CLASS, isActive);
            card.setAttribute('aria-current', isActive ? 'true' : 'false');
            card.tabIndex = isActive ? 0 : -1;
        });

        dots.forEach((dot, index) => {
            const isActive = index === activeIndex;
            dot.classList.toggle('is-active', isActive);
            dot.setAttribute('aria-current', isActive ? 'true' : 'false');
        });

        if (status) {
            const title = getLocalizedValue(cards[activeIndex], 'Title', lang) || cards[activeIndex].getAttribute('aria-label') || '';
            status.textContent = lang === 'En'
                ? `Showing image ${activeIndex + 1} of ${cards.length}: ${title}`
                : `กำลังแสดงภาพที่ ${activeIndex + 1} จาก ${cards.length}: ${title}`;
        }
    }

    function setActive(index, options = {}) {
        activeIndex = wrapIndex(index);
        root.dataset.activeIndex = String(activeIndex);
        updateControls();
        snapToActive(options);

        if (options.focus) {
            requestAnimationFrame(() => {
                try {
                    cards[activeIndex].focus({ preventScroll: true });
                } catch (_) {
                    cards[activeIndex].focus();
                }
            });
        }
    }

    function nearestCardIndex() {
        const viewportRect = viewport.getBoundingClientRect();
        const viewportCenter = viewportRect.left + viewportRect.width / 2;
        let nearestIndex = activeIndex;
        let nearestDistance = Number.POSITIVE_INFINITY;

        cards.forEach((card, index) => {
            const cardRect = card.getBoundingClientRect();
            const cardCenter = cardRect.left + cardRect.width / 2;
            const distance = Math.abs(cardCenter - viewportCenter);
            if (distance < nearestDistance) {
                nearestDistance = distance;
                nearestIndex = index;
            }
        });

        return nearestIndex;
    }

    function requestScroll(left) {
        pendingScrollLeft = left;
        if (scrollFrame) return;
        scrollFrame = requestAnimationFrame(() => {
            viewport.scrollLeft = pendingScrollLeft;
            scrollFrame = 0;
        });
    }

    function finishDrag(event) {
        if (!dragState || event.pointerId !== dragState.pointerId) return;

        const wasDragging = dragState.dragging;
        const movedX = event.clientX - dragState.startX;
        const movedY = event.clientY - dragState.startY;
        const tapLike = Math.hypot(movedX, movedY) < 24;
        root.classList.remove('is-dragging');
        root.classList.remove('is-pointer-down');

        try {
            viewport.releasePointerCapture(event.pointerId);
        } catch (_) {}

        if (tapLike && Number.isInteger(dragState.cardIndex) && dragState.cardIndex !== activeIndex) {
            suppressClick = true;
            setActive(dragState.cardIndex, { focus: true });
            window.setTimeout(() => {
                suppressClick = false;
            }, 180);
        } else if (wasDragging) {
            suppressClick = true;
            const strongSwipe = Math.abs(movedX) > Math.min(120, viewport.clientWidth * 0.22);
            const direction = movedX < 0 ? 1 : -1;
            const nextIndex = strongSwipe ? activeIndex + direction : nearestCardIndex();
            setActive(nextIndex);
            window.setTimeout(() => {
                suppressClick = false;
            }, 180);
        }

        dragState = null;
    }

    cards.forEach((card, index) => {
        card.addEventListener('click', event => {
            if (suppressClick) {
                event.preventDefault();
                event.stopPropagation();
                return;
            }
            setActive(index, { focus: true });
        });
    });

    prevButton?.addEventListener('click', () => setActive(activeIndex - 1, { focus: true }));
    nextButton?.addEventListener('click', () => setActive(activeIndex + 1, { focus: true }));

    root.addEventListener('keydown', event => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        setActive(activeIndex + (event.key === 'ArrowRight' ? 1 : -1), { focus: true });
    });

    viewport.addEventListener('pointerdown', event => {
        if (event.button !== 0 || cards.length < 2) return;

        const card = event.target.closest?.('[data-gallery-card]');
        dragState = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            startScrollLeft: viewport.scrollLeft,
            cardIndex: card ? cards.indexOf(card) : -1,
            dragging: false
        };
        root.classList.add('is-pointer-down');

        try {
            viewport.setPointerCapture(event.pointerId);
        } catch (_) {}
    });

    viewport.addEventListener('pointermove', event => {
        if (!dragState || event.pointerId !== dragState.pointerId) return;

        const deltaX = event.clientX - dragState.startX;
        const deltaY = event.clientY - dragState.startY;

        if (!dragState.dragging && Math.abs(deltaX) > 8 && Math.abs(deltaX) > Math.abs(deltaY) * 1.1) {
            dragState.dragging = true;
            root.classList.add('is-dragging');
        }

        if (!dragState.dragging) return;
        event.preventDefault();
        requestScroll(dragState.startScrollLeft - deltaX);
    });

    viewport.addEventListener('pointerup', finishDrag);
    viewport.addEventListener('pointercancel', finishDrag);
    viewport.addEventListener('lostpointercapture', event => {
        if (dragState && event.pointerId === dragState.pointerId) {
            root.classList.remove('is-dragging');
            root.classList.remove('is-pointer-down');
            dragState = null;
        }
    });

    window.addEventListener('resize', () => {
        window.clearTimeout(resizeTimer);
        resizeTimer = window.setTimeout(() => snapToActive({ instant: true }), 120);
    }, { passive: true });

    localizeCards();
    dots = createDots();
    setActive(activeIndex, { instant: true });
}

document.querySelectorAll('[data-gallery-carousel]').forEach(initGalleryCarousel);
