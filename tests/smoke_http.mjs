import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startServer } from './http_server.mjs';

const require = createRequire(import.meta.url);
const { createRuntime } = require('../runtime.js');
const server = await startServer();
try {
  console.log('HTTP smoke server: ' + server.kind);
  for (const path of [
    'index.html',
    'styles.css',
    'app.js',
    'runtime.js',
    'agent.json',
    'agent-manifest.json',
    'links.json',
    'data/places.json',
    '.well-known/nsdeploy.json',
    'peers/hk_weather_tips/agent-manifest.json',
    'peers/hk_weather_tips/network.json',
  ]) {
    const response = await fetch(server.origin + '/' + path);
    assert.equal(response.status, 200, path);
    if (path.endsWith('.json')) await response.json();
    console.log('PASS GET /' + path + ' → 200' + (path.endsWith('.json') ? ' (valid JSON)' : ''));
  }
  const runtime = createRuntime({ baseUrl: server.origin + '/', fetch });
  await runtime.load();
  const result = await runtime.run('Plan a 2-day food trip in Hong Kong under $150');
  assert(result.days.every((day) => day.items.length > 0));
  assert(result.cost.within_budget);
  console.log(
    'PASS HTTP-loaded runtime: ' +
      result.days.length +
      ' days, ' +
      result.days.flatMap((day) => day.items).length +
      ' stops, HK$' +
      result.cost.total_hkd +
      ', within budget',
  );
  let contacts = 0;
  const peer = await runtime.loadPeer(server.origin + '/peers/hk_weather_tips/hk_weather_tips', {
    userInitiated: true,
    consent: async () => {
      contacts++;
      return true;
    },
  });
  assert.equal(peer.name, 'hk_weather_tips');
  assert.deepEqual(peer.agents, ['weather_guide']);
  assert.equal(contacts, 2);
  console.log('PASS bundled peer: exact network, two approvals, weather_guide listed (not executed)');
  console.log('HTTP smoke passed.');
} finally {
  await server.stop();
}
