import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const runtime = require('../runtime.js');
const root = new URL('../', import.meta.url);
const read = async (path) => JSON.parse(await readFile(new URL(path, root), 'utf8'));
const [manifest, network, schema, data] = await Promise.all(
  ['agent-manifest.json', 'agent.json', 'schemas/network.schema.json', 'data/places.json'].map(read),
);
let checks = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      checks++;
      console.log('PASS ' + name);
    });
}
const copy = (value) => JSON.parse(JSON.stringify(value));
const minute = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
function haversine(a, b) {
  const rad = (n) => (n * Math.PI) / 180;
  const h =
    Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}
function assertQuality(result) {
  let fares = 0;
  const coveredInterests = new Set(
    result.days.flatMap((day) =>
      day.items.flatMap((item) => data.places.find((place) => place.id === item.place_id).tags),
    ),
  );
  for (const interest of result.constraints.interests) assert(coveredInterests.has(interest), 'Cover ' + interest);
  for (const day of result.days) {
    const limits = { relaxed: [3, 4], normal: [5, 6], packed: [7, 8] }[result.constraints.pace];
    assert(day.items.length >= limits[0] && day.items.length <= limits[1], 'Pace-specific stop count');
    assert(day.anchor && day.planning_notes.includes('Clustered around'));
    let previous;
    for (const item of day.items) {
      const place = data.places.find((p) => p.id === item.place_id);
      assert(item.time_start >= place.open && item.time_end <= place.close, 'Opening hours');
      const weekday = new Date(day.date + 'T12:00:00Z').toLocaleDateString('en-US', {
        weekday: 'long',
        timeZone: 'UTC',
      });
      assert(!place.closed_days.includes(weekday));
      assert.equal(minute(item.time_end) - minute(item.time_start), place.duration_min);
      assert(item.time_start >= '09:00' && item.time_end <= '21:00');
      if (result.constraints.family) assert(place.kid_friendly);
      if (item.meal_slot) {
        const [earliest, latest] = {
          breakfast: ['09:00', '11:30'],
          lunch: ['12:00', '14:00'],
          snack: ['15:00', '17:30'],
          dinner: ['18:00', '20:00'],
        }[item.meal_slot];
        assert(item.time_start >= earliest && item.time_start <= latest, item.name + ': meal window');
        assert(place.meal_slots.includes(item.meal_slot));
      }
      if (place.id === 'temple-street-night-market') assert(item.time_start >= '17:00');
      if (previous) {
        const leg = item.transit_before;
        assert(leg && leg.mode && leg.minutes > 0);
        assert.equal(leg.from_place_id, previous.place_id);
        assert.equal(leg.to_place_id, item.place_id);
        assert.equal(leg.cost_hkd, item.transit_hkd);
        assert.equal(leg.time_end, item.time_start);
        assert.equal(minute(leg.time_end) - minute(leg.time_start), leg.minutes);
        assert(leg.time_start >= previous.time_end, 'Transit cannot overlap a visit');
        assert(minute(item.time_start) - minute(previous.time_end) <= 90, 'No gap over 90 min, including travel');
        const from = data.places.find((p) => p.id === previous.place_id);
        const distance = haversine(from, place);
        assert(Math.abs(leg.distance_km - distance) <= 0.006, 'Haversine distance');
        assert(distance <= 12 || leg.declared_transfer, 'Long hops must be declared');
        assert.equal(from.region, place.region, 'Example days stay on one side of the harbour');
        fares += leg.cost_hkd;
      } else {
        assert.equal(item.transit_before, null);
        assert.equal(item.transit_hkd, 0);
      }
      previous = item;
    }
    if (result.constraints.interests.includes('food')) {
      assert(day.items.filter((item) => item.category === 'restaurant').length >= 3, 'At least three food stops');
    }
  }
  assert.equal(result.cost.breakdown.transport, fares, 'Fares counted once under transport');
  assert(result.cost.within_budget && result.cost.total_hkd <= result.constraints.budget_usd * 7.8 * 0.94 + 0.01);
  assert.match(result.summary, /Budget agent: HK\$/);
  assert(result.trace.some((event) => event.type === 'reasoning' && event.text === result.summary));
}
function fixture({ m = manifest, n = network, fetchHook } = {}) {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    if (fetchHook) {
      const response = await fetchHook(String(url), options);
      if (response) return response;
    }
    const path = new URL(url).pathname;
    const value = path.endsWith('agent-manifest.json')
      ? m
      : path.endsWith('agent.json')
        ? n
        : path.endsWith('places.json')
          ? data
          : null;
    return { ok: !!value, status: value ? 200 : 404, json: async () => copy(value) };
  };
  return { app: runtime.createRuntime({ fetch, baseUrl: 'http://localhost:8000/' }), calls };
}
await test('network and manifest schemas and declared references', () => {
  runtime.validate(schema, network);
  runtime.validate(
    {
      type: 'object',
      required: ['brand', 'networks', 'llm_router', 'peer_policy', 'actions'],
      properties: {
        networks: {
          type: 'array',
          items: {
            type: 'object',
            required: ['name', 'front_man', 'hocon'],
            properties: { name: { type: 'string' }, front_man: { type: 'string' }, hocon: { type: 'string' } },
          },
        },
        actions: {
          type: 'object',
          required: ['version', 'module', 'agentTools'],
          properties: {
            version: { enum: [1] },
            module: { type: 'string' },
            agentTools: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
    manifest,
  );
  assert.equal(manifest.networks[0].name, network.metadata.name);
  assert.equal(manifest.llm_router.default.mode, 'local-rule-based');
  assert.equal(manifest.llm_router.mock, false);
  runtime.validateNetwork(network, manifest.networks[0], manifest.actions.agentTools);
  assert.deepEqual(
    manifest.actions.agentTools.slice().sort(),
    runtime
      .listActions()
      .map((a) => a.name)
      .sort(),
  );
  assert.throws(() => runtime.validate(schema, { metadata: {}, tools: [] }), /missing description/);
});
await test('71 grounded places: fields, bounds, times, ids, categories and sources', () => {
  assert(data.places.length >= 60);
  assert.equal(data.currency, 'HKD');
  assert.equal(data.usd_rate, 7.8);
  const ids = new Set();
  const coordinates = new Set();
  for (const p of data.places) {
    for (const field of [
      'id',
      'name',
      'category',
      'district',
      'region',
      'tags',
      'price_hkd',
      'duration_min',
      'open',
      'close',
      'closed_days',
      'kid_friendly',
      'lat',
      'lng',
      'source',
      'notes',
    ])
      assert(Object.hasOwn(p, field), p.name + ': ' + field);
    assert(!ids.has(p.id));
    ids.add(p.id);
    assert(['attraction', 'restaurant', 'transport'].includes(p.category));
    assert(['hong_kong_island', 'kowloon', 'new_territories', 'lantau'].includes(p.region));
    assert(Array.isArray(p.tags));
    assert(Array.isArray(p.closed_days));
    assert(
      p.closed_days.every((d) =>
        ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].includes(d),
      ),
    );
    assert.equal(typeof p.kid_friendly, 'boolean');
    assert(p.lat >= 22.1 && p.lat <= 22.6 && p.lng >= 113.8 && p.lng <= 114.5);
    const coordinateKey = `${p.lat},${p.lng}`;
    assert(!coordinates.has(coordinateKey), `Duplicate coordinates: ${p.id} at ${coordinateKey}`);
    coordinates.add(coordinateKey);
    assert(p.price_hkd >= 0 && p.duration_min > 0);
    if (p.tags.includes('food')) assert(p.category === 'restaurant' && p.price_hkd > 0, 'Food is not free browsing');
    if (p.category === 'restaurant') {
      assert(p.price_hkd > 0 && p.meal_slots.length && p.dining_style);
      assert(p.meal_slots.every((slot) => ['breakfast', 'lunch', 'snack', 'dinner'].includes(slot)));
    }
    for (const t of [p.open, p.close]) assert(/^([01]\d|2[0-3]):[0-5]\d$/.test(t));
    assert(p.open < p.close);
    assert.equal(new URL(p.source).protocol, 'https:');
  }
});
await test('node --check on every JavaScript source', async () => {
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const path = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
      if (entry.isDirectory()) await walk(path);
      else if (/\.(?:js|mjs)$/.test(entry.name))
        execFileSync(process.execPath, ['--check', path.pathname], { stdio: 'pipe' });
    }
  }
  await walk(root);
});
await test('runtime and tests use lines of at most 120 characters', async () => {
  for (const file of ['runtime.js', 'tests/run_tests.mjs']) {
    const source = await readFile(new URL(file, root), 'utf8');
    source.split('\n').forEach((line, index) => {
      assert(line.length <= 120, `${file}:${index + 1}: ${line.length} characters`);
    });
  }
});
await test('reject duplicate agents, missing references, invalid front and executable code', () => {
  const actions = manifest.actions.agentTools,
    entry = manifest.networks[0];
  const duplicate = copy(network);
  duplicate.tools.push(copy(duplicate.tools[0]));
  assert.throws(() => runtime.validateNetwork(duplicate, entry, actions), /Duplicate/);
  const missing = copy(network);
  missing.tools[0].tools.push('missing');
  assert.throws(() => runtime.validateNetwork(missing, entry, actions), /reference/);
  assert.throws(() => runtime.validateNetwork(network, { front_man: 'missing' }, actions), /front_man/);
  const executable = copy(network);
  executable.tools[0].code = 'alert(1)';
  assert.throws(() => runtime.validateNetwork(executable, entry, actions), /executable/);
});
await test('fail closed on invalid schema arguments', () => {
  const schema = {
    type: 'object',
    required: ['n', 'list'],
    properties: {
      n: { type: 'integer', minimum: 0, maximum: 3 },
      list: { type: 'array', items: { type: 'string', enum: ['yes'] } },
    },
    additionalProperties: false,
  };
  for (const value of [
    {},
    { n: -1, list: [] },
    { n: 4, list: [] },
    { n: 1.2, list: [] },
    { n: 1, list: ['no'] },
    { n: 1, list: ['yes'], extra: true },
  ])
    assert.throws(() => runtime.validate(schema, value));
  assert(runtime.validate(schema, { n: 2, list: ['yes'] }));
});
const summaries = [];
const itineraries = [];
for (const goal of network.metadata.sample_queries)
  await test('itinerary: ' + goal, async () => {
    const { app } = fixture();
    await app.load();
    const result = await app.run(goal, { startDate: '2026-11-23' });
    runtime.validate(network.output_schema, result);
    assertQuality(result);
    if (result.constraints.interests.includes('views') && result.constraints.area === 'hong_kong_island') {
      const viewpoints = result.days
        .flatMap((day) => day.items)
        .filter((item) => data.places.find((place) => place.id === item.place_id).tags.includes('viewpoint'));
      assert(viewpoints.length > 0, 'Include a substantive viewpoint, not just a waterfront square');
      assert(
        viewpoints.every((item) => item.time_start >= '15:00'),
        'Late-afternoon or evening viewpoints',
      );
    }
    assert(result.days.length === result.constraints.days);
    assert(result.cost.within_budget);
    assert(result.cost.total_hkd <= result.cost.budget_usd * 7.8);
    let total = 0;
    const used = new Set();
    for (const day of result.days) {
      assert(day.items.length > 0);
      let end = '00:00';
      const weekday = new Date(day.date + 'T12:00:00Z').toLocaleDateString('en-US', {
        weekday: 'long',
        timeZone: 'UTC',
      });
      for (const item of day.items) {
        const p = data.places.find((p) => p.id === item.place_id);
        assert(p);
        assert(!used.has(p.id));
        used.add(p.id);
        assert(!p.closed_days.includes(weekday));
        assert(item.time_start >= p.open && item.time_end <= p.close);
        assert(item.time_start >= end);
        end = item.time_end;
        assert.equal(item.cost_hkd, p.price_hkd);
        if (result.constraints.family) assert(p.kid_friendly);
        total += item.cost_hkd + item.transit_hkd;
      }
    }
    assert.equal(Math.round(total * 100) / 100, result.cost.total_hkd);
    for (const type of [
      'run_start',
      'agent_start',
      'reasoning',
      'tool_call',
      'tool_result',
      'handoff',
      'progress',
      'agent_end',
      'run_end',
    ])
      assert(
        result.trace.some((e) => e.type === type),
        type,
      );
    const again = await app.run(goal, { startDate: '2026-11-23' });
    assert.deepEqual(result.days, again.days);
    if (result.days.length > 1) {
      assert.notEqual(result.days[0].anchor.region, result.days[1].anchor.region, 'Different day areas');
      assert(result.cost.breakdown.restaurant >= 500, 'Use the food budget for substantial meals');
      assert(
        result.days.every((day) =>
          day.items.every((item) => {
            const place = data.places.find((p) => p.id === item.place_id);
            return (
              ['hong_kong_island', 'kowloon'].includes(place.region) && !['Peak', 'Stanley'].includes(place.district)
            );
          }),
        ),
        'No unrequested remote outliers',
      );
    }
    itineraries.push(result);
    summaries.push({
      goal,
      days: result.days.length,
      items: result.days.map((d) => d.items.length),
      total_hkd: result.cost.total_hkd,
      total_usd: result.cost.total_usd,
      budget_usd: result.cost.budget_usd,
    });
  });
await test('quality holds across weekday closures and all paces', async () => {
  const { app } = fixture();
  await app.load();
  for (let day = 24; day <= 29; day++) {
    for (const goal of network.metadata.sample_queries) {
      assertQuality(await app.run(goal, { startDate: '2026-11-' + day }));
    }
  }
  for (const pace of ['relaxed', 'packed']) {
    assertQuality(
      await app.run(network.metadata.sample_queries[0], {
        startDate: '2026-11-23',
        constraints: { pace },
      }),
    );
  }
});
await test('budget reasoning names excluded premium meals and respects dedicated remote areas', async () => {
  const { app } = fixture();
  await app.load();
  const cheap = await app.run('Plan a 1-day culture trip in Tsim Sha Tsui under HK$200', {
    startDate: '2026-11-23',
  });
  assert(cheap.cost.within_budget);
  assert.match(cheap.summary, /Excluded Hutong \(HK\$700\)/);
  assert(cheap.trace.some((event) => event.type === 'reasoning' && event.text.includes('Excluded Hutong')));
  const dedicated = await app.run('Plan a relaxed 1-day food trip in Sai Kung under $200', {
    startDate: '2026-11-23',
  });
  assert(dedicated.days[0].items.length);
  assert(dedicated.days[0].items.every((item) => item.district === 'Sai Kung'));
  assert(dedicated.cost.within_budget);
});
await test('HKD/USD parsing, empty catalogue matches and zero budget', async () => {
  const { app } = fixture();
  await app.load();
  const hkd = await app.run('2 days under HKD 780', { startDate: '2026-11-23' });
  assert.equal(hkd.constraints.budget_usd, 100);
  const usd = await app.run('under 80 USD');
  assert.equal(usd.constraints.budget_usd, 80);
  const empty = await app.run('Trip', { constraints: { area: 'not-a-district' } });
  assert.equal(empty.days[0].items.length, 0);
  assert.match(empty.summary, /No feasible places/);
  const free = await app.run('under $0');
  assert.equal(free.cost.total_hkd, 0);
  assert(free.cost.within_budget);
  await assert.rejects(() => app.run(''), /non-empty/);
});
await test('malformed JSON, exact network matching and failed fetch errors', async () => {
  await assert.rejects(
    () =>
      fixture({
        fetchHook: async () => ({
          ok: true,
          json: async () => {
            throw Error('bad');
          },
        }),
      }).app.load(),
    /Malformed JSON/,
  );
  await assert.rejects(() => fixture().app.load('./agent-manifest.json', 'other'), /exact network/);
  await assert.rejects(() => fixture({ fetchHook: async () => ({ ok: false, status: 503 }) }).app.load(), /HTTP 503/);
});
await test('bounded execution, invalid action dispatch and write approval', async () => {
  const { app } = fixture();
  await app.load();
  await assert.rejects(() => app.run('Trip', { limits: { maxAgentInvocations: 1 } }), /invocation limit/);
  await assert.rejects(() => app.run('Trip', { limits: { maxToolCalls: 0 } }), /Tool call limit/);
  await assert.rejects(() => app.run('Trip', { limits: { maxDepth: 1 } }), /depth limit/);
  await assert.rejects(() => app.run('Trip', { limits: { timeoutMs: 0 } }), /timeout/);
  await assert.rejects(() => app.run('Trip', { writeToPage: true }), /approval/);
  await app.run('Trip', { writeToPage: true, confirmWrite: async () => true });
  app.registerAction('search_places', {
    description: 'test',
    parameters: { type: 'object', required: ['absent'] },
    effect: 'read',
    handler: () => {
      throw Error('must not dispatch');
    },
  });
  await assert.rejects(() => app.run('Trip'), /missing absent/);
});
await test('BYOK only contacts router, keeps key out of trace and falls back safely', async () => {
  const profile = { baseUrl: 'https://router.example/v1', model: 'test-model', apiKey: 'test-only-placeholder' };
  let count = 0;
  const { app, calls } = fixture({
    fetchHook: async (url, options) => {
      if (!url.startsWith(profile.baseUrl)) return;
      count++;
      assert.equal(options.headers.Authorization, 'Bearer ' + profile.apiKey);
      assert(!options.body.includes(profile.apiKey));
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: count === 1 ? 'invalid-json' : 'Grounded summary.' } }] }),
      };
    },
  });
  await app.load();
  const result = await app.run('Food under $100', { inference: profile });
  assert.equal(count, 2);
  assert(result.summary.startsWith('Grounded summary.'));
  assert.match(result.summary, /Budget agent: HK\$/);
  assert(!JSON.stringify(result).includes(profile.apiKey));
  assert(
    calls.filter((c) => c.url.includes('router.example')).every((c) => c.url === profile.baseUrl + '/chat/completions'),
  );
  const fallback = fixture({
    fetchHook: async (url) => (url.includes('router.example') ? { ok: false, status: 401 } : undefined),
  }).app;
  await fallback.load();
  const local = await fallback.run('Trip', { inference: profile });
  assert.match(local.summary, /Local rule-based/);
  assert(local.trace.some((e) => /falling back/.test(e.text || '')));
});
await test('peer policy, consent before every fetch and exact network selection', async () => {
  const closed = fixture();
  await closed.app.load();
  const before = closed.calls.length;
  await assert.rejects(
    () => closed.app.loadPeer('https://peer.example/agents/wayfinder', { consent: async () => true }),
    /denied/,
  );
  assert.equal(closed.calls.length, before);
  const m = copy(manifest);
  m.allowed_peers = ['https://peer.example'];
  const allowed = fixture({ m });
  await allowed.app.load();
  const count = allowed.calls.length;
  await assert.rejects(
    () => allowed.app.loadPeer('https://peer.example/agents/wayfinder', { consent: async () => false }),
    /consent denied/,
  );
  assert.equal(allowed.calls.length, count);
  let consentCount = 0;
  const peer = await allowed.app.loadPeer('https://peer.example/agents/wayfinder', {
    consent: async () => {
      consentCount++;
      return true;
    },
  });
  assert.equal(consentCount, 2);
  assert.equal(peer.execution, 'validation-only');
  assert(allowed.calls.some((c) => c.url === 'https://peer.example/agents/agent-manifest.json'));
  await assert.rejects(
    () => allowed.app.loadPeer('https://peer.example/agents/no-match', { consent: async () => true }),
    /exact peer/,
  );
});
await test('edited schedules recompute times, costs, sources, empty days and infeasible stops', async () => {
  const { app } = fixture();
  await app.load();
  const original = await app.run('Plan a 2-day food trip under $150', { startDate: '2026-11-23' });
  const draft = copy(original);
  draft.days[0].items.reverse();
  draft.days[1].items.push({ place_id: 'hong-kong-space-museum' });
  const edited = app.recalculateItinerary(draft);
  runtime.validate(network.output_schema, edited);
  for (const day of edited.days) {
    let end = '00:00';
    for (const item of day.items) {
      const place = data.places.find((p) => p.id === item.place_id);
      assert(item.time_start >= end && item.time_start >= place.open && item.time_end <= place.close);
      end = item.time_end;
    }
  }
  assert(edited.edit_warnings.length > 0);
  const empty = copy(original);
  empty.days.forEach((day) => {
    day.items = [];
  });
  const cleared = app.recalculateItinerary(empty);
  assert.equal(cleared.cost.total_hkd, 0);
  assert.equal(cleared.sources.length, 0);
  assert(cleared.cost.within_budget);
  const expensive = copy(original);
  expensive.constraints.budget_usd = 1;
  expensive.days[0].items = [{ place_id: 'hutong' }];
  const over = app.recalculateItinerary(expensive);
  assert(!over.cost.within_budget);
  assert(over.sources.some((source) => source.name === 'Hutong'));
  const invalid = copy(original);
  invalid.days[0].items = [{ place_id: 'missing-place' }];
  assert.throws(() => app.recalculateItinerary(invalid), /Unknown place/);
});
await test('edited transit reflects walking distance, harbour crossings and declared long transfers', async () => {
  const { app } = fixture();
  await app.load();
  const original = await app.run('Plan a 1-day trip', { startDate: '2026-11-23' });
  original.days[0].items = [
    'hong-kong-park',
    'hong-kong-zoological-and-botanical-gardens',
    'kowloon-park',
    'sai-kung-seafood-street',
  ].map((place_id) => ({ place_id }));
  const result = app.recalculateItinerary(original);
  const [, walking, harbour, remote] = result.days[0].items;
  assert.equal(walking.transit_before.mode, 'Walk');
  assert.equal(walking.transit_hkd, 0);
  assert(harbour.transit_before.declared_transfer && harbour.transit_before.minutes >= 35);
  assert(harbour.transit_hkd > 0);
  assert(remote.transit_before.declared_transfer && remote.transit_before.distance_km > 12);
  assert(remote.transit_before.minutes >= 45 && remote.transit_hkd >= 25);
  assert.equal(result.cost.breakdown.transport, harbour.transit_hkd + remote.transit_hkd);
});
await test('connection testing scopes credentials and fails safely', async () => {
  const profile = { baseUrl: 'https://router.example/v1', model: 'fixture', apiKey: 'test-placeholder' };
  const { app, calls } = fixture({
    fetchHook: async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'OK' } }] }),
    }),
  });
  assert.deepEqual(await app.testConnection(profile), { ok: true });
  assert.equal(calls[0].url, profile.baseUrl + '/chat/completions');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer ' + profile.apiKey);
  assert(!calls[0].options.body.includes(profile.apiKey));
  await assert.rejects(() => app.testConnection(null), /Enter a base URL/);
  await assert.rejects(() => app.testConnection({ ...profile, baseUrl: 'http://remote.example' }), /HTTPS/);
  const failed = fixture({ fetchHook: async () => ({ ok: false, status: 401 }) }).app;
  await assert.rejects(() => failed.testConnection(profile), /Connection test failed/);
});
await test('manual peer extension never bypasses consent or deny rules', async () => {
  const { app, calls } = fixture();
  await app.load();
  const before = calls.length;
  await assert.rejects(
    () =>
      app.loadPeer('https://peer.example/wayfinder', {
        userInitiated: true,
        consent: async () => false,
      }),
    /consent denied/,
  );
  assert.equal(calls.length, before);
  const peer = await app.loadPeer('https://peer.example/wayfinder', {
    userInitiated: true,
    consent: async () => true,
  });
  assert.equal(peer.execution, 'validation-only');
  const m = copy(manifest);
  m.peer_policy.deny_origins = ['https://peer.example'];
  const denied = fixture({ m });
  await denied.app.load();
  const count = denied.calls.length;
  await assert.rejects(
    () =>
      denied.app.loadPeer('https://peer.example/wayfinder', {
        userInitiated: true,
        consent: async () => true,
      }),
    /origin denied/,
  );
  assert.equal(denied.calls.length, count);
});
console.log('\n' + checks + ' checks passed.');
console.log('ITINERARY SUMMARIES\n' + JSON.stringify(summaries, null, 2));
for (const result of itineraries) {
  console.log('\nFULL ITINERARY: ' + result.goal);
  for (const day of result.days) {
    console.log('Day ' + day.day + ' · ' + day.date + ' · anchor: ' + day.anchor.district);
    for (const item of day.items) {
      const leg = item.transit_before;
      if (leg)
        console.log(
          '  ' +
            leg.time_start +
            '–' +
            leg.time_end +
            ' ' +
            leg.mode +
            ' ~' +
            leg.minutes +
            ' min · ' +
            leg.distance_km +
            ' km · HK$' +
            leg.cost_hkd,
        );
      console.log(
        '  ' +
          item.time_start +
          '–' +
          item.time_end +
          ' ' +
          item.name +
          ' · ' +
          item.district +
          ' · ' +
          (item.meal_slot || item.category) +
          ' · HK$' +
          item.cost_hkd,
      );
    }
  }
  console.log(
    'TOTAL HK$' +
      result.cost.total_hkd +
      ' / US$' +
      result.cost.total_usd +
      ' · budget US$' +
      result.cost.budget_usd +
      ' · ' +
      JSON.stringify(result.cost.breakdown),
  );
  console.log(result.summary);
}
