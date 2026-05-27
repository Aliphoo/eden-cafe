const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'Images', 'generated', 'menu');
const MAP_FILE = path.join(OUT_DIR, 'image-map.json');

const PRODUCTS = [
  {
    id: 'lv-95272781',
    slug: 'americano',
    name: 'AMERICANO/อเมริกาโน่',
    imageUrl: 'Images/generated/menu/americano.svg',
    kind: 'hot',
    liquid: '#2b120a',
    crema: '#cf8a48',
    accent: '#2d6b47',
    garnish: 'beans',
  },
  {
    id: 'lv-95273198',
    slug: 'cappuccino',
    name: 'CAPPUCCINO-คาปูชิโน่',
    imageUrl: 'Images/generated/menu/cappuccino.svg',
    kind: 'foam',
    liquid: '#6b351c',
    crema: '#f4dcc2',
    accent: '#b88935',
    garnish: 'cinnamon',
  },
  {
    id: 'lv-252452160',
    slug: 'christmas-delight',
    name: 'Christmas delight',
    imageUrl: 'Images/generated/menu/christmas-delight.svg',
    kind: 'festive',
    liquid: '#8f2530',
    crema: '#fff2dc',
    accent: '#1b6a48',
    garnish: 'berries',
  },
  {
    id: 'lv-95272341',
    slug: 'espresso',
    name: 'ESPRESSO / เอสเปรสโซ่',
    imageUrl: 'Images/generated/menu/espresso.svg',
    kind: 'espresso',
    liquid: '#251006',
    crema: '#c87a35',
    accent: '#1e5b3c',
    garnish: 'beans',
  },
  {
    id: 'lv-95313030',
    slug: 'green-tea',
    name: 'Green Tea/ชาเขียว',
    imageUrl: 'Images/generated/menu/green-tea.svg',
    kind: 'iced',
    liquid: '#6fa55e',
    crema: '#dff2c8',
    accent: '#0d6b48',
    garnish: 'leaf',
  },
  {
    id: 'lv-95273003',
    slug: 'latte',
    name: 'Latte/ลาเต้',
    imageUrl: 'Images/generated/menu/latte.svg',
    kind: 'latte',
    liquid: '#b98555',
    crema: '#f6ead7',
    accent: '#2c6a47',
    garnish: 'milk',
  },
  {
    id: 'lv-95320746',
    slug: 'lemon-ice-tea',
    name: 'Lemon Ice Tea/ชามะนาว',
    imageUrl: 'Images/generated/menu/lemon-ice-tea.svg',
    kind: 'iced',
    liquid: '#c47d28',
    crema: '#ffe58c',
    accent: '#155f43',
    garnish: 'lemon',
  },
  {
    id: 'lv-95283804',
    slug: 'macchiato',
    name: 'MACCHIATO/มัคคิอาโต้',
    imageUrl: 'Images/generated/menu/macchiato.svg',
    kind: 'layered',
    liquid: '#7b3c1d',
    crema: '#fff0d8',
    accent: '#c68b38',
    garnish: 'caramel',
  },
  {
    id: 'lv-152687263',
    slug: 'mocha-malibu-rum',
    name: 'Mocha malibu Rum',
    imageUrl: 'Images/generated/menu/mocha-malibu-rum.svg',
    kind: 'mocha',
    liquid: '#4a2118',
    crema: '#efd4aa',
    accent: '#2c7a5a',
    garnish: 'coconut',
  },
  {
    id: 'lv-95273727',
    slug: 'mocha',
    name: 'MOCHA/มอคค่า',
    imageUrl: 'Images/generated/menu/mocha.svg',
    kind: 'mocha',
    liquid: '#3a1b13',
    crema: '#dfb889',
    accent: '#1f6a47',
    garnish: 'chocolate',
  },
];

function esc(value) {
  return String(value).replace(/[&<>"]/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
  }[char]));
}

function leaf(x, y, rotate, scale = 1, color = '#2f7d55', opacity = 0.28) {
  return `<g transform="translate(${x} ${y}) rotate(${rotate}) scale(${scale})" opacity="${opacity}">
    <path d="M0 0 C56 -70 134 -58 180 -8 C116 0 64 26 0 0Z" fill="${color}"/>
    <path d="M14 -2 C68 -18 116 -20 166 -10" fill="none" stroke="#d9f0df" stroke-width="7" stroke-linecap="round" opacity="0.42"/>
  </g>`;
}

function bean(x, y, rotate, scale = 1) {
  return `<g transform="translate(${x} ${y}) rotate(${rotate}) scale(${scale})">
    <ellipse cx="0" cy="0" rx="34" ry="50" fill="#3a2116"/>
    <path d="M-8 -38 C18 -18 -20 10 8 38" fill="none" stroke="#8c6045" stroke-width="8" stroke-linecap="round"/>
  </g>`;
}

function ice(x, y, rotate, scale = 1) {
  return `<rect x="${x}" y="${y}" width="${74 * scale}" height="${74 * scale}" rx="16" fill="#fff" opacity="0.38" transform="rotate(${rotate} ${x + 37 * scale} ${y + 37 * scale})"/>`;
}

function lemonSlice(x, y, scale = 1) {
  return `<g transform="translate(${x} ${y}) scale(${scale})">
    <circle cx="0" cy="0" r="62" fill="#ffde56" stroke="#fff7bd" stroke-width="12"/>
    <circle cx="0" cy="0" r="31" fill="none" stroke="#fff7bd" stroke-width="4"/>
    ${Array.from({ length: 8 }, (_, i) => `<path d="M0 0 L${Math.cos((Math.PI * 2 * i) / 8) * 58} ${Math.sin((Math.PI * 2 * i) / 8) * 58}" stroke="#fff7bd" stroke-width="4"/>`).join('')}
  </g>`;
}

function cupBase(item, opts = {}) {
  const cup = opts.cup || '#fffaf0';
  const rim = opts.rim || item.crema;
  const scale = opts.scale || 1;
  const cx = 600;
  const y = opts.y || 455;
  const w = (opts.w || 390) * scale;
  const h = (opts.h || 260) * scale;
  const rx = w / 2;
  return `<g filter="url(#softShadow)">
    <ellipse cx="${cx}" cy="${y + h + 142 * scale}" rx="${245 * scale}" ry="${64 * scale}" fill="#efe2c8"/>
    <path d="M${cx - rx} ${y + 40 * scale}
      C${cx - rx + 24 * scale} ${y + h + 28 * scale} ${cx - rx + 78 * scale} ${y + h + 96 * scale} ${cx} ${y + h + 100 * scale}
      C${cx + rx - 78 * scale} ${y + h + 96 * scale} ${cx + rx - 24 * scale} ${y + h + 28 * scale} ${cx + rx} ${y + 40 * scale}
      Z" fill="${cup}" stroke="#ded1ba" stroke-width="${10 * scale}"/>
    <path d="M${cx + rx - 8 * scale} ${y + 98 * scale}
      C${cx + rx + 120 * scale} ${y + 104 * scale} ${cx + rx + 126 * scale} ${y + 258 * scale} ${cx + rx + 8 * scale} ${y + 264 * scale}
      C${cx + rx + 72 * scale} ${y + 218 * scale} ${cx + rx + 74 * scale} ${y + 142 * scale} ${cx + rx - 8 * scale} ${y + 130 * scale}
      Z" fill="none" stroke="#f6efe1" stroke-width="${28 * scale}" stroke-linecap="round"/>
    <ellipse cx="${cx}" cy="${y + 40 * scale}" rx="${rx}" ry="${92 * scale}" fill="${rim}" stroke="#fdf7eb" stroke-width="${18 * scale}"/>
    <ellipse cx="${cx}" cy="${y + 48 * scale}" rx="${rx * 0.78}" ry="${58 * scale}" fill="${item.liquid}" opacity="0.94"/>
  </g>`;
}

function foamArt(item) {
  return `<g opacity="0.96">
    <path d="M480 505 C530 442 666 442 722 505 C658 532 542 532 480 505Z" fill="${item.crema}" opacity="0.94"/>
    <path d="M535 497 C568 468 635 466 670 498" fill="none" stroke="#fff9ec" stroke-width="13" stroke-linecap="round"/>
    <path d="M560 522 C596 505 630 506 656 522" fill="none" stroke="#8d5c38" stroke-width="8" stroke-linecap="round" opacity="0.46"/>
  </g>`;
}

function espresso(item) {
  return `${cupBase(item, { y: 520, w: 270, h: 165, scale: 0.94 })}
    <ellipse cx="600" cy="580" rx="110" ry="33" fill="${item.crema}" opacity="0.82"/>
    ${bean(382, 785, -28, 0.9)}${bean(805, 805, 22, 0.86)}`;
}

function hot(item) {
  return `${cupBase(item)}
    <ellipse cx="600" cy="505" rx="128" ry="42" fill="${item.crema}" opacity="0.45"/>
    <path d="M510 504 C560 482 638 486 692 501" fill="none" stroke="#f5c07e" stroke-width="11" stroke-linecap="round" opacity="0.55"/>
    ${bean(370, 815, -28, 0.82)}${bean(830, 820, 24, 0.78)}`;
}

function foam(item) {
  return `${cupBase(item, { cup: '#fffaf3' })}${foamArt(item)}
    <path d="M462 780 C530 814 668 814 738 780" fill="none" stroke="#c49355" stroke-width="9" stroke-linecap="round" opacity="0.62"/>`;
}

function latte(item) {
  return `${cupBase(item, { cup: '#fff6e4', rim: '#f6ead7' })}${foamArt(item)}
    <path d="M500 508 C548 534 650 534 702 508" fill="none" stroke="#c27a46" stroke-width="9" stroke-linecap="round" opacity="0.58"/>`;
}

function festive(item) {
  return `${cupBase(item, { cup: '#fdf3df', rim: item.crema })}
    <ellipse cx="600" cy="508" rx="130" ry="44" fill="${item.liquid}" opacity="0.82"/>
    <circle cx="505" cy="430" r="22" fill="#b82936"/><circle cx="536" cy="410" r="17" fill="#d64a4d"/>
    <path d="M515 395 C566 348 626 358 652 394" fill="none" stroke="#6a3d22" stroke-width="16" stroke-linecap="round"/>
    ${leaf(715, 392, 18, 0.42, '#1e714d', 0.78)}
    ${leaf(745, 420, -24, 0.35, '#1e714d', 0.72)}
    <path d="M820 744 L910 646" stroke="#7a4a29" stroke-width="18" stroke-linecap="round"/>
    <path d="M850 760 L940 660" stroke="#9f6738" stroke-width="14" stroke-linecap="round"/>`;
}

function iced(item) {
  const isLemon = item.garnish === 'lemon';
  return `<g filter="url(#softShadow)">
    <ellipse cx="600" cy="850" rx="205" ry="58" fill="#eadfc7"/>
    <path d="M420 410 L780 410 L726 850 Q600 906 474 850 Z" fill="#ffffff" opacity="0.42" stroke="#f8f3e7" stroke-width="16"/>
    <path d="M456 535 L744 535 L708 824 Q600 862 492 824 Z" fill="${item.liquid}" opacity="0.9"/>
    <ellipse cx="600" cy="535" rx="144" ry="48" fill="${item.crema}" opacity="${isLemon ? 0.55 : 0.35}"/>
    ${ice(502, 585, -16, 0.82)}${ice(612, 623, 13, 0.72)}${ice(540, 710, 21, 0.65)}
    <path d="M745 385 C825 420 806 500 740 502" fill="none" stroke="#fff" stroke-width="18" opacity="0.46"/>
  </g>
  ${isLemon ? lemonSlice(782, 512, 0.8) : `${leaf(790, 430, 18, 0.45, '#276f49', 0.78)}${leaf(804, 470, -26, 0.34, '#276f49', 0.72)}`}`;
}

function layered(item) {
  return `<g filter="url(#softShadow)">
    <ellipse cx="600" cy="850" rx="205" ry="58" fill="#eadfc7"/>
    <path d="M420 400 L780 400 L725 850 Q600 906 475 850 Z" fill="#ffffff" opacity="0.42" stroke="#f8f3e7" stroke-width="16"/>
    <path d="M457 610 L743 610 L709 824 Q600 862 491 824 Z" fill="${item.liquid}" opacity="0.92"/>
    <path d="M444 506 L756 506 L744 612 L457 612 Z" fill="${item.crema}" opacity="0.92"/>
    <path d="M470 468 C520 515 560 492 606 534 C654 579 692 532 737 574" fill="none" stroke="#b56d2e" stroke-width="18" stroke-linecap="round" opacity="0.6"/>
    <ellipse cx="600" cy="505" rx="150" ry="50" fill="#fff7e8" opacity="0.54"/>
  </g>`;
}

function mocha(item) {
  return `${cupBase(item, { cup: '#fff5e8', rim: item.crema })}
    <ellipse cx="600" cy="508" rx="134" ry="46" fill="${item.liquid}" opacity="0.78"/>
    <circle cx="487" cy="438" r="19" fill="#4d2518" opacity="0.78"/>
    <circle cx="715" cy="424" r="15" fill="#f5eee0" opacity="0.8"/>
    <path d="M490 507 C545 455 638 559 708 496" fill="none" stroke="#fff7e7" stroke-width="14" stroke-linecap="round" opacity="0.8"/>
    ${item.garnish === 'coconut' ? '<path d="M808 762 C850 715 916 724 940 779 C892 820 842 812 808 762Z" fill="#fff7ec" stroke="#b88b5d" stroke-width="9"/>' : ''}
    ${item.garnish === 'chocolate' ? '<rect x="804" y="742" width="120" height="76" rx="12" fill="#4a2118" transform="rotate(-12 864 780)"/><path d="M827 766 L908 747 M838 806 L916 788" stroke="#8d5538" stroke-width="5"/>' : ''}`;
}

function renderProduct(item) {
  const inner = ({
    hot,
    foam,
    festive,
    espresso,
    iced,
    latte,
    layered,
    mocha,
  }[item.kind] || hot)(item);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1200" viewBox="0 0 1200 1200" role="img" aria-label="${esc(item.name)}">
  <defs>
    <radialGradient id="bgGlow" cx="50%" cy="40%" r="72%">
      <stop offset="0%" stop-color="#fffaf0"/>
      <stop offset="58%" stop-color="#f4eddb"/>
      <stop offset="100%" stop-color="#d8e9d7"/>
    </radialGradient>
    <linearGradient id="emeraldWash" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0b4a33" stop-opacity="0.14"/>
      <stop offset="100%" stop-color="#f8f3e7" stop-opacity="0.05"/>
    </linearGradient>
    <filter id="softShadow" x="-30%" y="-30%" width="160%" height="170%">
      <feDropShadow dx="0" dy="28" stdDeviation="26" flood-color="#183929" flood-opacity="0.18"/>
    </filter>
  </defs>
  <rect width="1200" height="1200" fill="url(#bgGlow)"/>
  <rect x="78" y="78" width="1044" height="1044" rx="76" fill="url(#emeraldWash)" stroke="#f8f1df" stroke-width="4"/>
  <circle cx="952" cy="234" r="170" fill="#ffffff" opacity="0.33"/>
  <circle cx="236" cy="946" r="210" fill="#0f5b3f" opacity="0.07"/>
  ${leaf(72, 236, -25, 0.9)}
  ${leaf(1030, 920, 150, 0.72)}
  ${leaf(945, 168, 42, 0.48, item.accent, 0.32)}
  ${inner}
</svg>`;
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const mapping = PRODUCTS.map((product) => {
  const filePath = path.join(OUT_DIR, `${product.slug}.svg`);
  fs.writeFileSync(filePath, renderProduct(product), 'utf8');
  return {
    collection: 'products',
    id: product.id,
    name: product.name,
    imageUrl: product.imageUrl,
  };
});

fs.writeFileSync(MAP_FILE, JSON.stringify({
  generatedAt: new Date().toISOString(),
  note: 'Generated Eden Cafe menu image assets for products using deterministic SVG artwork.',
  items: mapping,
}, null, 2), 'utf8');

console.log(`Generated ${mapping.length} menu images in ${OUT_DIR}`);
console.log(`Mapping: ${MAP_FILE}`);
