const { FieldValue } = require('../shared/firestore');
const { apiError, cleanString } = require('../shared/time');

const DEFAULT_ARCHERY_PRICING = {
  version: '2026-06-default',
  packages: [
    { durationMinutes: 60, price: 350, title: '60 min', active: true },
    { durationMinutes: 120, price: 600, title: '120 min', active: true },
    { durationMinutes: 180, price: 800, title: '180 min', active: true },
  ],
  abilityOptions: [
    { id: 'first_time_with_coach', label: 'First time, coach required', ratePerHour: 50, coachRequired: true, active: true },
    { id: 'experienced_with_coach', label: 'Experienced, coach requested', ratePerHour: 50, coachRequired: true, active: true },
    { id: 'experienced_no_coach', label: 'Experienced, no coach', ratePerHour: 0, coachRequired: false, active: true },
  ],
  equipmentOptions: [
    { id: 'rent_full_set', label: 'Rent full equipment set', ratePerHour: 100, active: true },
    { id: 'bring_own', label: 'Bring own equipment', ratePerHour: 0, active: true },
  ],
};

function finiteMoney(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : fallback;
}

function normalizePackage(item = {}, index = 0) {
  const fallback = DEFAULT_ARCHERY_PRICING.packages[index] || DEFAULT_ARCHERY_PRICING.packages[0];
  const durationMinutes = Number(item.durationMinutes || item.duration_minutes || item.duration || fallback.durationMinutes) || fallback.durationMinutes;
  return {
    durationMinutes,
    price: finiteMoney(item.price || item.amount || item.amountTotal || item.amount_total, fallback.price),
    title: cleanString(item.title || `${durationMinutes} min`, 80),
    active: item.active !== false,
  };
}

function normalizeAbilityOption(item = {}, index = 0) {
  const fallback = DEFAULT_ARCHERY_PRICING.abilityOptions[index] || DEFAULT_ARCHERY_PRICING.abilityOptions[2];
  const id = cleanString(item.id || item.option_id || fallback.id, 80);
  return {
    id,
    label: cleanString(item.label || fallback.label, 120),
    ratePerHour: finiteMoney(item.ratePerHour || item.rate_per_hour || item.rate || 0, fallback.ratePerHour),
    coachRequired: item.coachRequired != null ? item.coachRequired === true : item.coach_required === true || fallback.coachRequired === true,
    active: item.active !== false,
  };
}

function normalizeEquipmentOption(item = {}, index = 0) {
  const fallback = DEFAULT_ARCHERY_PRICING.equipmentOptions[index] || DEFAULT_ARCHERY_PRICING.equipmentOptions[1];
  const id = cleanString(item.id || item.option_id || fallback.id, 80);
  return {
    id,
    label: cleanString(item.label || fallback.label, 120),
    ratePerHour: finiteMoney(item.ratePerHour || item.rate_per_hour || item.rate || 0, fallback.ratePerHour),
    active: item.active !== false,
  };
}

function normalizePricingConfig(data = {}) {
  const pricing = data.pricing || data.bookingOptions || data.booking_options || {};
  const source = Object.keys(pricing).length ? pricing : data;
  const packages = Array.isArray(source.packages) && source.packages.length
    ? source.packages.map(normalizePackage)
    : DEFAULT_ARCHERY_PRICING.packages.map(normalizePackage);
  const abilityOptions = Array.isArray(source.abilityOptions || source.ability_options) && (source.abilityOptions || source.ability_options).length
    ? (source.abilityOptions || source.ability_options).map(normalizeAbilityOption)
    : DEFAULT_ARCHERY_PRICING.abilityOptions.map(normalizeAbilityOption);
  const equipmentOptions = Array.isArray(source.equipmentOptions || source.equipment_options) && (source.equipmentOptions || source.equipment_options).length
    ? (source.equipmentOptions || source.equipment_options).map(normalizeEquipmentOption)
    : DEFAULT_ARCHERY_PRICING.equipmentOptions.map(normalizeEquipmentOption);
  return {
    version: cleanString(source.version || source.pricingVersion || source.pricing_version || DEFAULT_ARCHERY_PRICING.version, 80),
    packages,
    abilityOptions,
    equipmentOptions,
    updatedAt: source.updatedAt || source.updated_at || data.updatedAt || data.updated_at || null,
  };
}

async function loadArcheryPricingConfig(transaction, db) {
  const ref = db.collection('site_settings').doc('archery');
  const snap = transaction ? await transaction.get(ref) : await ref.get();
  return normalizePricingConfig(snap.exists ? snap.data() || {} : {});
}

function optionId(data = {}, snake, camel, fallback) {
  return cleanString(data[snake] || data[camel] || fallback, 80);
}

function normalizePartySize(data = {}) {
  const raw = data.party_size ?? data.partySize ?? data.people ?? data.guest_count ?? data.guestCount ?? 1;
  const partySize = Number(raw);
  if (!Number.isInteger(partySize) || partySize < 1 || partySize > 10) {
    throw apiError('INVALID_PARTY_SIZE', 400, 'party_size must be an integer from 1 to 10');
  }
  return partySize;
}

function findActiveOption(options, id, code) {
  const option = options.find(item => item.id === id);
  if (!option) throw apiError(code, 400, `${id} is not a valid archery option`);
  if (option.active === false) throw apiError(code, 400, `${id} is not active`);
  return option;
}

function calculateArcheryPricing(config, timing, data = {}) {
  const duration = Number(timing.duration_minutes || 0) || 0;
  const hours = duration / 60;
  const packageOption = config.packages.find(item => item.durationMinutes === duration && item.active !== false);
  if (!packageOption) throw apiError('INVALID_DURATION', 400, 'No active package price for this duration');

  const abilityId = optionId(data, 'ability_option_id', 'abilityOptionId', 'experienced_no_coach');
  const equipmentId = optionId(data, 'equipment_option_id', 'equipmentOptionId', 'bring_own');
  const partySize = normalizePartySize(data);
  const ability = findActiveOption(config.abilityOptions, abilityId, 'INVALID_ABILITY_OPTION');
  const equipment = findActiveOption(config.equipmentOptions, equipmentId, 'INVALID_EQUIPMENT_OPTION');

  const packageAmount = finiteMoney(packageOption.price);
  const coachAmount = finiteMoney(ability.ratePerHour * hours);
  const equipmentAmount = finiteMoney(equipment.ratePerHour * hours);
  const perPersonTotal = packageAmount + coachAmount + equipmentAmount;
  const totalPackageAmount = packageAmount * partySize;
  const totalCoachAmount = coachAmount * partySize;
  const totalEquipmentAmount = equipmentAmount * partySize;
  const amountTotal = perPersonTotal * partySize;

  return {
    pricing_version: config.version,
    pricing_updated_at: config.updatedAt || null,
    party_size: partySize,
    required_lane_count: partySize,
    ability_option_id: ability.id,
    ability_label: ability.label,
    coach_required: ability.coachRequired === true,
    coach_rate_per_hour: finiteMoney(ability.ratePerHour),
    coach_amount: totalCoachAmount,
    equipment_option_id: equipment.id,
    equipment_label: equipment.label,
    equipment_rate_per_hour: finiteMoney(equipment.ratePerHour),
    equipment_amount: totalEquipmentAmount,
    package_amount: totalPackageAmount,
    amount_total: amountTotal,
    amount_breakdown: {
      package_per_person: packageAmount,
      coach_per_person: coachAmount,
      equipment_per_person: equipmentAmount,
      per_person_total: perPersonTotal,
      party_size: partySize,
      required_lane_count: partySize,
      package: totalPackageAmount,
      coach: totalCoachAmount,
      equipment: totalEquipmentAmount,
      total: amountTotal,
      hours,
    },
    booking_items: [
      { item_type: 'PACKAGE', label: packageOption.title || `${duration} min`, quantity: partySize, unit_amount: packageAmount, amount: totalPackageAmount, rate_per_hour: null },
      { item_type: 'COACH', label: ability.label, quantity: partySize, unit_amount: coachAmount, amount: totalCoachAmount, rate_per_hour: finiteMoney(ability.ratePerHour) },
      { item_type: 'EQUIPMENT', label: equipment.label, quantity: partySize, unit_amount: equipmentAmount, amount: totalEquipmentAmount, rate_per_hour: finiteMoney(equipment.ratePerHour) },
    ],
  };
}

function pricingUpdatePayload() {
  return {
    pricing: {
      ...DEFAULT_ARCHERY_PRICING,
      updatedAt: FieldValue.serverTimestamp(),
    },
  };
}

module.exports = {
  DEFAULT_ARCHERY_PRICING,
  normalizePricingConfig,
  normalizePartySize,
  loadArcheryPricingConfig,
  calculateArcheryPricing,
  pricingUpdatePayload,
};
