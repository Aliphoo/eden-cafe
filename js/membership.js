const TIER_RULES = {
    SILVER: {
        key: 'Silver',
        minPoints: 0,
        minTotalSpent: 0,
        minVisitCount: 0,
        next: 'Gold'
    },
    GOLD: {
        key: 'Gold',
        minPoints: 1200,
        minTotalSpent: 15000,
        minVisitCount: 15,
        next: 'Platinum'
    },
    PLATINUM: {
        key: 'Platinum',
        minPoints: 5000,
        minTotalSpent: 50000,
        minVisitCount: 50,
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

export function getMemberTier(user = {}) {
    const points = numberValue(user.points);
    const totalSpent = numberValue(user.totalSpent);
    const visitCount = numberValue(user.visitCount);

    if (
        points >= TIER_RULES.PLATINUM.minPoints ||
        totalSpent >= TIER_RULES.PLATINUM.minTotalSpent ||
        visitCount >= TIER_RULES.PLATINUM.minVisitCount
    ) {
        return 'Platinum';
    }

    if (
        points >= TIER_RULES.GOLD.minPoints ||
        totalSpent >= TIER_RULES.GOLD.minTotalSpent ||
        visitCount >= TIER_RULES.GOLD.minVisitCount
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

export function getNextTierProgress(user = {}) {
    const tier = getMemberTier(user);
    const nextTier = TIER_RULES[tier.toUpperCase()]?.next || null;

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

    const target = TIER_RULES[nextTier.toUpperCase()];
    const metrics = [
        metricProgress(user.points, target.minPoints, 'points', 'points', value => Math.ceil(value).toLocaleString()),
        metricProgress(user.totalSpent, target.minTotalSpent, 'totalSpent', 'baht', value => Math.ceil(value).toLocaleString()),
        metricProgress(user.visitCount, target.minVisitCount, 'visitCount', 'visits', value => Math.ceil(value).toLocaleString())
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

export function getTierRules() {
    return JSON.parse(JSON.stringify(TIER_RULES));
}
