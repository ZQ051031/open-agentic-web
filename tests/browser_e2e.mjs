import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { startServer, freePort } from './http_server.mjs';

const chromePath = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].find(
  (command) => spawnSync(command, ['--version'], { stdio: 'ignore' }).status === 0,
);
if (!chromePath) {
  console.log('SKIP browser E2E: Chrome is not installed.');
  process.exit(0);
}

class CDP {
  constructor(socket) {
    this.socket = socket;
    this.id = 0;
    this.pending = new Map();
    this.errors = [];
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(Error(message.error.message));
        else pending.resolve(message.result);
      }
      if (message.method === 'Runtime.exceptionThrown') this.errors.push(message.params.exceptionDetails.text);
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
        this.errors.push('console.error: ' + message.params.args.map((arg) => arg.value || arg.description).join(' '));
      }
      if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
        this.errors.push(message.params.entry.text);
      }
    });
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Error('CDP timeout: ' + method));
      }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const response = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (response.exceptionDetails)
      throw Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    return response.result.value;
  }
  async wait(expression) {
    const start = Date.now();
    while (Date.now() - start < 20000) {
      if (await this.evaluate(expression)) return;
      await delay(40);
    }
    throw Error('Browser condition timed out: ' + expression);
  }
  async click(selector) {
    await this.evaluate(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw Error('Missing control'); el.click(); })()`,
    );
  }
  async navigate(url) {
    await this.send('Page.navigate', { url });
    await this.wait(`location.href === ${JSON.stringify(url)} && document.body?.dataset.ready === 'true'`);
  }
  async screenshot(path) {
    await this.evaluate('document.fonts.ready');
    const { data } = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(path, Buffer.from(data, 'base64'));
    console.log('SCREENSHOT ' + path);
  }
}

const shots = '/home/ubuntu/wayfinder-shots';
await mkdir(shots, { recursive: true });
const profileDir = await mkdtemp(join(shots, 'chrome-profile-'));
const server = await startServer();
const port = await freePort();
const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + profileDir,
    '--window-size=1440,900',
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] },
);
let chromeLog = '';
chrome.stderr.on('data', (chunk) => {
  chromeLog = (chromeLog + chunk).slice(-4000);
});
let socket;
try {
  let target;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const targets = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
      target = targets.find((item) => item.type === 'page');
      if (target) break;
    } catch {
      /* Wait for Chrome's debugging socket. */
    }
    await delay(50);
  }
  assert(target, 'Chrome CDP startup failed: ' + chromeLog);
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve);
    socket.addEventListener('error', reject);
  });
  const page = new CDP(socket);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Log.enable');
  await page.send('Network.enable');
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.navigate(server.origin + '/');
  console.log('PASS browser: page ready, local inference badge and 3 goal chips');
  assert.match(await page.evaluate(`document.querySelector('#inference-badge').textContent`), /Local rule-based/);
  assert.equal(await page.evaluate(`document.querySelectorAll('.example-chip').length`), 3);
  await page.click('#skip-animation');
  // Once loaded, all three local planning runs must work without a network connection.
  await page.send('Network.emulateNetworkConditions', {
    offline: true,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  for (let index = 0; index < 3; index++) {
    await page.click('.example-chip:nth-child(' + (index + 1) + ')');
    await page.click('#run-button');
    await page.wait(
      `!document.querySelector('#run-button').disabled && document.querySelector('#activity-state').textContent === 'Complete'`,
    );
    assert((await page.evaluate(`document.querySelectorAll('.timeline-item').length`)) > 0);
    assert((await page.evaluate(`document.querySelectorAll('.transit-leg').length`)) > 0);
    assert.match(await page.evaluate(`document.querySelector('.transit-description').textContent`), /min.*HK\$/);
    assert.equal(await page.evaluate(`document.querySelector('#budget-badge').textContent`), 'Within budget');
    assert.equal(await page.evaluate(`document.querySelector('#error-banner').hidden`), true);
    console.log('PASS offline example ' + (index + 1) + ': visits and transit rendered, within budget, trace complete');
  }
  const before = await page.evaluate(`Number(document.querySelector('#total-hkd').dataset.total)`);
  await page.evaluate(
    `Array.from(document.querySelectorAll('.timeline-item')).find(row => row.querySelector('.stop-price').textContent !== 'Free').querySelector('.remove').click()`,
  );
  const after = await page.evaluate(`Number(document.querySelector('#total-hkd').dataset.total)`);
  assert(before !== after);
  console.log('PASS edit: removing a paid stop changed total HK$' + before + ' → HK$' + after);
  await page.evaluate(
    `document.querySelector('#place-search').value = 'Hutong'; document.querySelector('#place-search').dispatchEvent(new Event('input'));`,
  );
  await page.click('#add-place-button');
  assert.equal(await page.evaluate(`document.querySelector('#budget-badge').textContent`), 'Over budget');
  console.log('PASS edit: added expensive stop and displayed over-budget explanation');
  await page.evaluate(
    `document.querySelector('#place-search').value = 'no-such-place'; document.querySelector('#place-search').dispatchEvent(new Event('input'));`,
  );
  assert.equal(await page.evaluate(`document.querySelector('#add-place-button').disabled`), true);
  console.log('PASS empty catalogue search state');
  await page.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  await page.click('#open-settings');
  await page.evaluate(
    `document.querySelector('#provider').value = 'openrouter'; document.querySelector('#provider').dispatchEvent(new Event('change')); document.querySelector('#model').value = 'fixture-model'; document.querySelector('#api-key').value = 'browser-fixture-only'; document.querySelector('#settings-form').requestSubmit();`,
  );
  assert.match(
    await page.evaluate(`document.querySelector('#inference-badge').textContent`),
    /LLM: fixture-model @ openrouter.ai/,
  );
  await page.click('#delete-profile');
  assert.equal(await page.evaluate(`localStorage.getItem('wayfinder.byok')`), null);
  console.log('PASS settings: saved localStorage profile, updated inference badge, deleted credential');
  await page.click('#connect-peer');
  await page.wait(`document.querySelector('#consent-dialog').open`);
  assert.equal(await page.evaluate(`document.querySelector('#consent-origin').textContent`), server.origin);
  await page.click('#consent-deny');
  await page.wait(`document.querySelector('#peer-status').textContent.includes('Fail closed')`);
  await page.click('#connect-peer');
  for (let step = 0; step < 2; step++) {
    await page.wait(`document.querySelector('#consent-dialog').open`);
    await page.click('#consent-allow');
  }
  await page.wait(`document.querySelector('#peer-status').textContent.includes('validated')`);
  assert.match(await page.evaluate(`document.querySelector('#peer-agents').textContent`), /weather_guide/);
  console.log('PASS peer demo: denied contact fails closed; two explicit approvals list sample agent');
  await page.click('#close-settings');
  // Return to a clean, within-budget plan for evidence screenshots.
  await page.click('.example-chip:nth-child(1)');
  await page.click('#run-button');
  await page.wait(
    `!document.querySelector('#run-button').disabled && document.querySelector('#activity-state').textContent === 'Complete'`,
  );
  await page.evaluate('window.scrollTo(0, 0)');
  await page.screenshot(join(shots, 'wayfinder-desktop-1440x900.png'));
  await page.evaluate(`
    const detail = [...document.querySelectorAll('#trace details')]
      .find(detail => detail.closest('li').querySelector('strong').textContent === 'search_places · calling');
    detail.open = true;
    const trace = document.querySelector('#trace');
    trace.scrollTop += detail.closest('li').getBoundingClientRect().top - trace.getBoundingClientRect().top;
    document.querySelector('#activity-title').closest('section').scrollIntoView({block: 'start'});
  `);
  assert(
    await page.evaluate(`(() => {
    const detail = document.querySelector('#trace details[open]');
    const bounds = detail.getBoundingClientRect();
    const trace = document.querySelector('#trace').getBoundingClientRect();
    return bounds.top >= trace.top && bounds.bottom <= trace.bottom && bounds.top > 0 && bounds.bottom < innerHeight;
  })()`),
    'Expanded tool call must be visible in the trace screenshot',
  );
  await page.screenshot(join(shots, 'wayfinder-trace-1440x900.png'));
  console.log('PASS trace evidence: search_places tool-call input expanded and visible');
  await page.evaluate('window.scrollTo(0, 0)');
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  assert(await page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Mobile horizontal overflow');
  await page.screenshot(join(shots, 'wayfinder-mobile-390x844.png'));
  await page.evaluate(`document.querySelector('#results').scrollIntoView()`);
  await page.screenshot(join(shots, 'wayfinder-mobile-itinerary-390x844.png'));
  await page.navigate(
    server.origin + '/?goal=' + encodeURIComponent('Plan a 2-day food trip in Hong Kong under $150') + '&format=json',
  );
  const machine = JSON.parse(await page.evaluate(`document.querySelector('#agentic-web-result').textContent`));
  assert(machine.days.every((day) => day.items.length));
  assert(machine.cost.within_budget);
  assert.match(await page.evaluate('document.title'), /JSON/);
  assert.equal(await page.evaluate('document.body.children.length'), 1);
  console.log('PASS machine entry: pure parseable itinerary JSON, correct title, within budget');
  assert.deepEqual(page.errors, [], 'Browser console errors/exceptions');
  console.log('PASS zero console errors or uncaught exceptions');
  console.log('Browser E2E passed.');
} finally {
  socket?.close();
  if (chrome.exitCode === null) {
    const exited = new Promise((resolve) => chrome.once('exit', resolve));
    chrome.kill('SIGTERM');
    await exited;
  }
  await server.stop();
  await rm(profileDir, { recursive: true, force: true });
}
