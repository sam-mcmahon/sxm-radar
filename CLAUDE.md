# SXM Radar

Single-page radar viewer (`index.html`) for the St. Peters, Sint Maarten weather radar, served by GitHub Pages.

## Before reporting any change as done
1. `npm install` (once), then `npm test`. All scenarios must pass. Look at the screenshots in `tests/out/`.
   Locally only Chromium exists; CI also runs WebKit (≈ Safari on iPhone), which is what the user runs.
2. Add a scenario to `tests/smoke.mjs` for any bug found by the user, and confirm it fails on the old code.
3. After pushing, check the GitHub Actions `tests` run: it repeats the offline tests and runs `tests/live.mjs`
   against the real radar, map and cloud servers (this workspace cannot reach them). Report its result,
   including anything it could not verify.

## Facts the code depends on
- Scan images: `https://www.meteosxm.com/radar/meteosxm.com/radar/{displayone|displaytwo}/CAP_Z_010_{150|240}_YYYYMMDDHHMMSS.jpg`, UTC, every 5 min at ~:51 s. Scans appear on the site ~30–40 min after scan time (normal), so "radar quiet" starts at 60 min.
- Image geometry: 640×640, map panel x 0–479 / y 81–559, radar at panel centre (18.041 N, 63.076 W), panel spans ± range km.
- NASA GIBS: Band13 IR max GoogleMapsCompatible_Level6, GeoColor Level7; images publish ~60–70 min after scan time.
- The Met Office server does not allow cross-site pixel reads, so storm tracks need a relay (not built yet).
- Map tiles must come from keyless providers (Esri, NASA GIBS). CARTO now requires an API key.
