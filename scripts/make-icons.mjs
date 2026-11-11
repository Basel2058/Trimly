// Renders the app icons from one SVG. Run: node scripts/make-icons.mjs  (needs Playwright's Chromium)
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const glyph = (stroke, w) => `
  <g fill="none" stroke="${stroke}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="176" cy="356" r="52"/>
    <circle cx="336" cy="356" r="52"/>
    <path d="M207 314 L352 112"/>
    <path d="M305 314 L160 112"/>
  </g>`;

const icon = (pad, rounded) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3a3a3c"/><stop offset="1" stop-color="#0b0b0c"/></linearGradient></defs>
  <rect width="512" height="512" rx="${rounded ? 112 : 0}" fill="url(#g)"/>
  <g transform="translate(256 256) scale(${pad}) translate(-256 -240)">${glyph('#fff', 30)}</g>
</svg>`;

const badge = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><g transform="translate(0 16)">${glyph('#fff', 40)}</g></svg>`;

const out = new URL('../public/icons/', import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const shot = async (svg, size, file, transparent = false) => {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
  await page.screenshot({ path: out + file, omitBackground: transparent });
  await page.close();
};
await shot(icon(0.86, true), 192, 'icon-192.png', true);
await shot(icon(0.86, true), 512, 'icon-512.png', true);
await shot(icon(0.62, false), 512, 'maskable-512.png');
await shot(icon(0.8, false), 180, 'apple-touch-icon.png');
await shot(badge, 96, 'badge.png', true);
await browser.close();
console.log('icons written to', out);
