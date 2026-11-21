(function () {
  'use strict';
  const runtime = window.WayfinderRuntime;
  const $ = (id) => document.getElementById(id);
  const profileKey = 'wayfinder.byok';
  const labels = {
    wayfinder_planner: 'Planner',
    place_researcher: 'Researcher',
    budget_analyst: 'Budget analyst',
    itinerary_scheduler: 'Scheduler',
  };
  const money = (amount) => Number(amount).toLocaleString('en-US', { maximumFractionDigits: 2 });
  let places = [];
  let result;
  let profile;
  let queue = [];
  let animationTimer;
  let animationDone;
  let busy = false;

  function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  }
  function showError(message) {
    $('error-banner').textContent = message;
    $('error-banner').hidden = !message;
  }
  function updateInferenceBadge() {
    let text = 'Local rule-based planner (no LLM)';
    if (profile?.apiKey) {
      try {
        text = 'LLM: ' + profile.model + ' @ ' + new URL(profile.baseUrl).host;
      } catch {
        /* Invalid profiles stay local. */
      }
    }
    $('inference-badge').textContent = text;
  }
  function resetActivity() {
    clearTimeout(animationTimer);
    queue = [];
    $('trace').replaceChildren();
    $('progress').value = 0;
    for (const lane of $('agent-lanes').children) lane.className = 'agent-lane';
    $('activity-state').textContent = 'Working';
  }
  function renderEvent(event) {
    if (event.type === 'progress') $('progress').value = event.pct;
    const lane = $('lane-' + event.agent);
    if (event.type === 'agent_start' && lane) {
      lane.classList.add('active');
      lane.setAttribute('aria-label', labels[event.agent] + ' active');
    }
    if (event.type === 'agent_end' && lane) {
      lane.classList.remove('active');
      lane.classList.add('done');
      lane.setAttribute('aria-label', labels[event.agent] + ' complete');
    }
    if (!['reasoning', 'tool_call', 'tool_result', 'handoff', 'error', 'run_start', 'run_end'].includes(event.type))
      return;
    const item = node('li');
    const title = node('strong');
    const text = node('p');
    if (event.type === 'reasoning') {
      title.textContent = labels[event.agent] || 'Inference';
      text.textContent = event.text;
    }
    if (event.type === 'handoff') {
      title.textContent = (labels[event.from] || event.from) + ' → ' + (labels[event.to] || event.to);
      text.textContent = event.request;
    }
    if (event.type === 'tool_call' || event.type === 'tool_result') {
      title.textContent = event.tool + (event.type === 'tool_result' ? ' · ' + event.ms + ' ms' : ' · calling');
      const details = node('details');
      details.append(node('summary', event.type === 'tool_call' ? 'Inspect input JSON' : 'Inspect output JSON'));
      details.append(node('pre', JSON.stringify(event.input ?? event.output, null, 2)));
      item.append(details);
    }
    if (event.type === 'error') {
      title.textContent = 'Planning error';
      text.textContent = event.message;
      item.classList.add('danger');
    }
    if (event.type === 'run_start') {
      title.textContent = 'Team started';
      text.textContent = 'Grounded planning in your browser.';
    }
    if (event.type === 'run_end') {
      title.textContent = 'Plan ready';
      text.textContent = 'Visits, opening hours and budget checked.';
    }
    item.prepend(title, text);
    $('trace').append(item);
    $('trace').scrollTop = $('trace').scrollHeight;
  }
  function drainEvents() {
    clearTimeout(animationTimer);
    if ($('skip-animation').checked) {
      while (queue.length) renderEvent(queue.shift());
    } else if (queue.length) renderEvent(queue.shift());
    if (queue.length) animationTimer = setTimeout(drainEvents, 85);
    else {
      animationTimer = null;
      if (animationDone) {
        animationDone();
        animationDone = null;
      }
    }
  }
  function enqueue(event) {
    queue.push(event);
    if (!animationTimer) animationTimer = setTimeout(drainEvents, $('skip-animation').checked ? 0 : 85);
  }
  function finishAnimation() {
    if (!queue.length) return Promise.resolve();
    return new Promise((resolve) => {
      animationDone = resolve;
    });
  }
  function filters() {
    const constraints = {};
    if ($('budget').value !== '') constraints.budget_usd = Number($('budget').value);
    if ($('pace').value) constraints.pace = $('pace').value;
    if ($('area').value) constraints.area = $('area').value;
    const interests = [...document.querySelectorAll('#interest-chips input:checked')].map((input) => input.value);
    if (interests.length) constraints.interests = interests;
    if (interests.includes('family')) constraints.family = true;
    return constraints;
  }
  async function runGoal() {
    if (busy || !$('planner-form').reportValidity()) return;
    busy = true;
    $('run-button').disabled = true;
    $('run-button').textContent = 'Your team is planning…';
    showError('');
    resetActivity();
    try {
      result = await runtime.run($('goal').value.trim(), {
        constraints: filters(),
        inference: profile?.apiKey ? profile : undefined,
        onEvent: enqueue,
      });
      renderResult();
      await finishAnimation();
      $('activity-state').textContent = 'Complete';
      $('result-status').textContent = 'Ready to explore';
    } catch (error) {
      showError(error.message || 'Planning failed. Please try again.');
      await finishAnimation();
      $('activity-state').textContent = 'Stopped';
    } finally {
      busy = false;
      $('run-button').disabled = false;
      $('run-button').replaceChildren(node('span', 'Build my itinerary'), node('span', '↗'));
    }
  }
  function actionButton(text, label, handler, disabled = false) {
    const button = node('button', text);
    button.type = 'button';
    button.setAttribute('aria-label', label);
    button.disabled = disabled;
    button.addEventListener('click', handler);
    return button;
  }
  function edit(change) {
    if (!result) return;
    const draft = structuredClone(result);
    change(draft);
    try {
      result = runtime.recalculateItinerary(draft);
      renderResult();
      $('result-status').textContent = 'Edited by you';
    } catch (error) {
      showError(error.message);
    }
  }
  function renderResult() {
    $('empty-state').hidden = true;
    $('results').hidden = false;
    $('result-title').textContent = 'Hong Kong, your way.';
    const cost = result.cost;
    $('total-hkd').textContent = 'HK$' + money(cost.total_hkd);
    $('total-hkd').dataset.total = cost.total_hkd;
    $('total-usd').textContent = '≈ US$' + money(cost.total_usd) + ' / person';
    $('budget-badge').textContent = cost.within_budget ? 'Within budget' : 'Over budget';
    $('budget-badge').className = 'pill' + (cost.within_budget ? '' : ' over');
    const budgetHkd = cost.budget_usd * 7.8;
    $('budget-progress').value = budgetHkd
      ? Math.min(100, (cost.total_hkd / budgetHkd) * 100)
      : cost.total_hkd
        ? 100
        : 0;
    $('budget-caption').textContent = cost.within_budget
      ? 'Budget: US$' +
        money(cost.budget_usd) +
        ' · HK$' +
        money(Math.max(0, budgetHkd - cost.total_hkd)) +
        ' left to spare.'
      : 'US$' +
        money(cost.total_usd - cost.budget_usd) +
        ' over your budget after edits. Remove paid stops or choose cheaper alternatives.';
    $('cost-breakdown').replaceChildren();
    for (const [category, amount] of Object.entries(cost.breakdown)) {
      const group = node('div');
      group.append(node('dt', category), node('dd', 'HK$' + money(amount)));
      $('cost-breakdown').append(group);
    }
    $('edit-warnings').hidden = !result.edit_warnings?.length;
    $('edit-warnings').textContent = result.edit_warnings?.join(' ') || '';
    $('timeline').replaceChildren();
    for (const [dayIndex, day] of result.days.entries()) {
      const section = node('section', undefined, 'day');
      const heading = node('div', undefined, 'day-heading');
      heading.append(node('h3', 'Day ' + day.day), node('span', day.date + ' · ' + day.items.length + ' stops'));
      section.append(heading);
      if (day.planning_notes) section.append(node('p', day.planning_notes, 'day-rationale'));
      if (!day.items.length)
        section.append(
          node(
            'p',
            'No feasible stops for this day. Try another area, a higher budget or add a place below.',
            'notice',
          ),
        );
      for (const [index, item] of day.items.entries()) {
        if (item.transit_before) {
          const leg = item.transit_before;
          const row = node('div', undefined, 'transit-leg');
          const time = node('div', leg.time_start, 'time-range');
          time.append(node('span', '— ' + leg.time_end));
          const description = node(
            'p',
            leg.mode + ' ~' + leg.minutes + ' min · ' + leg.distance_km + ' km · HK$' + money(leg.cost_hkd),
            'transit-description',
          );
          description.append(
            node('small', leg.declared_transfer ? 'Declared transfer · estimated' : 'Estimated transit'),
          );
          row.setAttribute('aria-label', 'Travel to ' + item.name);
          row.append(time, description);
          section.append(row);
        }
        const row = node('article', undefined, 'timeline-item');
        const time = node('div', item.time_start, 'time-range');
        time.append(node('span', '— ' + item.time_end));
        const card = node('div', undefined, 'stop-card');
        const top = node('div', undefined, 'stop-top');
        top.append(
          node('h4', item.name),
          node('span', item.cost_hkd ? 'HK$' + money(item.cost_hkd) : 'Free', 'stop-price'),
        );
        const meta = node('p', undefined, 'stop-meta');
        meta.append(
          node('span', item.meal_slot || item.category, 'category'),
          document.createTextNode(' · ' + item.district),
        );
        const actions = node('div', undefined, 'stop-actions');
        for (const [direction, symbol] of [
          [-1, '↑'],
          [1, '↓'],
        ]) {
          actions.append(
            actionButton(
              symbol,
              'Move ' + item.name + (direction < 0 ? ' up' : ' down'),
              () =>
                edit((draft) => {
                  const items = draft.days[dayIndex].items;
                  [items[index], items[index + direction]] = [items[index + direction], items[index]];
                }),
              direction < 0 ? index === 0 : index === day.items.length - 1,
            ),
          );
        }
        const remove = actionButton('Remove', 'Remove ' + item.name, () =>
          edit((draft) => draft.days[dayIndex].items.splice(index, 1)),
        );
        remove.className = 'remove';
        actions.append(remove);
        const notes = node('details', undefined, 'stop-notes');
        notes.append(node('summary', 'Visit notes'), node('p', item.notes));
        card.append(top, meta, actions, notes);
        row.append(time, card);
        section.append(row);
      }
      $('timeline').append(section);
    }
    $('add-day').replaceChildren(
      ...result.days.map((day, i) => {
        const option = node('option', 'Day ' + day.day);
        option.value = i;
        return option;
      }),
    );
    $('summary').textContent = result.summary;
    $('sources').replaceChildren(
      ...result.sources.map((source) => {
        const item = node('li'),
          link = node('a', source.name);
        link.href = source.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        item.append(link);
        return item;
      }),
    );
    const districts = new Map();
    result.days
      .flatMap((day) => day.items)
      .forEach((item) => {
        if (!districts.has(item.district)) districts.set(item.district, []);
        districts.get(item.district).push(item.name);
      });
    $('district-list').replaceChildren();
    for (const [district, names] of districts) {
      const group = node('div', undefined, 'district-group');
      const list = node('ol');
      names.forEach((name) => list.append(node('li', name)));
      group.append(node('h4', district), list);
      $('district-list').append(group);
    }
    if (!districts.size) $('district-list').append(node('p', 'No stops on the trail yet.', 'field-hint'));
    renderPlaceOptions();
  }
  function renderPlaceOptions() {
    const term = $('place-search').value.toLowerCase().trim();
    const matches = places.filter((p) => p.name.toLowerCase().includes(term));
    $('place-select').replaceChildren(
      ...matches.map((p) => {
        const option = node('option', p.name + ' · HK$' + money(p.price_hkd));
        option.value = p.id;
        return option;
      }),
    );
    $('add-place-button').disabled = !matches.length;
    $('search-status').textContent = matches.length
      ? matches.length + ' places available. Stops that cannot fit will be explained.'
      : 'No matching places. Try a different name.';
  }
  function exportText() {
    return [
      result.goal,
      '',
      ...result.days.flatMap((day) => [
        'DAY ' + day.day + ' · ' + day.date,
        ...day.items.flatMap((item) => [
          ...(item.transit_before
            ? [
                item.transit_before.time_start +
                  '–' +
                  item.transit_before.time_end +
                  ' ' +
                  item.transit_before.mode +
                  ' ~' +
                  item.transit_before.minutes +
                  ' min · ' +
                  item.transit_before.distance_km +
                  ' km · HK$' +
                  money(item.transit_before.cost_hkd),
              ]
            : []),
          item.time_start +
            '–' +
            item.time_end +
            ' ' +
            item.name +
            ' · ' +
            item.district +
            ' · HK$' +
            money(item.cost_hkd),
        ]),
        '',
      ]),
      'TOTAL HK$' + money(result.cost.total_hkd) + ' / US$' + money(result.cost.total_usd),
      'Budget US$' +
        money(result.cost.budget_usd) +
        ' · ' +
        (result.cost.within_budget ? 'Within budget' : 'Over budget'),
      '',
      result.summary,
      '',
      'SOURCES',
      ...result.sources.map((source) => source.name + ': ' + source.url),
    ].join('\n');
  }
  function download(content, extension, type) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const link = node('a');
    link.href = url;
    link.download = 'wayfinder-itinerary.' + extension;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    $('export-status').textContent = 'Your ' + extension + ' download is ready.';
  }
  function readProfileForm() {
    const value = {
      baseUrl: $('base-url').value.trim().replace(/\/+$/, ''),
      model: $('model').value.trim(),
      apiKey: $('api-key').value.trim(),
    };
    if (!value.apiKey) return null;
    const url = new URL(value.baseUrl);
    if (
      !value.model ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    ) {
      throw Error('Use a model and HTTPS base URL without credentials or query parameters. Loopback HTTP is allowed.');
    }
    return value;
  }
  function consent({ origin, purpose }) {
    $('consent-origin').textContent = origin;
    $('consent-purpose').textContent = purpose;
    const dialog = $('consent-dialog');
    dialog.showModal();
    return new Promise((resolve) => {
      function finish(approved) {
        dialog.close();
        $('consent-allow').onclick = null;
        $('consent-deny').onclick = null;
        dialog.oncancel = null;
        resolve(approved);
      }
      $('consent-allow').onclick = () => finish(true);
      $('consent-deny').onclick = () => finish(false);
      dialog.oncancel = (event) => {
        event.preventDefault();
        finish(false);
      };
    });
  }
  function wireSettings() {
    $('open-settings').onclick = () => {
      $('base-url').value = profile?.baseUrl || '';
      $('model').value = profile?.model || '';
      $('api-key').value = profile?.apiKey || '';
      $('settings-dialog').showModal();
    };
    $('close-settings').onclick = () => {
      $('settings-dialog').close();
      $('api-key').value = '';
    };
    $('settings-dialog').addEventListener('close', () => {
      $('api-key').value = '';
    });
    $('provider').onchange = () => {
      const presets = { openrouter: 'https://openrouter.ai/api/v1', otari: 'https://api.otari.ai/api/v1' };
      $('base-url').value = presets[$('provider').value] || '';
    };
    $('settings-form').onsubmit = (event) => {
      event.preventDefault();
      try {
        const candidate = readProfileForm();
        if (candidate) localStorage.setItem(profileKey, JSON.stringify(candidate));
        else localStorage.removeItem(profileKey);
        profile = candidate;
        updateInferenceBadge();
        $('settings-status').textContent = candidate
          ? 'Profile saved in this browser only.'
          : 'No key stored. Local planner active.';
      } catch {
        $('settings-status').textContent = 'Could not save. Check the model and HTTPS URL, and allow localStorage.';
      }
    };
    $('delete-profile').onclick = () => {
      try {
        localStorage.removeItem(profileKey);
        profile = null;
        $('api-key').value = '';
        updateInferenceBadge();
        $('settings-status').textContent = 'Stored profile deleted. Local planner active.';
      } catch {
        $('settings-status').textContent = 'Browser storage is unavailable.';
      }
    };
    $('test-connection').onclick = async () => {
      $('test-connection').disabled = true;
      $('settings-status').textContent = 'Testing the selected router…';
      try {
        await runtime.testConnection(readProfileForm());
        $('settings-status').textContent = 'Connection succeeded. The selected model returned a response.';
      } catch {
        $('settings-status').textContent = 'Test failed. Check the URL, model, key and provider CORS settings.';
      } finally {
        $('test-connection').disabled = false;
      }
    };
    $('sample-peer').onclick = () => {
      $('peer-url').value = new URL('./peers/hk_weather_tips/hk_weather_tips', location.href).href;
    };
    $('sample-peer').click();
    $('connect-peer').onclick = async () => {
      $('connect-peer').disabled = true;
      $('peer-agents').replaceChildren();
      $('peer-status').textContent = 'Checking policy…';
      try {
        const peer = await runtime.loadPeer($('peer-url').value, { userInitiated: true, consent });
        $('peer-status').textContent = peer.name + ' validated. Sample/discovery only — not executed.';
        peer.agents.forEach((name) => $('peer-agents').append(node('li', name)));
      } catch (error) {
        $('peer-status').textContent = 'Fail closed: ' + error.message;
      } finally {
        $('connect-peer').disabled = false;
      }
    };
  }
  async function initialize() {
    try {
      try {
        profile = JSON.parse(localStorage.getItem(profileKey) || 'null');
      } catch {
        profile = null;
      }
      updateInferenceBadge();
      const [, data] = await Promise.all([
        runtime.load(),
        fetch('./data/places.json').then((response) => {
          if (!response.ok) throw Error('Place catalogue unavailable');
          return response.json();
        }),
      ]);
      places = data.places;
      const query = new URLSearchParams(location.search);
      if (query.has('goal') && query.get('format') === 'json') {
        await runtime.handleQueryInvocation({ inference: profile?.apiKey ? profile : undefined });
        document.body.dataset.ready = 'true';
        return;
      }
      for (const [name, label] of Object.entries(labels)) {
        const lane = node('div', label, 'agent-lane');
        lane.id = 'lane-' + name;
        $('agent-lanes').append(lane);
      }
      const chipLabels = ['2 days of good food', 'A slow family day', 'Culture & skyline views'];
      runtime.getManifest().networks[0].sample_queries.forEach((goal, index) => {
        const button = node('button', chipLabels[index], 'example-chip');
        button.type = 'button';
        button.title = goal;
        button.setAttribute('aria-label', goal);
        button.setAttribute('aria-pressed', 'false');
        button.onclick = () => {
          $('goal').value = goal;
          for (const chip of $('examples').children) chip.setAttribute('aria-pressed', String(chip === button));
          $('goal').focus();
        };
        $('examples').append(button);
      });
      for (const interest of ['food', 'culture', 'nature', 'family', 'views', 'shopping', 'nightlife', 'museum']) {
        const label = node('label'),
          input = node('input');
        input.type = 'checkbox';
        input.value = interest;
        label.append(input, node('span', interest));
        $('interest-chips').append(label);
      }
      $('planner-form').onsubmit = (event) => {
        event.preventDefault();
        runGoal();
      };
      $('skip-animation').checked = matchMedia('(prefers-reduced-motion: reduce)').matches;
      $('skip-animation').onchange = () => {
        if ($('skip-animation').checked) drainEvents();
      };
      $('place-search').oninput = renderPlaceOptions;
      $('add-place-button').onclick = () =>
        edit((draft) => {
          const id = $('place-select').value;
          if (!id) return;
          draft.days[Number($('add-day').value)].items.push({ place_id: id });
        });
      $('copy-text').onclick = async () => {
        try {
          await navigator.clipboard.writeText(exportText());
          $('export-status').textContent = 'Copied your itinerary.';
        } catch {
          $('copy-fallback').value = exportText();
          $('copy-dialog').showModal();
          $('copy-fallback').select();
        }
      };
      $('close-copy').onclick = () => $('copy-dialog').close();
      $('download-text').onclick = () => download(exportText(), 'txt', 'text/plain');
      $('download-json').onclick = () => download(JSON.stringify(result, null, 2), 'json', 'application/json');
      wireSettings();
      $('run-button').disabled = false;
      document.body.dataset.ready = 'true';
      if (query.has('goal')) {
        $('goal').value = query.get('goal');
        await runGoal();
      }
    } catch (error) {
      if (new URLSearchParams(location.search).get('format') === 'json') {
        const pre = node('pre', JSON.stringify({ error: 'Runtime initialization or planning failed.' }));
        pre.id = 'agentic-web-result';
        document.body.replaceChildren(pre);
        document.title = 'Wayfinder — JSON error';
      } else showError('Runtime validation or loading failed: ' + error.message);
    }
  }
  initialize();
})();
