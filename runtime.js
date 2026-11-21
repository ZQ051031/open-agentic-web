/* Wayfinder: dependency-free, data-only network orchestration. */
(function (root) {
  'use strict';
  const version = '1.0.0';
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const minutes = (time) => time.split(':').reduce((h, m) => h * 60 + Number(m));
  const clock = (n) => String(Math.floor(n / 60)).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0');
  const round = (n) => Math.round(n * 100) / 100;
  /** Validate the supported JSON Schema subset; throw on invalid data. */
  function validate(schema, value, path = '$') {
    if (!schema || typeof schema !== 'object') throw Error('Invalid schema at ' + path);
    const type = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
    if (schema.type && !(schema.type === type || (schema.type === 'integer' && Number.isInteger(value))))
      throw Error(path + ': expected ' + schema.type);
    if (
      typeof value === 'number' &&
      (!Number.isFinite(value) ||
        (schema.minimum !== undefined && value < schema.minimum) ||
        (schema.maximum !== undefined && value > schema.maximum))
    )
      throw Error(path + ': number out of range');
    if (schema.enum && !schema.enum.includes(value)) throw Error(path + ': invalid enum');
    if (type === 'object') {
      for (const key of schema.required || []) if (!Object.hasOwn(value, key)) throw Error(path + ': missing ' + key);
      for (const [key, item] of Object.entries(value)) {
        if (schema.properties?.[key]) validate(schema.properties[key], item, path + '.' + key);
        else if (schema.additionalProperties === false) throw Error(path + ': unexpected ' + key);
      }
    }
    if (type === 'array' && schema.items)
      value.forEach((item, i) => validate(schema.items, item, path + '[' + i + ']'));
    return true;
  }
  /** Reject invalid agent graphs and unsupported executable capabilities. */
  function validateNetwork(network, entry, actionNames = []) {
    if (!network?.metadata?.description || !Array.isArray(network.tools) || !network.tools.length)
      throw Error('Invalid network: metadata.description and agents required');
    const forbidden = new Set([
      'code',
      'handler',
      'implementation',
      'class',
      'coded_tools',
      'include',
      'command',
      'module',
      'script',
    ]);
    function inspect(value) {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        if (forbidden.has(key)) throw Error('Unsupported executable definition: ' + key);
        inspect(child);
      }
    }
    inspect(network);
    const names = new Set();
    for (const agent of network.tools) {
      if (typeof agent.name !== 'string' || names.has(agent.name))
        throw Error('Duplicate or invalid agent name: ' + agent.name);
      names.add(agent.name);
      if (!agent.function?.description || typeof agent.instructions !== 'string' || !Array.isArray(agent.tools))
        throw Error('Invalid agent: ' + agent.name);
      validate(agent.function.parameters, { request: 'validate' });
    }
    if (!names.has(entry?.front_man)) throw Error('Invalid front_man: ' + entry?.front_man);
    for (const agent of network.tools)
      for (const ref of agent.tools) {
        if (typeof ref !== 'string' || (!names.has(ref) && !actionNames.includes(ref)))
          throw Error('Missing or unsupported agent/action reference: ' + JSON.stringify(ref));
      }
    return true;
  }
  function parseGoal(goal, places) {
    const text = goal.toLowerCase();
    const money =
      text.match(/(?:hkd|hk\$|usd|us\$|\$)\s*([\d]+(?:\.\d+)?)/) || text.match(/([\d]+(?:\.\d+)?)\s*(hkd|usd)/);
    const amount = money ? Number(money[1]) : 100;
    const hkd = money && /hkd|hk\$/.test(money[0]);
    const district = [...new Set(places.map((p) => p.district))]
      .sort((a, b) => b.length - a.length)
      .find((d) => text.includes(d.toLowerCase()));
    return {
      days: Math.min(7, Math.max(1, Number(text.match(/(\d+)[ -]*day/)?.[1] || 1))),
      budget_usd: hkd ? amount / 7.8 : amount,
      pace: text.includes('relaxed') ? 'relaxed' : text.includes('packed') ? 'packed' : 'normal',
      interests: ['food', 'culture', 'nature', 'family', 'nightlife', 'shopping', 'views', 'museum'].filter((t) =>
        text.includes(t),
      ),
      area:
        district ||
        (text.includes('kowloon')
          ? 'kowloon'
          : text.includes('hong kong island')
            ? 'hong_kong_island'
            : text.includes('new territories')
              ? 'new_territories'
              : ''),
      family: /family|kids|children/.test(text),
    };
  }
  const constraintsSchema = {
    type: 'object',
    required: ['days', 'budget_usd', 'pace', 'interests', 'area', 'family'],
    additionalProperties: false,
    properties: {
      days: { type: 'integer', minimum: 1, maximum: 7 },
      budget_usd: { type: 'number', minimum: 0, maximum: 1000000 },
      pace: { type: 'string', enum: ['relaxed', 'normal', 'packed'] },
      interests: {
        type: 'array',
        items: {
          type: 'string',
          enum: ['food', 'culture', 'nature', 'family', 'nightlife', 'shopping', 'views', 'museum'],
        },
      },
      area: { type: 'string' },
      family: { type: 'boolean' },
    },
  };
  /** Create an isolated runtime with optional fetch, base URL, data and event adapters. */
  function createRuntime(config = {}) {
    let manifest,
      network,
      entry,
      base,
      dataset = config.data;
    const actions = new Map();
    const events = typeof EventTarget === 'function' ? new EventTarget() : null;
    const fetcher = (...args) => (config.fetch || root.fetch)(...args);
    async function json(url, options = {}) {
      const response = await fetcher(url, { credentials: 'omit', ...options });
      if (!response.ok) throw Error('HTTP ' + response.status + ' loading ' + url);
      try {
        return await response.json();
      } catch {
        throw Error('Malformed JSON: ' + url);
      }
    }
    /** Register a typed, effect-classified site action owned by the caller. */
    function registerAction(name, definition) {
      if (
        !name ||
        !definition.description ||
        !definition.parameters ||
        !['read', 'write'].includes(definition.effect) ||
        typeof definition.handler !== 'function'
      )
        throw Error('Invalid action registration: ' + name);
      actions.set(name, definition);
    }
    /** Fetch an exact named network and validate it before making it runnable. */
    async function load(manifestUrl = './agent-manifest.json', networkName = 'wayfinder') {
      const url = new URL(manifestUrl, config.baseUrl || root.location?.href || 'http://localhost/');
      const candidate = await json(url.href);
      const selected = candidate.networks?.find((n) => n.name === networkName);
      if (!selected) throw Error('No exact network match: ' + networkName);
      const definition = await json(new URL(selected.hocon, url).href);
      validateNetwork(definition, selected, [...actions.keys()]);
      for (const name of candidate.actions?.agentTools || [])
        if (!actions.has(name)) throw Error('Unavailable site action: ' + name);
      const data = dataset || (await json(new URL('./data/places.json', url).href));
      manifest = candidate;
      network = definition;
      entry = selected;
      base = url;
      dataset = data;
      return api;
    }
    const object = (properties) => ({ type: 'object', properties, additionalProperties: false });
    const array = { type: 'array', items: { type: 'object' } };
    const str = { type: 'string' };
    registerAction('search_places', {
      description: 'Rank real places by interests and family suitability, excluding unrequested remote outliers.',
      parameters: { ...object({ constraints: constraintsSchema }), required: ['constraints'] },
      effect: 'read',
      handler: ({ constraints: c = {} }) =>
        dataset.places
          .filter((p) => {
            const matchesArea = !c.area || p.region === c.area || p.district.toLowerCase() === c.area.toLowerCase();
            const core =
              ['hong_kong_island', 'kowloon'].includes(p.region) &&
              p.district !== 'Stanley' &&
              (p.district !== 'Peak' || c.interests.includes('views'));
            return matchesArea && (c.area || core) && (!c.family || p.kid_friendly);
          })
          .sort((a, b) => score(b, c) - score(a, c) || a.id.localeCompare(b.id)),
    });
    function score(p, c) {
      return (c.interests || []).filter((i) => p.tags.includes(i)).length * 12 + (c.family && p.kid_friendly ? 8 : 0);
    }
    registerAction('get_place', {
      description: 'Look up a grounded place by id.',
      parameters: { ...object({ id: str }), required: ['id'] },
      effect: 'read',
      handler: ({ id }) => {
        const p = dataset.places.find((p) => p.id === id);
        if (!p) throw Error('Unknown place: ' + id);
        return p;
      },
    });
    function distanceKm(a, b) {
      const radians = (degrees) => (degrees * Math.PI) / 180;
      const lat = radians(b.lat - a.lat);
      const lng = radians(b.lng - a.lng);
      const h = Math.sin(lat / 2) ** 2 + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(lng / 2) ** 2;
      return 6371 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
    }
    function transit(a, b) {
      if (!a) return { minutes: 0, cost_hkd: 0, distance_km: 0, mode: 'Start here', declared_transfer: false };
      const distance = distanceKm(a, b);
      const harbour = new Set([a.region, b.region]).has('hong_kong_island') && a.region !== b.region;
      const mountain = (a.district === 'Peak') !== (b.district === 'Peak');
      const remote = a.region === 'lantau' || b.region === 'lantau' || distance > 12;
      let duration, cost, mode;
      if (distance <= 1.2 && !harbour && !mountain) {
        duration = Math.max(5, Math.ceil((((distance * 1.3) / 4.3) * 60) / 5) * 5);
        cost = 0;
        mode = 'Walk';
      } else {
        duration = Math.ceil((12 + distance * 2.5 + (harbour ? 20 : 0)) / 5) * 5;
        cost = 8 + Math.ceil(distance / 2) * 2 + (harbour ? 8 : 0);
        mode = harbour ? 'MTR / ferry + walk' : 'MTR / bus + walk';
        if (mountain) {
          duration = Math.max(40, duration);
          cost = Math.max(15, cost);
          mode = 'Bus + walk (Peak)';
        }
        if (remote) {
          duration = Math.max(45, duration);
          cost = Math.max(25, cost);
          mode = 'Bus / rail + walk';
        }
      }
      return {
        minutes: duration,
        cost_hkd: cost,
        distance_km: round(distance),
        mode,
        declared_transfer: harbour || mountain || distance > 12,
      };
    }
    function weekday(date) {
      return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][
        new Date(date + 'T12:00:00Z').getUTCDay()
      ];
    }
    function visitItem(place, previous, start, mealSlot = null) {
      const travel = transit(previous, place);
      return {
        time_start: clock(start),
        time_end: clock(start + place.duration_min),
        place_id: place.id,
        name: place.name,
        district: place.district,
        category: place.category,
        cost_hkd: place.price_hkd,
        meal_slot: mealSlot,
        transit_hkd: travel.cost_hkd,
        transit_before: previous
          ? {
              ...travel,
              time_start: clock(start - travel.minutes),
              time_end: clock(start),
              from_place_id: previous.id,
              to_place_id: place.id,
              notes: 'Distance-based allowance, not live routing or a fare quote.',
            }
          : null,
        notes: place.notes,
      };
    }
    registerAction('estimate_transit', {
      description:
        'Haversine-based walking or rail/bus allowance with harbour and mountain penalties; not live routing.',
      parameters: object({ from: { type: 'object' }, to: { type: 'object' } }),
      effect: 'read',
      handler: ({ from, to }) => transit(from, to),
    });
    function totals(days) {
      const breakdown = { attraction: 0, restaurant: 0, transport: 0 };
      for (const day of days)
        for (const item of day.items) {
          breakdown[item.category] += item.cost_hkd;
          breakdown.transport += item.transit_hkd || 0;
        }
      const total_hkd = round(Object.values(breakdown).reduce((a, b) => a + b, 0));
      return { total_hkd, total_usd: round(total_hkd / 7.8), breakdown };
    }
    registerAction('total_costs', {
      description: 'Total visits and inter-district travel.',
      parameters: { ...object({ days: array }), required: ['days'] },
      effect: 'read',
      handler: ({ days }) => totals(days),
    });
    registerAction('check_budget', {
      description: 'Compare total costs to the budget.',
      parameters: {
        ...object({ total_hkd: { type: 'number', minimum: 0 }, budget_usd: { type: 'number', minimum: 0 } }),
        required: ['total_hkd', 'budget_usd'],
      },
      effect: 'read',
      handler: ({ total_hkd, budget_usd }) => ({ within_budget: total_hkd <= budget_usd * 7.8 }),
    });
    function mealSlots(place) {
      return place.meal_slots || (place.category === 'restaurant' ? ['lunch', 'dinner'] : []);
    }
    function daySlots(c) {
      const food = c.interests.includes('food');
      let definitions;
      if (c.pace === 'packed') {
        definitions = [
          ['breakfast', 540, 540, 660],
          ['visit', 630, 600, 720],
          ['lunch', 735, 720, 840],
          ['visit', 825, 810, 930],
          ['snack', 930, 900, 1020],
          ['visit', 1005, 960, 1110],
          ['dinner', 1110, 1080, 1200],
          ['visit', 1200, 1140, 1260],
        ];
      } else if (c.pace === 'relaxed' && food) {
        definitions = [
          ['breakfast', 660, 600, 690],
          ['lunch', 795, 720, 840],
          ['visit', 930, 900, 1020],
          ['dinner', 1080, 1080, 1200],
        ];
      } else if (c.pace === 'relaxed') {
        definitions = [
          ['visit', 600, 570, 690],
          ['lunch', 735, 720, 840],
          ['visit', 855, 810, 960],
          ['snack', 975, 930, 1050],
        ];
      } else if (food) {
        definitions = [
          ['breakfast', 540, 540, 660],
          ['visit', 645, 600, 735],
          ['lunch', 750, 720, 840],
          ['visit', 870, 810, 960],
          ['snack', 990, 900, 1050],
          ['dinner', 1110, 1080, 1200],
        ];
      } else {
        definitions = [
          ['visit', 570, 540, 660],
          ['visit', 660, 630, 750],
          ['lunch', 765, 720, 840],
          ['visit', 870, 810, 960],
          ['visit', 990, 930, 1110],
          ['dinner', 1110, 1080, 1200],
        ];
      }
      return definitions.map(([kind, target, earliest, latest]) => ({ kind, target, earliest, latest }));
    }
    function slotMatches(place, slot) {
      return slot.kind === 'visit' ? place.category === 'attraction' : mealSlots(place).includes(slot.kind);
    }
    function compactDay(pool, c, date, allowance, used) {
      const slots = daySlots(c);
      const available = pool.filter((p) => !used.has(p.id) && !p.closed_days.includes(weekday(date)));
      const food = c.interests.includes('food');
      const rest = { relaxed: 20, normal: 10, packed: 5 }[c.pace];
      let beam = [{ items: [], selected: new Set(), cost: 0, value: 0, previous: null, end: 0 }];
      for (const slot of slots) {
        const next = [];
        for (const state of beam) {
          next.push({ ...state, value: state.value - 120 });
          for (const p of available) {
            if (state.selected.has(p.id) || !slotMatches(p, slot)) continue;
            if (food && c.pace === 'relaxed' && slot.kind === 'visit' && p.duration_min < 60) continue;
            const travel = transit(state.previous, p);
            const arrival = state.previous ? state.end + rest + travel.minutes : slot.earliest;
            const preferred = state.previous ? Math.min(slot.target, state.end + 90) : slot.target;
            const viewpointTime = c.interests.includes('views') && p.tags.includes('viewpoint') ? 15 * 60 : 0;
            const start = Math.max(arrival, minutes(p.open), slot.earliest, preferred, viewpointTime);
            const end = start + p.duration_min;
            if (
              start > slot.latest ||
              end > minutes(p.close) ||
              end > 21 * 60 ||
              (state.previous && start - state.end > 90) ||
              state.cost + p.price_hkd + travel.cost_hkd > allowance + 0.001
            )
              continue;
            const styles = state.items.map((item) => available.find((p) => p.id === item.place_id)?.dining_style);
            const newFlavour = p.dining_style && !styles.includes(p.dining_style) ? 12 : 0;
            const coveredInterests = new Set(
              state.items.flatMap((item) => available.find((place) => place.id === item.place_id).tags),
            );
            const interestDiversity =
              c.interests.filter((interest) => p.tags.includes(interest) && !coveredInterests.has(interest)).length *
              45;
            const viewpoint =
              c.interests.includes('views') && p.tags.includes('viewpoint') && !coveredInterests.has('viewpoint')
                ? 140
                : 0;
            const mealTarget = allowance * ({ breakfast: 0.3, lunch: 0.25, snack: 0.1, dinner: 0.35 }[slot.kind] || 0);
            const experience = food && mealTarget ? Math.min(p.price_hkd / mealTarget, 1) * 12 : -p.price_hkd * 0.015;
            const districtChange = state.previous && state.previous.district !== p.district;
            const penalty =
              travel.distance_km * (c.family ? 9 : 4) +
              (districtChange ? (c.family ? 16 : 4) : 0) +
              (travel.declared_transfer ? 45 : 0);
            const value =
              state.value +
              160 +
              score(p, c) +
              interestDiversity +
              viewpoint +
              newFlavour +
              experience +
              (food && p.category === 'restaurant' ? 35 : 0) -
              penalty -
              Math.abs(start - slot.target) * 0.04;
            next.push({
              items: [...state.items, visitItem(p, state.previous, start, slot.kind === 'visit' ? null : slot.kind)],
              selected: new Set([...state.selected, p.id]),
              cost: state.cost + p.price_hkd + travel.cost_hkd,
              value,
              previous: p,
              end,
            });
          }
        }
        next.sort(
          (a, b) =>
            b.value - a.value ||
            a.items
              .map((p) => p.place_id)
              .join()
              .localeCompare(b.items.map((p) => p.place_id).join()),
        );
        beam = next.slice(0, 32);
      }
      return beam[0];
    }
    function schedule(places, c, startDate) {
      const used = new Set(),
        anchors = [],
        days = [];
      let remaining = c.budget_usd * 7.8 * 0.94;
      const districts = [...new Set(places.map((p) => p.district))].sort();
      const radius = c.family ? 1.8 : 2.6;
      for (let day = 1; day <= c.days; day++) {
        const date = new Date(startDate + 'T12:00:00Z');
        date.setUTCDate(date.getUTCDate() + day - 1);
        const dateString = date.toISOString().slice(0, 10);
        const allowance = remaining / (c.days - day + 1);
        let best;
        for (const district of districts) {
          const local = places.filter((p) => p.district === district);
          const anchor = {
            district,
            region: local[0].region,
            lat: local.map((p) => p.lat).sort((a, b) => a - b)[Math.floor(local.length / 2)],
            lng: local.map((p) => p.lng).sort((a, b) => a - b)[Math.floor(local.length / 2)],
          };
          const pool = places.filter(
            (p) =>
              p.region === anchor.region &&
              distanceKm(anchor, p) <= radius &&
              (c.interests.includes('views') || (p.district === 'Peak') === (anchor.district === 'Peak')),
          );
          const planned = compactDay(pool, c, dateString, allowance, used);
          const repetition = anchors.reduce(
            (penalty, a) =>
              penalty + (a.region === anchor.region ? 90 : 0) + Math.max(0, 5 - distanceKm(a, anchor)) * 30,
            0,
          );
          const value = planned.value - repetition;
          if (!best || value > best.value) best = { ...planned, value, anchor, pool };
        }
        const items = best?.items || [];
        items.forEach((item) => used.add(item.place_id));
        if (best) anchors.push(best.anchor);
        const spent = totals([{ items }]).total_hkd;
        remaining -= spent;
        const budgetNotes = (best?.pool || [])
          .filter(
            (p) =>
              p.category === 'restaurant' && p.price_hkd > allowance && !p.closed_days.includes(weekday(dateString)),
          )
          .map(
            (p) =>
              'Excluded ' +
              p.name +
              ' (HK$' +
              p.price_hkd +
              '): this meal alone exceeds the day’s HK$' +
              round(allowance) +
              ' shared allowance.',
          );
        days.push({
          day,
          date: dateString,
          anchor: best?.anchor || null,
          items,
          budget_notes: budgetNotes,
          planning_notes: items.length
            ? 'Clustered around ' +
              best.anchor.district +
              '; ' +
              radius +
              ' km anchor radius, no cross-harbour hops. Meal windows and opening hours checked.' +
              (items.length < daySlots(c).length
                ? ' Only ' +
                  items.length +
                  '/' +
                  daySlots(c).length +
                  ' stops fit the catalogue, meal windows and budget; no missing meals or stops were invented.'
                : '')
            : 'No feasible places matched these constraints.',
        });
      }
      return days;
    }
    function explainPlan(days, constraints, cost, edited = false) {
      const areas = days
        .map((day) => {
          const districts = [...new Set(day.items.map((item) => item.district))];
          const meals = day.items.filter((item) => item.category === 'restaurant').length;
          return (
            'Day ' +
            day.day +
            ': ' +
            (districts.join(' → ') || 'no feasible stops') +
            ' (' +
            meals +
            ' food stops)' +
            (day.anchor && !edited ? ', anchored around ' + day.anchor.district : '')
          );
        })
        .join('. ');
      const limit = round(constraints.budget_usd * 7.8);
      const used = limit ? Math.round((cost.total_hkd / limit) * 100) : 0;
      const tradeoffs = days.flatMap((day) => day.budget_notes || []);
      const empty = days.every((day) => !day.items.length);
      return (
        'Local rule-based itinerary (not an LLM)' +
        (edited ? ', edited by you' : '') +
        '. ' +
        areas +
        '. ' +
        (empty ? 'No feasible places matched these constraints. ' : '') +
        'Budget agent: HK$' +
        cost.total_hkd +
        ' of HK$' +
        limit +
        ' (US$' +
        constraints.budget_usd +
        ') used, ' +
        used +
        '% of the limit; HK$' +
        round(limit - cost.total_hkd) +
        ' remaining. ' +
        (edited
          ? 'Edits recomputed from catalogue durations and distance-based travel allowances. '
          : 'Reserved a 6% contingency and balanced priced meals with nearby free sights, ' +
            'rather than spending for its own sake. ') +
        (tradeoffs.length ? tradeoffs.join(' ') + ' ' : 'No budget-driven swaps were necessary. ') +
        (constraints.family
          ? 'Family-friendly stops and a strong penalty on district changes keep transfers down. '
          : '') +
        dataset.disclaimer +
        ' Transit is estimated, not live routing. Lodging and airport transfers are excluded. ' +
        'No bookings made.'
      );
    }
    registerAction('build_schedule', {
      description: 'Select affordable grounded visits with meal windows, opening hours and transit.',
      parameters: {
        ...object({ places: array, constraints: constraintsSchema, startDate: str }),
        required: ['places', 'constraints', 'startDate'],
      },
      effect: 'read',
      handler: ({ places, constraints, startDate }) => schedule(places, constraints, startDate),
    });
    registerAction('write_itinerary_to_page', {
      description: 'Publish an itinerary to the caller page through an event; no booking or purchase.',
      parameters: { ...object({ itinerary: { type: 'object' } }), required: ['itinerary'] },
      effect: 'write',
      handler: ({ itinerary }) => {
        if (root.document && typeof root.CustomEvent === 'function')
          root.dispatchEvent(new root.CustomEvent('wayfinder:itinerary', { detail: itinerary }));
        return { status: 'succeeded', outcome: 'Page event dispatched; no bookings made.' };
      },
    });
    /** Plan a goal with bounded delegation, optional BYOK assistance and live events. */
    async function run(goal, options = {}) {
      if (!network) throw Error('Load a validated network before running');
      if (typeof goal !== 'string' || !goal.trim()) throw Error('Goal must be a non-empty string');
      const trace = [],
        started = Date.now();
      const cap = (name, fallback, hard) => Math.min(hard, options.limits?.[name] ?? fallback);
      const limits = {
        agents: cap('maxAgentInvocations', network.max_steps || 40, 100),
        tools: cap('maxToolCalls', network.max_steps || 40, 200),
        depth: cap('maxDepth', 4, 10),
        timeout: cap('timeoutMs', 30000, 120000),
      };
      let agentCalls = 0,
        toolCalls = 0;
      const emit = (type, detail = {}) => {
        const event = { type, ...clone(detail) };
        trace.push(event);
        if (trace.length > 500) trace.shift();
        try {
          (options.onEvent || config.onEvent)?.(clone(event));
        } catch {
          /* Observers cannot alter execution. */
        }
        if (events && typeof CustomEvent === 'function')
          events.dispatchEvent(new CustomEvent(type, { detail: clone(event) }));
      };
      const check = () => {
        if (Date.now() - started >= limits.timeout) throw Error('Execution timeout');
      };
      async function bounded(work) {
        check();
        let timer;
        try {
          return await Promise.race([
            Promise.resolve().then(work),
            new Promise((_, reject) => {
              timer = setTimeout(
                () => reject(Error('Execution timeout')),
                Math.max(1, limits.timeout - (Date.now() - started)),
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      }
      async function tool(agent, name, input) {
        check();
        if (++toolCalls > limits.tools) throw Error('Tool call limit exceeded');
        if (!network.tools.find((a) => a.name === agent)?.tools.includes(name))
          throw Error('Agent may not call action: ' + name);
        const action = actions.get(name);
        if (!action) throw Error('Unavailable action: ' + name);
        validate(action.parameters, input);
        emit('tool_call', { tool: name, input });
        if (
          action.effect === 'write' &&
          !(await bounded(() => options.confirmWrite?.({ tool: name, input: clone(input), destination: base.origin })))
        )
          throw Error('Write action requires approval: ' + name);
        const start = Date.now(),
          output = await bounded(() => action.handler(clone(input)));
        emit('tool_result', { tool: name, output, ms: Date.now() - start });
        return output;
      }
      async function agent(name, from, request, work) {
        check();
        if (++agentCalls > limits.agents) throw Error('Agent invocation limit exceeded');
        const depth = from ? 2 : 1;
        if (depth > limits.depth) throw Error('Composition depth limit exceeded');
        if (from && !network.tools.find((a) => a.name === from)?.tools.includes(name))
          throw Error('Agent delegation denied: ' + name);
        const definition = network.tools.find((a) => a.name === name);
        if (!definition) throw Error('Missing agent: ' + name);
        validate(definition.function.parameters, { request });
        if (from) emit('handoff', { from, to: name, request });
        emit('agent_start', { agent: name });
        emit('reasoning', { agent: name, text: request });
        const result = await work();
        emit('agent_end', { agent: name });
        return result;
      }
      let profile = options.inference?.apiKey ? options.inference : options.inference?.profile;
      if (options.inference === 'byok') {
        try {
          profile = JSON.parse(root.localStorage?.getItem('wayfinder.byok') || 'null');
        } catch {
          profile = null;
        }
      }
      async function llm(task, payload) {
        if (!profile) return null;
        try {
          const url = new URL(profile.baseUrl.replace(/\/+$/, '') + '/chat/completions');
          if (
            url.username ||
            url.password ||
            url.search ||
            url.hash ||
            (url.protocol !== 'https:' &&
              !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
          )
            throw Error('Unsafe inference URL');
          if (!profile.apiKey || !profile.model) throw Error('Incomplete BYOK profile');
          const result = await bounded(() =>
            json(url.href, {
              method: 'POST',
              redirect: 'error',
              headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + profile.apiKey },
              body: JSON.stringify({
                model: profile.model,
                messages: [
                  { role: 'system', content: task },
                  { role: 'user', content: JSON.stringify(payload) },
                ],
              }),
            }),
          );
          const text = result.choices?.[0]?.message?.content;
          if (typeof text !== 'string' || text.includes(profile.apiKey)) throw Error('Invalid inference response');
          return text;
        } catch {
          emit('reasoning', {
            text: 'BYOK inference unavailable or invalid; falling back to the local rule-based planner.',
          });
          return null;
        }
      }
      emit('run_start', { goal, inference: profile ? 'byok-assisted' : 'local-rule-based' });
      try {
        return await agent(
          entry.front_man,
          null,
          'Parse constraints and delegate grounded rule-based planning.',
          async () => {
            let constraints = parseGoal(goal, dataset.places);
            const parsed = await llm(
              'Return only JSON constraints: days (1-7), budget_usd (HKD / 7.8), pace (relaxed/normal/packed), ' +
                'interests (food,culture,nature,family,nightlife,shopping,views,museum), ' +
                'area (district or region, empty if unspecified), family (boolean). ' +
                'Defaults: one day, USD100, normal.',
              goal,
            );
            if (parsed) {
              try {
                const c = JSON.parse(parsed);
                validate(constraintsSchema, c);
                constraints = c;
              } catch {
                emit('reasoning', { text: 'Invalid BYOK constraints; using local rule-based parsing.' });
              }
            }
            constraints = { ...constraints, ...options.constraints };
            validate(constraintsSchema, constraints);
            const startDate = options.startDate || new Date().toISOString().slice(0, 10);
            if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !Number.isFinite(Date.parse(startDate)))
              throw Error('Invalid startDate');
            const places = await agent(
              'place_researcher',
              entry.front_man,
              'Rank grounded places by interests and family suitability; exclude unrequested remote outliers.',
              () => tool('place_researcher', 'search_places', { constraints }),
            );
            emit('progress', { pct: 30 });
            // Scheduling is delegated first so the budget agent audits actual visits and transit.
            const days = await agent(
              'itinerary_scheduler',
              entry.front_man,
              'Choose distinct geographic anchors; fit meal windows, compact routes and distance-based transit.',
              () => tool('itinerary_scheduler', 'build_schedule', { places, constraints, startDate }),
            );
            for (const day of days) emit('reasoning', { agent: 'itinerary_scheduler', text: day.planning_notes });
            emit('progress', { pct: 65 });
            const cost = await agent(
              'budget_analyst',
              entry.front_man,
              'Audit actual per-person visit and transit totals against the budget.',
              async () => {
                const total = await tool('budget_analyst', 'total_costs', { days });
                const checked = await tool('budget_analyst', 'check_budget', {
                  total_hkd: total.total_hkd,
                  budget_usd: constraints.budget_usd,
                });
                return { ...total, budget_usd: constraints.budget_usd, ...checked };
              },
            );
            const ids = new Set(days.flatMap((d) => d.items.map((i) => i.place_id)));
            const sources = dataset.places.filter((p) => ids.has(p.id)).map((p) => ({ name: p.name, url: p.source }));
            let summary = explainPlan(days, constraints, cost);
            emit('reasoning', { agent: 'budget_analyst', text: summary });
            const generated = await llm(
              'Summarize only these grounded itinerary facts in plain text. ' +
                'Do not introduce places, prices or bookings.',
              { days, cost, rationale: summary },
            );
            if (generated) summary = generated + '\n\n' + summary;
            const result = { goal, constraints, days, cost, summary, sources, trace };
            validate(network.output_schema, result);
            if (options.writeToPage)
              await tool(entry.front_man, 'write_itinerary_to_page', { itinerary: { ...result, trace: [] } });
            emit('progress', { pct: 100 });
            emit('run_end', { total_hkd: cost.total_hkd });
            return result;
          },
        );
      } catch (error) {
        emit('error', { message: error.message });
        throw error;
      }
    }
    /** Load and list peer agents after policy and consent checks; never execute peer code. */
    async function loadPeer(url, { consent, userInitiated = false } = {}) {
      if (!manifest) throw Error('Load caller manifest first');
      const peer = new URL(url, base);
      if (
        peer.protocol !== 'https:' &&
        !(peer.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(peer.hostname))
      )
        throw Error('Peer requires HTTPS');
      if (peer.username || peer.password || peer.search || peer.hash) throw Error('Invalid peer URL');
      const name = decodeURIComponent(peer.pathname.split('/').pop());
      if (!name) throw Error('Peer URL must end with network name');
      const policy = manifest.peer_policy;
      const originAllowed = (origin) =>
        !policy?.deny_origins?.includes(origin) &&
        (policy?.mode === 'open' ||
          manifest.allowed_peers?.includes(origin) ||
          (policy?.manual_consent === true && userInitiated === true));
      if (!originAllowed(peer.origin)) throw Error('Peer origin denied: ' + peer.origin);
      async function approvedJson(target, purpose) {
        if (!originAllowed(target.origin)) throw Error('Peer origin denied: ' + target.origin);
        if (!consent || !(await consent({ origin: target.origin, url: target.href, purpose })))
          throw Error('Peer consent denied');
        return json(target.href, { redirect: 'error' });
      }
      const manifestUrl = new URL('./agent-manifest.json', peer);
      const pm = await approvedJson(manifestUrl, 'Read peer network manifest (validation/listing only)');
      const pe = pm.networks?.find((n) => n.name === name);
      if (!pe) throw Error('No exact peer network match: ' + name);
      const definitionUrl = new URL(pe.hocon, manifestUrl);
      if (
        definitionUrl.protocol !== 'https:' &&
        !(definitionUrl.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(definitionUrl.hostname))
      )
        throw Error('Peer definition requires HTTPS');
      const pn = await approvedJson(definitionUrl, 'Read and validate peer definition; no code execution');
      validateNetwork(pn, pe, [...actions.keys()]);
      return { name, front_man: pe.front_man, agents: pn.tools.map((a) => a.name), execution: 'validation-only' };
    }
    /** Run a URL goal and safely render JSON when format=json is requested. */
    async function handleQueryInvocation(options = {}) {
      if (!root.location) return null;
      const query = new URLSearchParams(root.location.search),
        goal = query.get('goal');
      if (!goal) return null;
      if (!network) await load();
      const result = await run(goal, options);
      if (query.get('format') === 'json' && root.document) {
        root.document.body.replaceChildren();
        const pre = root.document.createElement('pre');
        pre.id = 'agentic-web-result';
        pre.textContent = JSON.stringify(result, null, 2);
        root.document.body.append(pre);
        root.document.title = 'Wayfinder — itinerary JSON';
      }
      return result;
    }
    /** Recompute an edited visit order from catalogue facts, dropping stops that cannot fit. */
    function recalculateItinerary(itinerary) {
      if (!dataset) throw Error('Load the catalogue before editing');
      const result = clone(itinerary);
      const warnings = [];
      for (const day of result.days) {
        let now = 9 * 60;
        let previous;
        day.items = day.items.flatMap((item) => {
          const place = dataset.places.find((p) => p.id === item.place_id);
          if (!place) throw Error('Unknown place: ' + item.place_id);
          const travel = transit(previous, place);
          const slot =
            item.meal_slot ||
            (place.category === 'restaurant'
              ? now < 14 * 60
                ? 'lunch'
                : mealSlots(place).includes('snack')
                  ? 'snack'
                  : 'dinner'
              : null);
          const mealStart = { breakfast: 9 * 60, lunch: 12 * 60, snack: 15 * 60, dinner: 18 * 60 }[slot] || 0;
          const start = Math.max(now + travel.minutes, minutes(place.open), mealStart);
          const end = start + place.duration_min;
          if (place.closed_days.includes(weekday(day.date)) || end > minutes(place.close) || end > 22 * 60) {
            warnings.push(place.name + ' could not fit on day ' + day.day + ' and was left out. Try another day.');
            return [];
          }
          const visit = visitItem(place, previous, start, slot);
          previous = place;
          now = end + (result.constraints.pace === 'relaxed' ? 20 : 10);
          return [visit];
        });
      }
      const cost = totals(result.days);
      result.cost = {
        ...cost,
        budget_usd: result.constraints.budget_usd,
        within_budget: cost.total_hkd <= result.constraints.budget_usd * 7.8,
      };
      const ids = new Set(result.days.flatMap((day) => day.items.map((item) => item.place_id)));
      result.sources = dataset.places.filter((p) => ids.has(p.id)).map((p) => ({ name: p.name, url: p.source }));
      result.summary = explainPlan(result.days, result.constraints, result.cost, true);
      result.edit_warnings = warnings;
      return result;
    }
    /** Make one credential-scoped, timeout-bounded test call to an explicit BYOK router. */
    async function testConnection(profile) {
      if (!profile?.apiKey || !profile.model || !profile.baseUrl) throw Error('Enter a base URL, model and API key.');
      const url = new URL(profile.baseUrl.replace(/\/+$/, '') + '/chat/completions');
      if (
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        (url.protocol !== 'https:' &&
          !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
      ) {
        throw Error('Use an HTTPS base URL (HTTP is allowed only on loopback).');
      }
      try {
        const response = await json(url.href, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(10000),
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + profile.apiKey },
          body: JSON.stringify({ model: profile.model, messages: [{ role: 'user', content: 'Reply with OK.' }] }),
        });
        if (typeof response.choices?.[0]?.message?.content !== 'string') throw Error('Invalid response');
        return { ok: true };
      } catch {
        throw Error('Connection test failed. Check the URL, model, credential and provider CORS settings.');
      }
    }
    const api = {
      version,
      load,
      run,
      registerAction,
      /** Return a detached copy of the loaded agent definitions. */
      listAgents: () => (network ? clone(network.tools) : []),
      /** List registered action schemas without exposing their handlers. */
      listActions: () =>
        [...actions].map(([name, a]) => ({
          name,
          description: a.description,
          parameters: clone(a.parameters),
          effect: a.effect,
        })),
      /** Return a detached manifest, or null before loading. */
      getManifest: () => (manifest ? clone(manifest) : null),
      loadPeer,
      handleQueryInvocation,
      recalculateItinerary,
      testConnection,
      validate,
      validateNetwork,
      /** EventTarget carrying the same lifecycle events as onEvent callbacks. */
      events,
    };
    return api;
  }
  const api = createRuntime();
  api.createRuntime = createRuntime;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root.window === root) {
    root.WayfinderRuntime = api;
    root.AgenticWeb = api;
    root.addEventListener('message', async (event) => {
      const message = event.data;
      // Default-deny cross-origin invocation; no wildcard result destinations.
      if (
        event.origin !== root.location.origin ||
        !event.source ||
        message?.type !== 'agentic-web:invoke' ||
        typeof message.goal !== 'string'
      )
        return;
      try {
        if (!api.getManifest()) await api.load();
        const result = await api.run(message.goal);
        event.source.postMessage({ type: 'agentic-web:result', id: message.id, result }, event.origin);
      } catch {
        event.source.postMessage(
          { type: 'agentic-web:result', id: message.id, error: 'Invocation failed' },
          event.origin,
        );
      }
    });
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
