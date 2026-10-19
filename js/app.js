// App shell: builds the step panel, runs the generation pipeline, draws the map.
(function () {
  'use strict';

  const MAP_W = 2000, MAP_H = 2000;

  // Ordered generation pipeline. Each step:
  //   id, title, settings[]                       — UI description
  //   run(state, settings, rng, ctx) -> string?   — mutates shared state, returns info text
  //   draw(g, state, ctx)                         — renders its layer in map coordinates
  //   defaultVisible (optional, default true)     — whether its layer is drawn initially
  //   zIndex (optional, default: step position)   — drawing order of its layer
  const STEPS = [
    window.PointsStep,
    window.VoronoiStep,
    window.AltitudeStep,
    window.SeaStep,
    window.SeaCleanupStep,
    window.ShortEdgesStep,
    window.RiversStep,
    window.CoastStep
  ];

  const els = {
    panel: document.getElementById('panel'),
    toggle: document.getElementById('panel-toggle'),
    seed: document.getElementById('seed'),
    seedRandom: document.getElementById('seed-random'),
    save: document.getElementById('settings-save'),
    load: document.getElementById('settings-load'),
    reset: document.getElementById('settings-reset'),
    configMsg: document.getElementById('config-msg'),
    steps: document.getElementById('steps'),
    status: document.getElementById('status'),
    stage: document.getElementById('stage'),
    canvas: document.getElementById('map')
  };

  // ---------- Config (seed + per-step settings), persisted in the URL hash ----------

  const config = { seed: '', steps: {}, visible: {} };

  /** Reset every step setting and layer visibility to its default (the seed is kept). */
  function resetToDefaults() {
    for (const step of STEPS) {
      config.visible[step.id] = step.defaultVisible !== false;
      config.steps[step.id] = {};
      for (const s of step.settings) config.steps[step.id][s.key] = s.default;
    }
  }
  resetToDefaults();

  /** Copy known values from a saved config object; unknown or missing keys are ignored. */
  function applyConfig(saved) {
    if (typeof saved.seed === 'string') config.seed = saved.seed;
    for (const step of STEPS) {
      const src = saved.steps && saved.steps[step.id];
      if (saved.visible && typeof saved.visible[step.id] === 'boolean') {
        config.visible[step.id] = saved.visible[step.id];
      }
      if (!src) continue;
      for (const s of step.settings) {
        if (src[s.key] === undefined) continue;
        if (s.type === 'toggles' && !Array.isArray(src[s.key])) continue;
        config.steps[step.id][s.key] = src[s.key];
      }
    }
  }

  function loadFromHash() {
    if (!location.hash) return false;
    try {
      applyConfig(JSON.parse(decodeURIComponent(location.hash.slice(1))));
      return !!config.seed;
    } catch (e) {
      return false;
    }
  }

  // ---------- Saved settings (one slot in this browser's local storage) ----------

  const STORAGE_KEY = 'vibecity.savedSettings';

  function readSaved() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  let msgTimer = 0;
  function showMessage(text) {
    els.configMsg.textContent = text;
    clearTimeout(msgTimer);
    msgTimer = setTimeout(() => { els.configMsg.textContent = ''; }, 3000);
  }

  function refreshLoadButton() {
    const saved = readSaved();
    els.load.disabled = !saved;
    els.load.title = saved ? 'Load saved settings (seed "' + saved.seed + '")' : 'No saved settings yet';
  }

  /** Rebuild the panel from `config`, keeping which steps are collapsed, then regenerate. */
  function configReplaced() {
    const closed = Array.from(els.steps.children).map((li) => li.classList.contains('closed'));
    els.seed.value = config.seed;
    buildPanel();
    Array.from(els.steps.children).forEach((li, i) => li.classList.toggle('closed', !!closed[i]));
    changed();
  }

  els.save.addEventListener('click', () => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
      showMessage('Settings saved (seed "' + config.seed + '")');
    } catch (e) {
      showMessage('This browser refused to save settings');
    }
    refreshLoadButton();
  });

  els.load.addEventListener('click', () => {
    const saved = readSaved();
    if (!saved) { showMessage('No saved settings yet'); return; }
    resetToDefaults();
    applyConfig(saved);
    configReplaced();
    showMessage('Saved settings loaded');
  });

  els.reset.addEventListener('click', () => {
    resetToDefaults();
    configReplaced();
    showMessage('Settings reset to defaults (seed kept)');
  });

  function saveToHash() {
    try {
      history.replaceState(null, '', '#' + encodeURIComponent(JSON.stringify(config)));
    } catch (e) {
      // Sandboxed frames may refuse URL changes; sharing by URL is then unavailable.
    }
  }

  // ---------- Panel UI ----------

  const infoEls = {};

  function buildSetting(step, s) {
    const wrap = document.createElement('div');
    wrap.className = 'setting';
    const id = 'set-' + step.id + '-' + s.key;
    const label = document.createElement('label');
    label.htmlFor = id;
    label.textContent = s.label;
    wrap.appendChild(label);

    const values = config.steps[step.id];
    let input;

    if (s.type === 'select') {
      input = document.createElement('select');
      for (const o of s.options) {
        const opt = document.createElement('option');
        opt.value = o.value;
        opt.textContent = o.label;
        input.appendChild(opt);
      }
      input.value = values[s.key];
      input.addEventListener('change', () => { values[s.key] = input.value; changed(); });
    } else if (s.type === 'toggles') {
      // Several on/off options; the value is the array of the selected option values.
      input = document.createElement('div');
      input.className = 'toggles';
      for (const o of s.options) {
        const item = document.createElement('label');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.id = id + '-' + o.value;
        box.checked = values[s.key].indexOf(o.value) >= 0;
        box.addEventListener('change', () => {
          values[s.key] = s.options
            .map((x) => x.value)
            .filter((v) => (v === o.value ? box.checked : values[s.key].indexOf(v) >= 0));
          changed();
        });
        item.appendChild(box);
        item.appendChild(document.createTextNode(o.label));
        if (o.title) item.title = o.title;
        input.appendChild(item);
      }
      label.htmlFor = id + '-' + s.options[0].value;
    } else if (s.type === 'range') {
      const out = document.createElement('output');
      out.textContent = values[s.key];
      label.appendChild(out);
      input = document.createElement('input');
      input.type = 'range';
      input.min = s.min; input.max = s.max; input.step = s.step || 1;
      input.value = values[s.key];
      input.addEventListener('input', () => {
        values[s.key] = Number(input.value);
        out.textContent = input.value;
        changed();
      });
    } else {
      input = document.createElement('input');
      input.type = 'number';
      if (s.min !== undefined) input.min = s.min;
      if (s.max !== undefined) input.max = s.max;
      if (s.step !== undefined) input.step = s.step;
      input.value = values[s.key];
      input.addEventListener('change', () => { values[s.key] = Number(input.value); changed(); });
    }
    if (!input.id) input.id = id;
    wrap.appendChild(input);
    return wrap;
  }

  function buildPanel() {
    els.steps.innerHTML = '';
    STEPS.forEach((step, i) => {
      const li = document.createElement('li');
      li.className = 'step';

      const head = document.createElement('div');
      head.className = 'step-head';
      head.innerHTML =
        '<span class="step-num">' + (i + 1) + '</span>' +
        '<span class="step-title"></span>' +
        '<input class="step-visible" type="checkbox" title="Show layer">' +
        '<span class="step-caret">&#9662;</span>';
      head.querySelector('.step-title').textContent = step.title;
      const vis = head.querySelector('.step-visible');
      vis.checked = config.visible[step.id];
      vis.addEventListener('click', (e) => e.stopPropagation());
      vis.addEventListener('change', () => {
        config.visible[step.id] = vis.checked;
        saveToHash();
        draw();
      });
      head.addEventListener('click', () => li.classList.toggle('closed'));
      li.appendChild(head);

      const body = document.createElement('div');
      body.className = 'step-settings';
      for (const s of step.settings) body.appendChild(buildSetting(step, s));
      const info = document.createElement('div');
      info.className = 'step-info';
      body.appendChild(info);
      infoEls[step.id] = info;
      li.appendChild(body);

      els.steps.appendChild(li);
    });
  }

  els.toggle.addEventListener('click', () => {
    const collapsed = els.panel.classList.toggle('collapsed');
    els.toggle.innerHTML = collapsed ? '&raquo;' : '&laquo;';
    els.toggle.title = collapsed ? 'Expand panel' : 'Collapse panel';
    // The stage size changes once the transition ends.
    setTimeout(resize, 220);
  });

  els.seed.addEventListener('input', () => { config.seed = els.seed.value; changed(); });
  els.seedRandom.addEventListener('click', () => {
    config.seed = randomSeed();
    els.seed.value = config.seed;
    changed();
  });

  // ---------- Generation ----------

  let state = null;
  const ctx = { width: MAP_W, height: MAP_H };

  function generate() {
    const t0 = performance.now();
    state = {};
    for (const step of STEPS) {
      // Each step gets its own generator derived from the seed and its id,
      // so tweaking one step never reshuffles the randomness of another.
      const rng = new Rng(config.seed + '|' + step.id);
      const info = step.run(state, config.steps[step.id], rng, ctx);
      infoEls[step.id].textContent = info || '';
    }
    els.status.textContent = 'Generated in ' + Math.round(performance.now() - t0) + ' ms';
  }

  let pending = false;
  function changed() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      saveToHash();
      generate();
      draw();
    });
  }

  // ---------- Rendering ----------

  function resize() {
    const r = els.stage.getBoundingClientRect();
    const pad = 24;
    const size = Math.max(50, Math.floor(Math.min(r.width - pad, r.height - pad)));
    const dpr = window.devicePixelRatio || 1;
    els.canvas.style.width = size + 'px';
    els.canvas.style.height = size + 'px';
    els.canvas.width = Math.round(size * dpr);
    els.canvas.height = Math.round(size * dpr);
    draw();
  }

  function draw() {
    if (!state) return;
    const g = els.canvas.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, els.canvas.width, els.canvas.height);
    g.setTransform(els.canvas.width / MAP_W, 0, 0, els.canvas.height / MAP_H, 0, 0);
    g.fillStyle = '#efe4c8';
    g.fillRect(0, 0, MAP_W, MAP_H);
    const layers = STEPS
      .map((step, i) => ({ step: step, z: step.zIndex !== undefined ? step.zIndex : i }))
      .sort((a, b) => a.z - b.z);
    for (const l of layers) {
      if (config.visible[l.step.id]) l.step.draw(g, state, ctx);
    }
  }

  window.addEventListener('resize', resize);

  // ---------- Boot ----------

  if (!loadFromHash()) config.seed = randomSeed();
  els.seed.value = config.seed;
  buildPanel();
  refreshLoadButton();
  saveToHash();
  generate();
  resize();
})();
