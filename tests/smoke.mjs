// Offline browser tests for SXM Radar.
// Loads index.html in headless Chromium with every network request intercepted:
// radar scans come from tests/fixtures (named with timestamps relative to "now"),
// map/cloud tiles get a blank PNG, Leaflet comes from node_modules.
// Run: npm test            (screenshots land in tests/out/)
import { chromium } from "playwright-core";
import { readFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIX = join(ROOT, "tests/fixtures");
const OUT = join(ROOT, "tests/out");
mkdirSync(OUT, { recursive: true });

const BLANK_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
const TILE_HOSTS_OK = ["server.arcgisonline.com", "gibs.earthdata.nasa.gov"]; // keyless providers
const TILE_HOSTS_BAD = ["basemaps.cartocdn.com", "tile.thunderforest.com", "api.mapbox.com", "maps.googleapis.com"];

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const base = "/opt/pw-browsers";
  if (existsSync(base)) for (const d of readdirSync(base)) {
    const p = join(base, d, "chrome-linux/chrome");
    if (existsSync(p)) return p;
  }
  return undefined; // let playwright find its own
}

const pad = n => String(n).padStart(2, "0");
const stamp = d => d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds());

// Build a scan schedule: `count` scans every 5 min, newest `ageMin` minutes ago, seconds jittering around :51.
function schedule(count, ageMin) {
  const now = new Date(); now.setUTCSeconds(0, 0);
  const latest = new Date(+now - ageMin * 60000);
  latest.setUTCMinutes(latest.getUTCMinutes() - (latest.getUTCMinutes() % 5));
  const jitter = [51, 52, 50, 51, 53, 51];
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(+latest - (count - 1 - i) * 5 * 60000);
    d.setUTCSeconds(jitter[i % jitter.length]);
    return d;
  });
}

async function scenario(browser, name, { scans = [], cors = true, expect, timeout = 60000 }) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = [], tileHosts = new Set();
  page.on("pageerror", e => errors.push("pageerror: " + e.message));
  page.on("console", m => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push("console: " + m.text()); });

  const files = new Map(); // filename -> fixture path
  scans.forEach((d, i) => {
    files.set(`CAP_Z_010_150_${stamp(d)}.jpg`, join(FIX, `storm_150_${i % 6}.jpg`));
    files.set(`CAP_Z_010_240_${stamp(d)}.jpg`, join(FIX, `storm_240_${i % 6}.jpg`));
  });

  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.hostname === "app.test") {
      const p = url.pathname === "/" ? "/index.html" : url.pathname;
      const f = join(ROOT, p);
      if (!existsSync(f)) return route.fulfill({ status: 404 });
      const type = p.endsWith(".html") ? "text/html" : p.endsWith(".png") ? "image/png" : p.endsWith(".webmanifest") ? "application/manifest+json" : "application/octet-stream";
      return route.fulfill({ status: 200, contentType: type, body: readFileSync(f) });
    }
    if (url.hostname === "cdnjs.cloudflare.com" && url.pathname.includes("/leaflet/")) {
      const isCss = url.pathname.endsWith(".css");
      return route.fulfill({ status: 200, contentType: isCss ? "text/css" : "text/javascript",
        body: readFileSync(join(ROOT, "node_modules/leaflet/dist", isCss ? "leaflet.css" : "leaflet.js")) });
    }
    if (url.hostname === "www.meteosxm.com") {
      // Test-supplied responses bypass Chromium's CORS check, so emulate a server that blocks
      // cross-site pixel reads the way the app experiences it: the crossOrigin load fails.
      if (!cors && route.request().url().includes("?px")) return route.abort("accessdenied");
      const fname = url.pathname.split("/").pop();
      const f = files.get(fname);
      if (!f) return route.fulfill({ status: 404, contentType: "text/html", body: "not found" });
      const headers = cors ? { "Access-Control-Allow-Origin": "*" } : {};
      return route.fulfill({ status: 200, contentType: "image/jpeg", headers, body: readFileSync(f) });
    }
    if ([...TILE_HOSTS_OK, ...TILE_HOSTS_BAD].some(h => url.hostname.endsWith(h))) {
      tileHosts.add(url.hostname);
      return route.fulfill({ status: 200, contentType: "image/png", body: BLANK_PNG, headers: { "Access-Control-Allow-Origin": "*" } });
    }
    if (url.hostname.includes("fonts.g")) return route.abort();
    tileHosts.add(url.hostname);
    return route.fulfill({ status: 404 });
  });

  const t0 = Date.now();
  await page.goto("https://app.test/");
  let result;
  try {
    await page.waitForFunction(expect.ready, null, { timeout, polling: 500 });
    result = await page.evaluate(() => ({
      status: document.getElementById("status").hidden ? null : document.getElementById("statusText").textContent,
      statusVisible: getComputedStyle(document.getElementById("status")).display !== "none",
      count: document.getElementById("tCount").textContent,
      age: document.getElementById("frameAge").textContent,
      trackMsg: document.getElementById("trackMsg").hidden ? null : document.getElementById("trackMsg").textContent,
      radarImgs: [...document.querySelectorAll("img.radar-img")].map(i => ({ w: i.naturalWidth, filter: getComputedStyle(i).filter })),
      cells: document.querySelectorAll("path.leaflet-interactive").length,
      overflowX: document.documentElement.scrollWidth > window.innerWidth,
    }));
  } catch (e) {
    result = { timeout: true, statusText: await page.$eval("#statusText", el => el.textContent).catch(() => "?") };
  }
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  await ctx.close();

  const failures = [];
  if (result.timeout) failures.push(`did not reach the expected state within ${timeout / 1000}s (status: "${result.statusText}")`);
  else failures.push(...expect.check(result));
  failures.push(...errors);
  const bad = [...tileHosts].filter(h => TILE_HOSTS_BAD.some(b => h.endsWith(b)));
  if (bad.length) failures.push("requests tiles from a provider that needs an API key: " + bad.join(", "));
  const unknown = [...tileHosts].filter(h => ![...TILE_HOSTS_OK, ...TILE_HOSTS_BAD].some(b => h.endsWith(b)));
  if (unknown.length) failures.push("requests from an unexpected host (check it needs no key): " + unknown.join(", "));
  return { name, secs: ((Date.now() - t0) / 1000).toFixed(1), failures, result };
}

const loaded = () => document.getElementById("tCount").textContent.startsWith("6 frames") && document.getElementById("status").hidden;
const common = r => {
  const f = [];
  if (r.statusVisible) f.push("the searching/status box is still covering the map");
  if (r.overflowX) f.push("page scrolls sideways at phone width");
  return f;
};

const SCENARIOS = {
  "live-radar": {
    scans: schedule(6, 2),
    expect: {
      ready: () => document.getElementById("tCount").textContent.startsWith("6 frames") && document.getElementById("status").hidden
        && document.querySelectorAll("path.leaflet-interactive").length > 0,
      check: r => [...common(r),
        ...(r.radarImgs.length && r.radarImgs.every(i => i.w === 640) ? [] : ["radar image did not load on the map"]),
        ...(r.radarImgs.every(i => i.filter.includes("echoKey")) ? [] : ["rain-colour filter is not applied to the radar image"]),
        ...(/latest/.test(r.age) ? [] : [`age label should say latest, got "${r.age}"`]),
        ...(r.cells > 0 ? [] : ["no storm cell was tracked"]),
        ...(r.trackMsg ? [`unexpected track message: ${r.trackMsg}`] : []),
      ],
    },
  },
  "radar-quiet-2h": {
    scans: schedule(6, 125), timeout: 90000,
    expect: {
      ready: loaded,
      check: r => [...common(r), ...(/radar quiet/.test(r.age) ? [] : [`stale scans should be labelled "radar quiet", got "${r.age}"`])],
    },
  },
  "radar-offline": {
    scans: [], timeout: 120000,
    expect: {
      ready: () => /hasn't posted/.test(document.getElementById("statusText").textContent),
      check: r => (r.status && /hasn't posted/.test(r.status) ? [] : ["offline message not shown"]),
    },
  },
  "no-pixel-access": {
    scans: schedule(6, 2), cors: false,
    expect: {
      ready: () => document.getElementById("tCount").textContent.startsWith("6 frames") && document.getElementById("status").hidden && !document.getElementById("trackMsg").hidden,
      check: r => [...common(r), ...(/unavailable/.test(r.trackMsg || "") ? [] : ["should explain that tracks are unavailable"])],
    },
  },
};

const only = process.argv[2];
const browser = await chromium.launch({ executablePath: chromePath(), args: ["--headless=new"] });
let failed = 0;
for (const [name, cfg] of Object.entries(SCENARIOS)) {
  if (only && only !== name) continue;
  const r = await scenario(browser, name, cfg);
  const ok = r.failures.length === 0;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  (${r.secs}s)`);
  r.failures.forEach(f => console.log("      - " + f));
}
await browser.close();
console.log(failed ? `\n${failed} scenario(s) failed` : "\nAll scenarios passed");
process.exit(failed ? 1 : 0);
