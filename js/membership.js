const DEFAULT_TIER_RULES = {
    SILVER: {
        key: 'Silver',
        minPoints: 0,
        minTotalSpent: 0,
        next: 'Gold'
    },
    GOLD: {
        key: 'Gold',
        minPoints: 1200,
        minTotalSpent: 15000,
        next: 'Platinum'
    },
    PLATINUM: {
        key: 'Platinum',
        minPoints: 5000,
        minTotalSpent: 50000,
        next: null
    }
};

const TIER_BENEFITS = {
    Silver: {
        th: ['เริ่มสะสมคะแนนทันที', 'รับข่าวสารและโปรโมชันสมาชิก', 'บันทึกประวัติคำสั่งซื้อและการจอง'],
        en: ['Start earning points immediately', 'Member-only updates and promotions', 'Saved order and booking history']
    },
    Gold: {
        th: ['ได้แต้ม x1.25', 'ส่วนลด 10%', 'Welcome Drink เดือนละ 1 แก้ว', 'Priority Booking'],
        en: ['Earn points x1.25', '10% discount', '1 monthly Welcome Drink', 'Priority Booking']
    },
    Platinum: {
        th: ['ได้แต้ม x1.5', 'ส่วนลด 15%', 'Early Access เมนูใหม่', 'Reserved Zone / Reserved Parking', 'Birthday Wellness Package', 'Exclusive Gift รายปี'],
        en: ['Earn points x1.5', '15% discount', 'Early Access to new menus', 'Reserved Zone / Reserved Parking', 'Birthday Wellness Package', 'Annual Exclusive Gift']
    }
};

const TIER_THEMES = {
    Silver: {
        className: 'member-card--silver',
        badgeClass: 'member-tier-badge--silver',
        accent: '#7b8794'
    },
    Gold: {
        className: 'member-card--gold',
        badgeClass: 'member-tier-badge--gold',
        accent: '#c89b20'
    },
    Platinum: {
        className: 'member-card--platinum',
        badgeClass: 'member-tier-badge--platinum',
        accent: '#0d6b4f'
    }
};

function numberValue(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
}

function ruleValue(source, tier, field, fallback) {
    const direct = source?.[tier]?.[field];
    const upper = source?.[tier.toUpperCase()]?.[field];
    const value = direct ?? upper;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : fallback;
}

export function normalizeTierRules(raw = {}) {
    const source = raw?.membershipTiers || raw?.tierRules || raw || {};
    const goldPoints = Math.max(1, Math.floor(ruleValue(source, 'Gold', 'minPoints', DEFAULT_TIER_RULES.GOLD.minPoints)));
    const goldSpent = Math.max(1, Math.floor(ruleValue(source, 'Gold', 'minTotalSpent', DEFAULT_TIER_RULES.GOLD.minTotalSpent)));
    const platinumPoints = Math.max(goldPoints + 1, Math.floor(ruleValue(source, 'Platinum', 'minPoints', DEFAULT_TIER_RULES.PLATINUM.minPoints)));
    const platinumSpent = Math.max(goldSpent + 1, Math.floor(ruleValue(source, 'Platinum', 'minTotalSpent', DEFAULT_TIER_RULES.PLATINUM.minTotalSpent)));

    return {
        SILVER: {
            ...DEFAULT_TIER_RULES.SILVER,
            minPoints: 0,
            minTotalSpent: 0
        },
        GOLD: {
            ...DEFAULT_TIER_RULES.GOLD,
            minPoints: goldPoints,
            minTotalSpent: goldSpent
        },
        PLATINUM: {
            ...DEFAULT_TIER_RULES.PLATINUM,
            minPoints: platinumPoints,
            minTotalSpent: platinumSpent
        }
    };
}

export function getMemberTier(user = {}, tierRules = DEFAULT_TIER_RULES) {
    const rules = normalizeTierRules(tierRules);
    const points = numberValue(user.points);
    const totalSpent = numberValue(user.totalSpent);

    if (
        points >= rules.PLATINUM.minPoints ||
        totalSpent >= rules.PLATINUM.minTotalSpent
    ) {
        return 'Platinum';
    }

    if (
        points >= rules.GOLD.minPoints ||
        totalSpent >= rules.GOLD.minTotalSpent
    ) {
        return 'Gold';
    }

    return 'Silver';
}

function metricProgress(current, target, label, unit, formatter) {
    const safeTarget = Math.max(1, numberValue(target));
    const value = numberValue(current);
    return {
        key: label,
        unit,
        current: value,
        target: safeTarget,
        remaining: Math.max(0, safeTarget - value),
        percent: Math.max(0, Math.min(100, Math.round((value / safeTarget) * 100))),
        formatter
    };
}

export function getNextTierProgress(user = {}, tierRules = DEFAULT_TIER_RULES) {
    const rules = normalizeTierRules(tierRules);
    const tier = getMemberTier(user, rules);
    const nextTier = rules[tier.toUpperCase()]?.next || null;

    if (!nextTier) {
        return {
            tier,
            nextTier: null,
            percent: 100,
            metric: null,
            remaining: 0,
            completed: true
        };
    }

    const target = rules[nextTier.toUpperCase()];
    const metrics = [
        metricProgress(user.points, target.minPoints, 'points', 'points', value => Math.ceil(value).toLocaleString()),
        metricProgress(user.totalSpent, target.minTotalSpent, 'totalSpent', 'baht', value => Math.ceil(value).toLocaleString())
    ];

    const bestMetric = metrics.sort((a, b) => b.percent - a.percent || a.remaining - b.remaining)[0];

    return {
        tier,
        nextTier,
        percent: bestMetric.percent,
        metric: bestMetric.key,
        unit: bestMetric.unit,
        remaining: bestMetric.remaining,
        completed: false,
        metrics
    };
}

export function getTierBenefits(tier, locale = 'th') {
    const key = TIER_BENEFITS[tier] ? tier : 'Silver';
    return TIER_BENEFITS[key][locale] || TIER_BENEFITS[key].th;
}

export function getTierTheme(tier) {
    return TIER_THEMES[tier] || TIER_THEMES.Silver;
}

export function getTierRules(tierRules = DEFAULT_TIER_RULES) {
    return JSON.parse(JSON.stringify(normalizeTierRules(tierRules)));
}
