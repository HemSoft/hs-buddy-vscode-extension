/**
 * Generate the hs-buddy-icons.woff2 icon font from the source SVG.
 * 
 * The source SVG has a non-square viewBox (1708x1202). This script
 * wraps it in a square canvas so the glyph renders correctly in VS Code's
 * status bar (which uses a 1em×1em square for codicons).
 */
import { createReadStream, readFileSync, writeFileSync } from 'fs';
import { Readable } from 'stream';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { SVGIcons2SVGFontStream } = require('svgicons2svgfont');
const svg2ttf = require('svg2ttf');
const ttf2woff2Module = require('ttf2woff2');
const ttf2woff2 = ttf2woff2Module.default ?? ttf2woff2Module;

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const srcSvg = join(projectRoot, 'assets', 'icons', 'hs-buddy.svg');
const outWoff2 = join(projectRoot, 'assets', 'fonts', 'hs-buddy-icons.woff2');

// Read source SVG and re-wrap in a square viewBox
const original = readFileSync(srcSvg, 'utf8');
// Extract the inner content (paths etc.) between the <svg> tags
const innerMatch = original.match(/<svg[^>]*>([\s\S]*)<\/svg>/);
if (!innerMatch) throw new Error('Could not parse SVG');
const innerContent = innerMatch[1];

// Original viewBox: 0 0 1708 1202
// Make it square with ~15% padding on each side so the glyph doesn't fill
// the full em-square (which causes clipping in VS Code's status bar).
// Content is 1708 wide × 1202 tall. We use a 2200×2200 canvas:
//   X offset: -(2200-1708)/2 = -246
//   Y offset: -(2200-1202)/2 = -499
const squareSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-246 -499 2200 2200" fill="currentColor">${innerContent}</svg>`;

// Create SVG font
const fontStream = new SVGIcons2SVGFontStream({
  fontName: 'hs-buddy-icons',
  fontHeight: 1024,
  normalize: true,
  log: () => {},
});

const chunks = [];
fontStream.on('data', (chunk) => chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk));

await new Promise((resolve, reject) => {
  fontStream.on('finish', resolve);
  fontStream.on('error', reject);

  // Create a readable stream from the square SVG string
  const glyph = new Readable();
  glyph.push(squareSvg);
  glyph.push(null);
  
  // Set metadata for the glyph
  glyph.metadata = {
    name: 'hs-buddy-icon',
    unicode: ['\uEA01'],
  };

  fontStream.write(glyph);
  fontStream.end();
});

const svgFont = Buffer.concat(chunks).toString('utf8');

// Convert SVG font → TTF → WOFF2
const ttf = svg2ttf(svgFont, {});
const woff2 = ttf2woff2(Buffer.from(ttf.buffer));

writeFileSync(outWoff2, woff2);
console.log(`Generated ${outWoff2} (${woff2.length} bytes)`);
