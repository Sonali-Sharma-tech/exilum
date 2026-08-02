// Shared HUD visual language: palette, rarity model, procedural textures,
// DOM/SVG helpers, icon painters. Dark gothic, gold-on-black. No external assets.

// ── Palette ──────────────────────────────────────────────────────────────
export const PAL = {
  gold:      '#c9a227',
  goldLite:  '#f0d97a',
  goldDeep:  '#6b5518',
  ink:       '#05060a',
  panel:     '#0b0c11',
  panelLite: '#14151d',
  iron:      '#1a1c22',
  edge:      '#2a2c34',
  text:      '#cdbb8e',
  textDim:   '#8b8266',
  life:      '#b81f24',
  lifeDeep:  '#4a0c10',
  lifeLite:  '#ff5a4e',
  mana:      '#2a6bd6',
  manaDeep:  '#0a1e52',
  manaLite:  '#63b6ff',
};

// PoE-style rarity model — colours match LootSystem's hex ints exactly.
// Accepts a rarity string key, a numeric tier (0..5), OR a raw hex int.
export const RARITY = {
  normal:   { name: 'Normal',   color: '#c8c8c8', glow: 'rgba(200,200,200,.30)' },
  magic:    { name: 'Magic',    color: '#8888ff', glow: 'rgba(136,136,255,.42)' },
  rare:     { name: 'Rare',     color: '#ffff77', glow: 'rgba(255,255,119,.46)' },
  unique:   { name: 'Unique',   color: '#af6025', glow: 'rgba(175,96,37,.50)'   },
  gem:      { name: 'Gem',      color: '#1ba29b', glow: 'rgba(27,162,155,.42)'  },
  currency: { name: 'Currency', color: '#aa9e82', glow: 'rgba(170,158,130,.40)' },
  quest:    { name: 'Quest',    color: '#54d64a', glow: 'rgba(84,214,74,.42)'   },
};
const TIER_ORDER = ['normal', 'magic', 'rare', 'unique', 'gem', 'currency', 'quest'];

// Convert a THREE-style hex int (0xrrggbb) to a CSS "#rrggbb" string.
export function hexCss(n) {
  if (typeof n !== 'number' || !isFinite(n)) return null;
  return '#' + ((n & 0xffffff) | 0x1000000).toString(16).slice(1);
}

export function rarityKey(v) {
  if (typeof v === 'number') return TIER_ORDER[Math.max(0, Math.min(TIER_ORDER.length - 1, v))];
  const k = String(v || 'normal').toLowerCase();
  return RARITY[k] ? k : 'normal';
}
export function rarityOf(v) { return RARITY[rarityKey(v)]; }

// Damage-type → colour (rubric §7: colour by type, saturation as a currency).
export const DMG_COLOR = {
  physical:  '#ece3cf',
  fire:      '#ff7a2e',
  cold:      '#7fd6ff',
  lightning: '#ffe45e',
  chaos:     '#c65cff',
  poison:    '#7ec843',
  bleed:     '#e0322b',
  crit:      '#fff2b0',
  heal:      '#5ce07a',
};
export function dmgColor(type) { return DMG_COLOR[type] || DMG_COLOR.physical; }

// ── DOM / SVG helpers ────────────────────────────────────────────────────
export function el(tag, cls, parent) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (parent) parent.appendChild(n);
  return n;
}
const SVGNS = 'http://www.w3.org/2000/svg';
export function svg(tag, attrs, parent) {
  const n = document.createElementNS(SVGNS, tag);
  if (attrs) for (const k in attrs) n.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(n);
  return n;
}

export function fmt(n) {
  n = Math.round(n);
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
  if (n >= 1e4) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + 'k';
  return String(n);
}
export const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a, b, t) => a + (b - a) * t;
// framerate-independent exponential approach
export const damp = (a, b, rate, dt) => lerp(a, b, 1 - Math.exp(-rate * dt));

// ── Procedural textures (canvas → data URL, generated once) ───────────────
function noiseCanvas(size, base, streak, grain) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const x = c.getContext('2d');
  x.fillStyle = base;
  x.fillRect(0, 0, size, size);
  // fine grain
  const img = x.getImageData(0, 0, size, size), d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * grain;
    d[i] += n; d[i + 1] += n; d[i + 2] += n;
  }
  x.putImageData(img, 0, 0);
  // brushed/streak lines
  if (streak > 0) {
    x.globalAlpha = 0.06;
    for (let i = 0; i < streak; i++) {
      x.strokeStyle = Math.random() > 0.5 ? '#000' : '#fff';
      x.lineWidth = Math.random() * 1.4 + 0.2;
      const y = Math.random() * size;
      x.beginPath(); x.moveTo(0, y); x.lineTo(size, y + (Math.random() - 0.5) * 3); x.stroke();
    }
    x.globalAlpha = 1;
  }
  return c;
}

let _iron, _parch;
export function ironTexture() {
  if (_iron) return _iron;
  const c = noiseCanvas(256, '#0e0f14', 90, 26);
  const x = c.getContext('2d');
  // corrosion blotches + cavity darkening
  for (let i = 0; i < 40; i++) {
    const gx = Math.random() * 256, gy = Math.random() * 256, r = Math.random() * 40 + 8;
    const g = x.createRadialGradient(gx, gy, 0, gx, gy, r);
    g.addColorStop(0, `rgba(0,0,0,${Math.random() * 0.28})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = g; x.beginPath(); x.arc(gx, gy, r, 0, 7); x.fill();
  }
  _iron = c.toDataURL('image/png');
  return _iron;
}
export function parchmentTexture() {
  if (_parch) return _parch;
  const c = noiseCanvas(256, '#171310', 0, 20);
  const x = c.getContext('2d');
  // warm fibre + aged stains, darker toward edges
  x.globalAlpha = 0.5;
  for (let i = 0; i < 26; i++) {
    const gx = Math.random() * 256, gy = Math.random() * 256, r = Math.random() * 60 + 14;
    const g = x.createRadialGradient(gx, gy, 0, gx, gy, r);
    g.addColorStop(0, `rgba(60,44,22,${Math.random() * 0.22})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = g; x.beginPath(); x.arc(gx, gy, r, 0, 7); x.fill();
  }
  x.globalAlpha = 1;
  const v = x.createRadialGradient(128, 128, 40, 128, 128, 190);
  v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,.55)');
  x.fillStyle = v; x.fillRect(0, 0, 256, 256);
  _parch = c.toDataURL('image/png');
  return _parch;
}

// Publish textures as CSS custom properties once, so panels reference them.
export function installTextures() {
  const r = document.documentElement.style;
  r.setProperty('--tex-iron', `url(${ironTexture()})`);
  r.setProperty('--tex-parch', `url(${parchmentTexture()})`);
}

// ── Procedural skill-icon painters ────────────────────────────────────────
// Each draws a distinct sigil onto a 2d context filling [0..s].
export function drawIcon(x, kind, color, s) {
  x.save();
  x.clearRect(0, 0, s, s);
  // emblem backing: dark forged disc
  const bg = x.createRadialGradient(s * 0.42, s * 0.36, s * 0.05, s * 0.5, s * 0.55, s * 0.62);
  bg.addColorStop(0, '#20222b'); bg.addColorStop(0.7, '#0c0d12'); bg.addColorStop(1, '#050609');
  x.fillStyle = bg; x.fillRect(0, 0, s, s);
  x.translate(s / 2, s / 2);
  const u = s / 32; // unit
  x.lineCap = 'round'; x.lineJoin = 'round';
  const glow = (blur) => { x.shadowColor = color; x.shadowBlur = blur; };
  x.strokeStyle = color; x.fillStyle = color; glow(u * 2.2);

  switch (kind) {
    case 'slash': {
      x.lineWidth = u * 2.2;
      for (const off of [-3, 1]) {
        x.beginPath();
        x.arc(off * u, off * u, 12 * u, Math.PI * 0.15, Math.PI * 0.95);
        x.stroke();
      }
      break;
    }
    case 'flame': {
      x.beginPath();
      x.moveTo(0, 12 * u);
      x.bezierCurveTo(-10 * u, 4 * u, -6 * u, -6 * u, 0, -13 * u);
      x.bezierCurveTo(2 * u, -4 * u, 9 * u, -4 * u, 6 * u, 4 * u);
      x.bezierCurveTo(5 * u, 9 * u, -4 * u, 9 * u, 0, 12 * u);
      const g = x.createLinearGradient(0, 12 * u, 0, -13 * u);
      g.addColorStop(0, '#ffd27a'); g.addColorStop(0.5, color); g.addColorStop(1, '#7a1a00');
      x.fillStyle = g; x.fill();
      break;
    }
    case 'nova': {
      x.lineWidth = u * 1.8;
      x.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 - Math.PI / 2;
        x[i ? 'lineTo' : 'moveTo'](Math.cos(a) * 6 * u, Math.sin(a) * 6 * u);
      }
      x.closePath(); x.stroke();
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        x.beginPath();
        x.moveTo(Math.cos(a) * 7 * u, Math.sin(a) * 7 * u);
        x.lineTo(Math.cos(a) * 13 * u, Math.sin(a) * 13 * u);
        x.stroke();
      }
      break;
    }
    case 'bolt': {
      x.lineWidth = u * 2.4;
      x.beginPath();
      x.moveTo(-2 * u, -13 * u); x.lineTo(-7 * u, 0);
      x.lineTo(0, 1 * u); x.lineTo(-4 * u, 13 * u);
      x.lineTo(8 * u, -3 * u); x.lineTo(1 * u, -2 * u); x.lineTo(6 * u, -13 * u);
      x.closePath(); x.fill();
      break;
    }
    case 'meteor': {
      const g = x.createRadialGradient(3 * u, 3 * u, u, 0, 0, 9 * u);
      g.addColorStop(0, '#ffe3a0'); g.addColorStop(0.6, color); g.addColorStop(1, '#5a1200');
      x.fillStyle = g; x.beginPath(); x.arc(2 * u, 2 * u, 7 * u, 0, 7); x.fill();
      x.lineWidth = u * 1.5; x.strokeStyle = color;
      for (const o of [-5, -1, 3]) { x.beginPath(); x.moveTo(-13 * u, o * u - 8 * u); x.lineTo(-2 * u, -5 * u); x.stroke(); }
      break;
    }
    case 'shock': {
      x.lineWidth = u * 1.8;
      for (const r of [5, 9, 13]) { x.beginPath(); x.arc(0, 2 * u, r * u, Math.PI * 1.05, Math.PI * 1.95); x.stroke(); }
      break;
    }
    case 'arrow': {
      x.lineWidth = u * 2;
      x.beginPath(); x.moveTo(-11 * u, 11 * u); x.lineTo(10 * u, -10 * u); x.stroke();
      x.beginPath(); x.moveTo(10 * u, -10 * u); x.lineTo(3 * u, -10 * u); x.moveTo(10 * u, -10 * u); x.lineTo(10 * u, -3 * u); x.stroke();
      break;
    }
    case 'skull': {
      x.beginPath(); x.arc(0, -2 * u, 8 * u, Math.PI, 0); x.lineTo(6 * u, 8 * u); x.lineTo(-6 * u, 8 * u); x.closePath(); x.fill();
      x.save(); x.shadowBlur = 0; x.fillStyle = '#0a0a0a';
      x.beginPath(); x.arc(-3 * u, -1 * u, 2.4 * u, 0, 7); x.arc(3 * u, -1 * u, 2.4 * u, 0, 7); x.fill();
      x.restore();
      break;
    }
    case 'rune':
    default: {
      x.lineWidth = u * 1.8;
      x.beginPath(); x.arc(0, 0, 10 * u, 0, 7); x.stroke();
      x.beginPath();
      x.moveTo(0, -9 * u); x.lineTo(0, 9 * u);
      x.moveTo(-6 * u, -4 * u); x.lineTo(6 * u, 4 * u);
      x.moveTo(6 * u, -4 * u); x.lineTo(-6 * u, 4 * u);
      x.stroke();
      break;
    }
  }
  x.restore();
}
