// Live check for SXM Radar against the real internet: the published site, the real
// Met Office radar, the real map and cloud tile servers. Read-only; it changes nothing.
// Run: npm run test:live [url]     (default: the GitHub Pages site)
import { chromium } from "playwright-core";
import { mkdirSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "tests/out");
mkdirSync(OUT, { recursive: true });
const SITE = process.argv[2] || "https://sam-mcmahon.github.io/sxm-radar/";

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const base = "/opt/pw-browsers";
  if (existsSync(base)) for (const d of readdirSync(base)) { const p = join(base, d, "chrome-linux/chrome"); if (existsSync(p)) return p; }
  return undefined;
}

// Cloud layer diagnostics: what NASA GIBS advertises for the GOES-East layers we use.
if (process.env.GITHUB_ACTIONS) {
  try {
    const cap = await (await fetch("https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0/WMTSCapabilities.xml")).text();
    for (const id of ["GOES-East_ABI_Band13_Clean_Infrared", "GOES-East_ABI_Band2_Red_Visible_1km", "GOES-East_ABI_GeoColor"]) {
      const i = cap.indexOf(`<ows:Identifier>${id}</ows:Identifier>`);
      if (i < 0) { console.log(`::notice title=gibs::${id}: not in capabilities`); continue; }
      const block = cap.slice(cap.lastIndexOf("<Layer>", i), cap.indexOf("</Layer>", i));
      const tms = (block.match(/<TileMatrixSet>([^<]+)/) || [])[1], fmt = (block.match(/<Format>([^<]+)/) || [])[1];
      const def = (block.match(/<Default>([^<]+)/) || [])[1], val = (block.match(/<Value>([^<]+)/g) || []).slice(-1)[0];
      const tmpl = (block.match(/template="([^"]+)"/) || [])[1];
      console.log(`::notice title=gibs::${id}: tms=${tms} fmt=${fmt} default=${def} last=${val} tmpl=${tmpl}`);
    }
  } catch (e) { console.log(`::notice title=gibs::capabilities fetch failed: ${e.message}`); }
}

const browser = await chromium.launch({ executablePath: chromePath(), args: ["--headless=new"] });
const failures = [], notes = [];
for (const mode of ["dark", "satellite+clouds", "infrared"]) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  if (mode === "infrared") await ctx.addInitScript(() => localStorage.setItem("sxm.clouds", '"ir"'));
  if (mode === "satellite+clouds") await ctx.addInitScript(() => { localStorage.setItem("sxm.satBase", "true"); localStorage.setItem("sxm.clouds", '"color"'); });
  const page = await ctx.newPage();
  const tiles = { ok: 0, bad: [] };
  page.on("pageerror", e => failures.push(`[${mode}] page error: ${e.message}`));
  // The app's scan-name guesses 404 by design, and Esri's label layer has no tiles over open ocean.
  page.on("requestfailed", r => { if (/gibs|arcgis/.test(r.url()) && !/_Reference|World_Boundaries/.test(r.url())) tiles.bad.push(`network ${r.failure()?.errorText} ${r.url().slice(0, 140)}`); });
  page.on("response", r => {
    const u = r.url();
    if (!/arcgisonline|gibs\.earthdata|cartocdn|tile\./.test(u)) return;
    const type = r.headers()["content-type"] || "";
    if (r.status() === 200 && type.startsWith("image/")) tiles.ok++;
    else if (r.status() === 404 && /_Reference|World_Boundaries/.test(u)) return;
    else tiles.bad.push(`${r.status()} ${type} ${u.slice(0, 120)}`);
  });
  await page.goto(SITE, { waitUntil: "load" });
  try {
    await page.waitForFunction(() => {
      const st = document.getElementById("status");
      return (st.hidden && /frames/.test(document.getElementById("tCount").textContent) && !/^0 /.test(document.getElementById("tCount").textContent))
        || /hasn't posted/.test(document.getElementById("statusText").textContent);
    }, null, { timeout: 180000, polling: 1000 });
  } catch { failures.push(`[${mode}] app never found scans nor reported the radar offline within 3 minutes`); }
  await page.waitForTimeout(4000);
  const s = await page.evaluate(() => ({
    count: document.getElementById("tCount").textContent, age: document.getElementById("frameAge").textContent,
    status: document.getElementById("status").hidden ? null : document.getElementById("statusText").textContent,
    trackMsg: document.getElementById("trackMsg").hidden ? null : document.getElementById("trackMsg").textContent,
    cloud: document.getElementById("cloudKind").textContent,
    radar: [...document.querySelectorAll("img.radar-img")].map(i => i.naturalWidth),
  }));
  await page.screenshot({ path: join(OUT, `live-${mode.replace(/\W+/g, "-")}.png`) });
  notes.push(`[${mode}] frames: ${s.count} | age: ${s.age} | status: ${s.status ?? "hidden"} | tracks: ${s.trackMsg ?? "ok"} | clouds: ${s.cloud || "off"} | tiles ok: ${tiles.ok}`);
  if (tiles.ok === 0) failures.push(`[${mode}] no map tiles loaded`);
  if (tiles.bad.length) failures.push(`[${mode}] ${tiles.bad.length} tile(s) failed, e.g. ${tiles.bad[0]}`);
  if (s.status === null && !s.radar.some(w => w === 640)) failures.push(`[${mode}] radar image not showing on the map`);
  if (/✕/.test(s.cloud)) failures.push(`[${mode}] cloud layer failed to load`);
  await ctx.close();
}
await browser.close();
// In GitHub Actions also emit annotations, which show up in `gh run view` without needing the logs.
const gha = !!process.env.GITHUB_ACTIONS;
notes.forEach(n => console.log(gha ? `::notice title=live::${n}` : n));
failures.forEach(f => console.log(gha ? `::error title=live::${f}` : "FAIL " + f));
console.log(failures.length ? `\n${failures.length} problem(s)` : "\nLive check passed");
process.exit(failures.length ? 1 : 0);
