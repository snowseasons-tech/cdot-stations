// Loads the running app in headless Chromium and checks that the page works: the station list fills in, the map draws
// its pins, and nothing is logged to the console or blocked by the Content-Security-Policy. The tests (npm test) never
// run the page, so this is what catches a broken script or a CSP regression before it ships.
//   node test/e2e/browser.mjs <base-url>      (e.g. http://127.0.0.1:3999)
import { chromium } from 'playwright';

const base = process.argv[2];
if (!base) {
  console.error('usage: node test/e2e/browser.mjs <base-url>');
  process.exit(2);
}

const problems = [];
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error' || /Content Security Policy/i.test(msg.text())) problems.push(`console: ${msg.text()}`);
  });
  page.on('pageerror', (err) => problems.push(`uncaught: ${err.message}`));
  page.on('requestfailed', (req) => {
    // Map tiles and external links are not the app; only the app's own files count as a failure here.
    if (req.url().startsWith(base)) problems.push(`request failed: ${req.url()} (${req.failure()?.errorText})`);
  });

  const response = await page.goto(base, { waitUntil: 'load' });
  if (!response || !response.ok()) problems.push(`home page returned ${response?.status()}`);

  // Station cards come from /api/stations; the image ships ten stations.
  await page.waitForSelector('#list .card', { timeout: 15000 });
  const cards = await page.locator('#list .card').count();
  if (cards < 10) problems.push(`expected at least 10 station cards, found ${cards}`);

  // Pins are added to the Leaflet map once the stations are loaded. Leaflet itself comes from unpkg (see index.html).
  await page.waitForSelector('#map.leaflet-container', { timeout: 15000 });
  await page.waitForSelector('#map .leaflet-marker-icon .pin', { timeout: 15000 }).catch(() => {});
  const pins = await page.locator('#map .leaflet-marker-icon .pin').count();
  if (pins < 10) problems.push(`expected at least 10 map pins, found ${pins}`);

  // The Content-Security-Policy violations that matter are the ones that stop a script or style from running, which
  // shows up as an error above. Check the layout too: the map must have a size, or it is drawn invisibly.
  const mapBox = await page.locator('#map').boundingBox();
  if (!mapBox || mapBox.width < 100 || mapBox.height < 100) problems.push(`map is not visible (${JSON.stringify(mapBox)})`);

  // Saving a status: an expired sign-in comes back as a redirect to the sign-in page, and a missing token as a 401.
  // Both must tell the person what to do in the editor, not fail silently.
  const saveError = async (status, headers = {}) => {
    await page.route('**/api/stations/*/status', (route) => route.fulfill({ status, headers }));
    await page.locator('#list .card .update-btn').first().click();
    await page.locator('#f-save').click();
    await page.waitForFunction(() => document.getElementById('f-error').textContent !== '', null, { timeout: 5000 });
    const message = await page.locator('#f-error').textContent();
    await page.unroute('**/api/stations/*/status');
    await page.locator('#editor button[value="cancel"]').click();
    return message;
  };
  // The browser logs the rejected save as a failed resource; that is the expected outcome here, so drop it.
  const before = problems.length;
  const expired = await saveError(302, { location: '/sign-in' });
  const needsToken = await saveError(401);
  problems.length = before;
  if (!/sign-in has expired/.test(expired)) problems.push(`expired sign-in message missing (got "${expired}")`);
  if (!/Write token required/.test(needsToken)) problems.push(`write-token message missing (got "${needsToken}")`);

  if (problems.length) {
    console.error('Browser check FAILED:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exitCode = 1;
  } else {
    console.log(`ok   browser check: ${cards} station cards, ${pins} map pins, no console or CSP errors`);
  }
} finally {
  await browser.close();
}
