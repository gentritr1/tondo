'use strict';

/**
 * WCAG contrast check for the two text colours against every ground they sit on.
 *
 * PRODUCT.md commits Tondo to WCAG 2.2 AA. Text is two solid tokens, --ink and
 * --ink-2 (the old translucent --ink-1..4 ladder is gone), plus --paper-ink
 * for words on the paper plaque and place card. This reads the live values out
 * of public/styles.css so the check can never drift from what actually ships.
 *
 *   node scripts/check-contrast.js
 *   node scripts/check-contrast.js --against '#0B0908,#14100D,#100C0A'
 *
 * AA is 4.5:1 for body text; every pair below carries words, so every pair is
 * gated at 4.5.
 */

const fs = require('node:fs');
const path = require('node:path');

const CSS = path.join(__dirname, '..', 'public', 'styles.css');

const AA_BODY = 4.5;

function hexToRgb(hex) {
  const h = hex.replace('#', '').trim();
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
}

/** sRGB relative luminance, per WCAG 2.x. */
function luminance([r, g, b]) {
  const f = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function ratio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Pulls `--name: #hex;` out of the stylesheet's :root block. */
function readToken(css, name) {
  const m = css.match(new RegExp(`--${name}\\s*:\\s*(#[0-9a-fA-F]{3,8})\\s*;`));
  return m ? m[1] : null;
}

function main() {
  const css = fs.readFileSync(CSS, 'utf8');

  const argv = process.argv.slice(2);
  const at = argv.indexOf('--against');
  const darks = at >= 0
    ? argv[at + 1].split(',').map((s) => ({ name: s.trim(), hex: s.trim() }))
    : ['page', 'shell', 'tray-bg', 'raise', 'raise-gold', 'raise-alarm'].map((n) => ({ name: n, hex: readToken(css, n) }));
  const pairs = [
    ...['ink', 'ink-2'].map((n) => ({ name: n, hex: readToken(css, n), on: darks })),
    { name: 'paper-ink', hex: readToken(css, 'paper-ink'), on: [{ name: 'paper', hex: readToken(css, 'paper') }] },
    { name: 'gold', hex: readToken(css, 'gold'), on: [{ name: 'raise-gold', hex: readToken(css, 'raise-gold') }] },
    { name: 'alarm', hex: readToken(css, 'alarm'), on: [{ name: 'raise-alarm', hex: readToken(css, 'raise-alarm') }, { name: 'page', hex: readToken(css, 'page') }] },
    { name: 'navy', hex: readToken(css, 'navy'), on: [{ name: 'paper', hex: readToken(css, 'paper') }, { name: 'gold', hex: readToken(css, 'gold') }] },
  ];
  const missing = pairs.filter((p) => !p.hex).map((p) => p.name)
    .concat(pairs.flatMap((p) => p.on).filter((g) => !g.hex).map((g) => g.name));
  if (missing.length) { console.error(`could not read token(s) from styles.css: ${[...new Set(missing)].join(', ')}`); process.exit(1); }

  console.log('\nText colours vs grounds, read live from public/styles.css\n');
  let failures = 0;
  for (const p of pairs) {
    const cells = p.on.map((g) => {
      const r = ratio(hexToRgb(p.hex), hexToRgb(g.hex));
      const ok = r >= AA_BODY;
      if (!ok) failures++;
      return `${g.name} ${r.toFixed(2)}:1 ${ok ? 'PASS' : 'FAIL'}`.padEnd(26);
    });
    console.log(`${(p.name + ' ' + p.hex).padEnd(20)}${cells.join('')}`);
  }
  console.log(`\nGate: ${AA_BODY}:1 for every text colour on every ground it sits on.\n`);
  if (failures) {
    console.error(`FAIL: ${failures} colour/ground combination(s) below AA.\n`);
    process.exit(1);
  }
  console.log('Every text colour clears AA on every ground.\n');
}

main();
