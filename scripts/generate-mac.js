/**
 * Generate Macintosh 128K sprites to replace the PC furniture.
 *
 * Writes into webview-ui/public/assets/furniture/PC/, keeping the same
 * filenames and 16×32 dimensions so existing layouts keep referencing
 * them unchanged. Top 16px is the above-desk background tile (the Mac
 * body); bottom 16px is the on-desk tile (keyboard + mouse).
 *
 * Palette matches the existing PC / office furniture tones:
 *   O = outline    #3F3740
 *   S = shadow     #757B7C
 *   M = body       #B5BFC7
 *   L = highlight  #E1E3E9
 *   W = white      #FFFFFF
 *   B = screen off #391624  (dim phosphor, matches old PC)
 *   X = screen on  #E1E3E9
 *   K = cursor/text on bright screen  #3F3740
 *   R = Apple logo accent pixel  #CC6040
 *
 * Run: node scripts/generate-mac.js
 */

const { PNG } = require('pngjs');
const fs = require('fs');
const path = require('path');

const W = 16;
const H = 32;
const OUT_DIR = path.join(__dirname, '..', 'webview-ui', 'public', 'assets', 'furniture', 'PC');

const C = {
  '.': null,
  'O': '#3F3740',
  'S': '#757B7C',
  'M': '#B5BFC7',
  'L': '#E1E3E9',
  'W': '#FFFFFF',
  'B': '#391624',
  'X': '#E1E3E9',
  'K': '#3F3740',
  'R': '#CC6040',
};

function rgba(hex) {
  if (!hex) return [0, 0, 0, 0];
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
    255,
  ];
}

function writeSprite(filename, rows) {
  if (rows.length !== H) throw new Error(`${filename}: expected ${H} rows, got ${rows.length}`);
  const png = new PNG({ width: W, height: H });
  for (let y = 0; y < H; y++) {
    const row = rows[y];
    if (row.length !== W) throw new Error(`${filename}: row ${y} has ${row.length} cols (expected ${W}): "${row}"`);
    for (let x = 0; x < W; x++) {
      const ch = row[x];
      if (!(ch in C)) throw new Error(`${filename}: unknown glyph "${ch}" at ${x},${y}`);
      const [r, g, b, a] = rgba(C[ch]);
      const i = (y * W + x) * 4;
      png.data[i] = r;
      png.data[i + 1] = g;
      png.data[i + 2] = b;
      png.data[i + 3] = a;
    }
  }
  fs.writeFileSync(path.join(OUT_DIR, filename), PNG.sync.write(png));
  console.log(`wrote ${filename}`);
}

// ── FRONT ──────────────────────────────────────────────────────────
// 14-column case (cols 1-14), 15 rows tall (rows 0-14). Screen is
// 8 wide × 5 tall (cols 4-11, rows 4-8) with a 1-px black bezel.
// Apple logo (red accent pixel) below screen on the left. Floppy
// drive slot horizontal dark line right-of-center. Bottom tile is
// keyboard (11 wide, cols 1-11) + mouse (3 wide, cols 12-14).

function buildFront({ screen }) {
  const [sr0, sr1, sr2, sr3, sr4] = screen;
  for (const r of screen) if (r.length !== 8) throw new Error('screen row must be 8 chars');

  const rows = [
    //          0123456789ABCDEF
    /* 0 */    '.OOOOOOOOOOOOOO.',
    /* 1 */    '.OLLLLLLLLLLLLSO',
    /* 2 */    '.OLMMMMMMMMMMMSO',
    /* 3 */    '.OMOOOOOOOOOOMSO',
    /* 4 */    '.OMO' + sr0 + 'OMSO',
    /* 5 */    '.OMO' + sr1 + 'OMSO',
    /* 6 */    '.OMO' + sr2 + 'OMSO',
    /* 7 */    '.OMO' + sr3 + 'OMSO',
    /* 8 */    '.OMO' + sr4 + 'OMSO',
    /* 9 */    '.OMOOOOOOOOOOMSO',
    /* 10*/    '.OMMRMMMMMMMMMSO',
    /* 11*/    '.OMMMMMOOOOMOMSO',
    /* 12*/    '.OMMMMMMMMMMMMSO',
    /* 13*/    '.OSSSSSSSSSSSSSO',
    /* 14*/    '.OOOOOOOOOOOOOO.',
    /* 15*/    '................',
  ];

  return rows.concat(keyboardAndMouse());
}

// Shared bottom tile: flat Mac keyboard (cols 1-11) + square mouse
// (cols 13-15). Keys render as alternating light/body pixels for a
// chiclet look, then a uniform spacebar row below.
function keyboardAndMouse() {
  return [
    //          0123456789ABCDEF
    /*16*/     '................',
    /*17*/     '................',
    /*18*/     '.OOOOOOOOOOO.OO.',
    /*19*/     '.OLLLLLLLLLO.OOO',
    /*20*/     '.OLOLOLOLOLO.OLO',
    /*21*/     '.OMLMLMLMLMO.OMO',
    /*22*/     '.OMMMMMMMMMO.OOO',
    /*23*/     '.OOOOOOOOOOO....',
    /*24*/     '................',
    /*25*/     '................',
    /*26*/     '................',
    /*27*/     '................',
    /*28*/     '................',
    /*29*/     '................',
    /*30*/     '................',
    /*31*/     '................',
  ];
}

// Screen patterns (8 cols × 5 rows each). X = lit phosphor, K = dark
// pixel (cursor / text glyphs). For OFF we fill with B.
const SCREEN_OFF = [
  'BBBBBBBB',
  'BBBBBBBB',
  'BBBBBBBB',
  'BBBBBBBB',
  'BBBBBBBB',
];
// Bright Mac screen with a simulated "hello" line + blinking cursor.
// At this resolution we can only gesture — a short dark run and a
// single cursor dot on the next line.
const SCREEN_ON_1 = [
  'XXXXXXXX',
  'XKXKKKXX',  // "hello" stub
  'XXXXXXXX',
  'XKXXXXXX',  // cursor lit
  'XXXXXXXX',
];
const SCREEN_ON_2 = [
  'XXXXXXXX',
  'XKXKKKXX',
  'XXXXXXXX',
  'XXXXXXXX',  // cursor blink off
  'XXXXXXXX',
];
const SCREEN_ON_3 = [
  'XXXXXXXX',
  'XKXKKKXX',
  'XXXXXXXX',
  'XKKXXXXX',  // cursor + typed char
  'XXXXXXXX',
];

// ── BACK ───────────────────────────────────────────────────────────
// Back of the Mac has a handle cutout at the top, horizontal vent
// slits, and a power switch / port cluster near the bottom.

function buildBack() {
  const rows = [
    //          0123456789ABCDEF
    /* 0 */    '.OOOOOOOOOOOOOO.',
    /* 1 */    '.OMMMMMOOOOMMMMO',   // handle cutout
    /* 2 */    '.OLMMMMMMMMMMMSO',
    /* 3 */    '.OMSSSSSSSSSSSMO',   // vent 1
    /* 4 */    '.OMMMMMMMMMMMMSO',
    /* 5 */    '.OMSSSSSSSSSSSMO',   // vent 2
    /* 6 */    '.OMMMMMMMMMMMMSO',
    /* 7 */    '.OMSSSSSSSSSSSMO',   // vent 3
    /* 8 */    '.OMMMMMMMMMMMMSO',
    /* 9 */    '.OMSSSSSSSSSSSMO',   // vent 4
    /*10*/     '.OMMMMMMMMMMMMSO',
    /*11*/     '.OMMOMMOMMMMOOSO',   // switch + connectors
    /*12*/     '.OMMMMMMMMMMMMSO',
    /*13*/     '.OSSSSSSSSSSSSSO',
    /*14*/     '.OOOOOOOOOOOOOO.',
    /*15*/     '................',
  ].concat(keyboardAndMouseBack());
  return rows;
}

// Keyboard + mouse rendered from behind: just the dark back edge.
// Keyboard cols 1-11 (11 wide), gap col 12, mouse cols 13-15 (3 wide).
function keyboardAndMouseBack() {
  return [
    //          0123456789ABCDEF
    /*16*/     '................',
    /*17*/     '................',
    /*18*/     '.OOOOOOOOOOO.OOO',
    /*19*/     '.OSSSSSSSSSO.OSO',
    /*20*/     '.OMMMMMMMMMO.OMO',
    /*21*/     '.OOOOOOOOOOO.OOO',
    /*22*/     '................',
    /*23*/     '................',
    /*24*/     '................',
    /*25*/     '................',
    /*26*/     '................',
    /*27*/     '................',
    /*28*/     '................',
    /*29*/     '................',
    /*30*/     '................',
    /*31*/     '................',
  ];
}

// ── SIDE ───────────────────────────────────────────────────────────
// Profile view: the CRT bulges toward the back so the upper half is
// wider than the base. Front face (flat) is on the right; the back is
// on the left. Keyboard/mouse shown edge-on.

function buildSide() {
  const rows = [
    //          0123456789ABCDEF
    /* 0 */    '....OOOOOOOOOO..',   // rounded top
    /* 1 */    '...OLMMMMMMMMSO.',
    /* 2 */    '..OLMMMMMMMMMMSO',   // shoulder widens
    /* 3 */    '..OMMMMMMMMMMMSO',
    /* 4 */    '..OMMMMMMMMMMMSO',   // CRT section
    /* 5 */    '..OMMMMMMMMMMMSO',
    /* 6 */    '..OMMMMMMMMMMMSO',
    /* 7 */    '..OMMMMMMMMMMMSO',
    /* 8 */    '..OMMMMMMMMMMMSO',
    /* 9 */    '..OMMMMMMMMMMMSO',
    /*10*/     '...OMMMMMMMMMSO.',   // narrows below
    /*11*/     '...OMMMMMMMMMSO.',
    /*12*/     '...OMMMMMMMMMSO.',
    /*13*/     '...OSSSSSSSSSSO.',
    /*14*/     '...OOOOOOOOOOO..',
    /*15*/     '................',
    /*16*/     '................',
    /*17*/     '................',
    /*18*/     '..OOOOOOOOOO.OOO',
    /*19*/     '..OLLLLLLLLO.OLO',
    /*20*/     '..OMMMMMMMMO.OMO',
    /*21*/     '..OOOOOOOOOO.OOO',
    /*22*/     '................',
    /*23*/     '................',
    /*24*/     '................',
    /*25*/     '................',
    /*26*/     '................',
    /*27*/     '................',
    /*28*/     '................',
    /*29*/     '................',
    /*30*/     '................',
    /*31*/     '................',
  ];
  return rows;
}

writeSprite('PC_FRONT_OFF.png',  buildFront({ screen: SCREEN_OFF }));
writeSprite('PC_FRONT_ON_1.png', buildFront({ screen: SCREEN_ON_1 }));
writeSprite('PC_FRONT_ON_2.png', buildFront({ screen: SCREEN_ON_2 }));
writeSprite('PC_FRONT_ON_3.png', buildFront({ screen: SCREEN_ON_3 }));
writeSprite('PC_BACK.png',       buildBack());
writeSprite('PC_SIDE.png',       buildSide());
console.log('done');
