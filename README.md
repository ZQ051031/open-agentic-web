# Wayfinder — open agentic trip planner for Hong Kong

Four browser-local agents turn a goal into a geographically clustered, timed Hong Kong itinerary with meals,
explicit transit, per-person costs, sources and an inspectable activity trace. The default is **deterministic
rule-based JavaScript, not an LLM**. No framework, CDN, build step or backend is required.

## Example goals and UI

- Plan a 2-day food trip in Hong Kong under $150
- Plan a relaxed 1-day family outing in Kowloon
- Plan a 1-day culture and views trip on Hong Kong Island under $80

The UI supports budget/pace/interest/area filters, editable visits, district grouping, sources, text/JSON downloads,
clipboard export, provider settings and consent-gated peer discovery. Screenshots are generated outside the repository
and **are not committed**. Once the page, catalogue and runtime have loaded, local planning works offline in that tab;
there is no service worker or guaranteed offline reload.

## Run locally

From the repository root:

~~~sh
python3 -m http.server 8080
~~~

Open **http://localhost:8080/**. Alternatively:

~~~sh
npx serve . --listen 8080
~~~

This is npx serve . with an explicit port; without it use the printed URL (normally port 3000). The first npx run may
download serve. Neither command deploys a public site.

### Tests

Use current Node with built-in fetch and WebSocket (tested on Node 24). With nvm, first run:

~~~sh
source ~/.nvm/nvm.sh
npm test
npm run test:e2e
~~~

The tests require no npm dependencies. npm test runs network/data validation, syntax/style checks, deterministic
planning, geography, meal/opening windows, all seven weekdays, pace variants, costs, edits, limits, BYOK fixtures and
peer rules, then an HTTP smoke test through Python's static server with a Node fallback.

The E2E script requires discoverable Chrome and drives headless Chrome through CDP with Node's WebSocket. It checks
offline examples, transit, edits, settings, peer consent, JSON entry and console errors. Missing Chrome prints **SKIP**
and exits successfully; that is not browser verification. Screenshots go to **/home/ubuntu/wayfinder-shots/**, including
the expanded-tool-call trace. Live provider credentials, public deployment, the missing-Python fallback and the
missing-Chrome skip path have not been exercised on the development machine.

## Architecture

The graph is published in **agent.json**. **runtime.js** independently implements the supported deterministic delegation
and site actions; it does not interpret arbitrary imported instructions or execute arbitrary imported networks.

| Agent | Responsibility | Declared agents / site actions |
| --- | --- | --- |
| wayfinder_planner (front_man) | Parse goal/overrides, coordinate, assemble result | Researcher, budget analyst, scheduler; write_itinerary_to_page |
| place_researcher | Rank grounded places by area, interests and family suitability | search_places, get_place |
| budget_analyst | Audit per-person visits and transit against budget | estimate_transit, total_costs, check_budget |
| itinerary_scheduler | Choose geographic anchors and timed visits/meals | build_schedule |

~~~text
Goal + UI constraints
        |
        v
Planner -- optional BYOK goal parsing
        |
        v
Researcher -- search_places --> data/places.json
        |
        v
Scheduler -- build_schedule
  geographic anchors + meals + hours + distance + budget envelope
        |
        v
Budget analyst -- total_costs --> check_budget
        |
        v
Planner -- grounded summary + optional BYOK prose
        |
        +--> events / trace --> Agent activity
        +--> itinerary --> UI, edits, exports and agent APIs
~~~

Not every declared action is invoked on every run. Scheduling computes travel internally; the usual budget audit
calls total_costs and check_budget, not a separate estimate_transit action per leg.

The scheduler retains at most 32 beam-search states per slot, prefers different areas on different days and filters
unrequested remote areas. Views goals may include Peak viewpoints with explicit mountain-transfer allowances.
Relaxed/normal/packed templates target four/six/eight stops. Food templates include breakfast, lunch, snack and dinner
where feasible. Family goals filter kid_friendly and penalize district changes. Haversine distance drives walking,
rail/bus, harbour and Peak allowances; these are not live routes or fare quotes. A 6% contingency is reserved before
scheduling, then the budget agent audits selected totals. Sparse/empty results are possible rather than invented meals.
Edits recompute times/transit/costs, can exceed budget, and report stops omitted because they cannot fit.

### Events, bounds and fail-closed validation

Events appear in onEvent callbacks, the result trace and the runtime's EventTarget:
**run_start, agent_start, reasoning, tool_call, tool_result, handoff, progress, agent_end, run_end, error**.
Tool events carry arguments/results and duration; reasoning explains area/budget choices. UI playback is paced
independently and can be skipped. These are lifecycle events, not streaming LLM tokens.

Defaults: 40 agent invocations, 40 tool calls (from max_steps), depth 4 and 30 seconds. Configurable overrides are capped
at 100 agents, 200 tools, depth 10 and 120 seconds. Trace retains at most 500 events. Timers cannot preempt a synchronous
JavaScript task; the built-in search itself is bounded.

Loading rejects malformed JSON, duplicate agents, missing references, invalid front agents and unsupported executable
definitions before inference. Dispatch denies undeclared calls and validates registered action arguments.
The JSON Schema validator supports types, required/properties, additionalProperties, enum, numeric bounds and array
items, **not full JSON Schema** (for example, anyOf is not enforced); tests separately assert transit/output invariants.
Write-class actions require confirmWrite approval with destination and arguments. The built-in page action only emits
a page event: no booking, purchase or external business outcome is claimed. MCP and executable bundles fail closed.

## Open Agentic Web publication and implementation boundaries

Reference: [Cognizant AI Labs Agentic Web](https://github.com/cognizant-ai-labs/agentic-web),
[MVP specification, Profile 0.3](https://github.com/cognizant-ai-labs/agentic-web/blob/main/docs/worldwide_agentic_web_mvp_spec.md).

Wayfinder follows the profile's declarative publication and browser-local action patterns. This is **not a claim of
complete Profile 0.3 runtime conformance or independent certification**: peer execution, MCP and model-token streaming
are not implemented, and the default inference is rule-based.

| Spec surface | Implementation |
| --- | --- |
| §2 resolved portable network | agent.json: resolved JSON serialization of the Neuro SAN HOCON data model, public instructions and invocation/output schemas; no includes or environment substitutions |
| §3.3 manifest | agent-manifest.json: name wayfinder, front_man wayfinder_planner, hocon ./agent.json; inference, actions, peer policy and deployment metadata |
| §3.1 browser runtime | runtime.js: validation, declared delegation, action schemas/effects, write approval, bounded execution and trace |
| §3.2 peer loading | Exact-name lookup, URL resolution, policy checks, consent before each fetch and declarative validation; **listing only, no peer execution** |
| Linking | links.json: Wayfinder namespace, currently no imported peer links |
| Inference/privacy | Local deterministic default; optional visitor-configured OpenAI-compatible router for parsing/prose, never forwarded to peers |

The spec names the manifest **agent-manifest.json** and declares the network file location through hocon.
Thus **agent.json is our resolved network definition**, not a substitute manifest. Profile 0.3 does not define
**/.well-known/agent.json**, so none is published. **.well-known/nsdeploy.json** is optional discovery metadata.

Default peer policy is closed with an empty allowed_peers list. The documented manual discovery extension combines
manual_consent with userInitiated: true and requires approval before both manifest and network fetches.
Agent-initiated contact stays denied unless policy permits it; deny rules still apply. Redirects are refused.
Peer code is not executed, no private context or router key is sent, and peer router metadata never replaces yours.

### Hosting and CORS

This repository does not deploy the site. The entrant chooses a static host and makes it publicly accessible.
Use HTTPS. Python http.server sends no CORS headers: same-origin demos work, but unrelated browser origins cannot
fetch metadata without permission. **Configure your host to send CORS headers for the JSON artifacts**, including
manifest, network, links and discovery metadata, to enable cross-origin loading. Direct BYOK providers also need
browser-compatible CORS. No proxy is included.

## Agent / website API

Load runtime.js as a classic script. **window.AgenticWeb** and **window.WayfinderRuntime** are aliases.

| Method/property | Signature and result |
| --- | --- |
| load | await load(manifestUrl = './agent-manifest.json', networkName = 'wayfinder') → runtime |
| run | await run(goal, options = {}) → itinerary |
| registerAction | registerAction(name, {description, parameters, effect: 'read' or 'write', handler}) |
| listAgents / listActions | listAgents() / listActions() → detached definitions/schemas, without handlers |
| getManifest | getManifest() → detached manifest, or null before load |
| loadPeer | await loadPeer(url, {consent, userInitiated = false}) → validated peer names, execution: 'validation-only' |
| recalculateItinerary | recalculateItinerary(itinerary) → edited copy, recomputed costs/transit/sources and omission warnings |
| handleQueryInvocation | await handleQueryInvocation(options = {}) → URL-goal result, or null |
| testConnection | await testConnection({baseUrl, model, apiKey}) → status from one scoped connection request |
| validate | validate(schema, value, path = '$') → true or throw, supported subset only |
| validateNetwork | validateNetwork(network, entry, actionNames = []) → true or throw |
| createRuntime | createRuntime({fetch, baseUrl, data, onEvent} = {}) → isolated runtime; Node may require('./runtime.js') |
| events / version | Lifecycle EventTarget / version string |

~~~js
const api = window.AgenticWeb;
await api.load();
const result = await api.run('Plan a 2-day food trip in Hong Kong under $150', {
  startDate: '2026-11-23', // Optional; default is today in UTC.
  constraints: { pace: 'normal' },
  onEvent: event => console.log(event),
  limits: { maxToolCalls: 40, timeoutMs: 30000 }
});
console.log(result.days, result.cost, result.summary);
~~~

Constraints override days, budget_usd, pace, interests, area and family. Inference accepts a profile object or 'byok'
to read the stored UI profile. writeToPage: true also requires
confirmWrite: async ({tool, input, destination}) => boolean.

Results contain goal, constraints, days/items, costs, sources, summary and trace. Each item's transit_before is null
for the first stop or a timed leg with mode/duration/distance/fare/declared-transfer flag. transit_hkd exposes the
same fare, counted **once** under transport. Costs are per person; conversion uses HK$7.80/US$1.

### URL invocation

**index.html?goal=Plan%20a%202-day%20food%20trip%20under%20%24150** auto-runs the goal.
Add **&format=json** to replace the body with a pre element (id agentic-web-result) containing the serialized result,
and set a JSON-specific title. This is a browser document, **not an HTTP JSON API endpoint**.

### Same-origin postMessage

Only same-origin callers are accepted. Check origin, source and correlation id:

~~~js
const child = window.open('./index.html', 'wayfinder');
const id = 'trip-1';
window.addEventListener('message', event => {
  if (event.origin !== location.origin || event.source !== child) return;
  if (event.data?.type !== 'agentic-web:result' || event.data.id !== id) return;
  console.log(event.data.result ?? event.data.error);
});
// Send after the child page loads runtime.js.
child.addEventListener('load', () => child.postMessage({
  type: 'agentic-web:invoke', id,
  goal: 'Plan a relaxed 1-day family outing in Kowloon'
}, location.origin));
~~~

Errors return the same envelope with an error string instead of result. CORS-enabled metadata does not open this API.

### Peer loading

~~~js
const api = window.AgenticWeb;
await api.load();
const url = new URL('./peers/hk_weather_tips/hk_weather_tips', location.href);
const peer = await api.loadPeer(url.href, {
  userInitiated: true,
  consent: async ({origin, purpose}) => window.confirm(origin + '\n' + purpose)
});
console.log(peer.agents); // ['weather_guide']; sample only, not executed.
~~~

The final URL segment is the exact network name, not a JSON file. The runtime reads the sibling manifest, resolves
its declared network file and asks consent before both fetches. The UI supplies a dedicated origin/purpose dialog.
Cross-origin peers need CORS-enabled hosting.

## Optional LLM settings and privacy

Open **Settings**, choose custom OpenAI-compatible, OpenRouter or Otari, and enter base URL, model and key.
Presets are conveniences, not evidence of live provider testing.

- The UI stores the profile only in origin-scoped localStorage under **wayfinder.byok**. **Delete stored profile**
  removes it. Without a usable key, planning remains local.
- Requests go to the configured base URL plus **/chat/completions**. The key goes only in its Authorization header,
  never in URLs, trace or peer requests. HTTPS is required except loopback development.
- The LLM receives the goal for parsing and grounded itinerary facts for summary prose. It does not research places,
  choose prices, schedule stops, dispatch tools or contact peers. Invalid replies/configuration and request errors
  fall back to local parsing/prose; grounded local reasoning remains alongside generated prose.
- The inference badge labels the local planner or configured model/host. Configuration is not proof every provider
  call succeeded; fallbacks appear in the trace.
- **Test connection** makes a small request to that provider. No credential is bundled.
- localStorage is not a secret vault: same-origin scripts can read it. Use a trusted host; delete the profile on
  shared devices. No bookings or purchases are made.

## Devpost requirement checklist

This maps the five requested entry surfaces, not an organizer compliance ruling.

| Requirement | Files/features |
| --- | --- |
| Conforming JSON describing the network | agent-manifest.json, resolved Neuro SAN-format agent.json, schemas/metadata; scope limits disclosed above |
| Runtime file | Independent browser/Node runtime.js; no copied reference runtime |
| Interface for users and agents | index.html, styles.css, app.js; editable UI, window APIs, URL JSON mode, same-origin postMessage |
| Optional LLM/key configuration UI | Provider/model/base URL/key settings, localStorage, test/delete, honest badge and fallback |
| Network interacting with website and other agentic websites | UI consumes runtime results; approval-gated page event; consent/policy-gated peer loading and sample listing. **Peer execution is not implemented.** |

Judging-oriented notes: inspectable trace/delegation, reproducible grounded examples, useful editable timelines and
transit, declarative publication and a small independent runtime are the intended strengths. These are design
intentions, not claims of judging scores, awards or certified portability.

## Devpost submission notes — entrant actions still required

Details supplied for this entry; verify the organizer's current rules before submitting:

- Hosted by **Cognizant**. **$10,000 total prizes**: first **$5,000**, second **$3,000**, third **$2,000**.
- Deadline: **January 12, 2027, 12:00am GMT+8** = **January 11, 2027, 16:00 UTC**.
- Video must be **under two minutes**, show the project running in a browser, be **narrated by the entrant in person
  (no AI voiceover)** and be uploaded publicly to **YouTube**.
- The site must be **publicly accessible for judging**. This repository has no deployed site: choose/configure a
  static host, verify HTTPS/CORS and supply the public URL.
- Complete the submission and check the public site/video/repository links from a fresh browser.

Suggested **1 minute 50 second** demo outline:

| Time | Show / explain |
| --- | --- |
| 0:00–0:15 | Trip-planning problem; honest local-rule-based default |
| 0:15–0:40 | Food example, four agents, expanded tool call and geographic clusters |
| 0:40–1:05 | Meals/transit/budget; switch to culture/views and show the viewpoint |
| 1:05–1:20 | Edit a stop and export text/JSON |
| 1:20–1:35 | Manifest/network links, machine entry, consent-gated peer listing; disclose no peer execution |
| 1:35–1:50 | BYOK settings without revealing a key; reproducibility and limitations |

## Data disclaimer and license

data/places.json contains 71 real Hong Kong entries with individual approximate coordinates, hours, weekly closures,
typical per-person prices and a source URL per place. Meal slots and dining styles support scheduling.
**Prices and hours are approximate; verify before visiting.** Some sources describe venues, not current menus or tariffs.
Admission tiers, holidays and live operations change. This is not live navigation, booking or professional travel advice.

Overnight hours, availability, party-size pricing, lodging and airport transfers are not modeled. Food allowances cover
selected meals, not all incidental purchases. Dates default to UTC; set startDate for reproducibility. New goals may
exceed catalogue coverage; manual edits can violate automatic compactness/meal-window preferences.

**MIT license**, copyright **2026 ZQ051031**. See [LICENSE](LICENSE).
Third-party linked material remains subject to its owners' terms.
