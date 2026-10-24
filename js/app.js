// App shell: builds the step panel, runs the generation pipeline, draws the map.
(function () {
  'use strict';

  const MAP_W = 2000, MAP_H = 2000;

  // Ordered generation pipeline. Each step:
  //   id, title, settings[]                       — UI description
  //   run(state, settings, rng, ctx) -> string?   — mutates shared state, returns info text
  //   draw(g, state, ctx)                         — renders its layer in map coordinates
  //       (ctx.scale: CSS px per map unit, ctx.px: map units per CSS px, ctx.visible, ctx.settings: its own)
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
    window.CoastStep,
    window.RiverCellsStep,
    window.ReliefStep,
    window.FieldsStep,
    window.View3DStep,
    window.TerrainStep,
    window.SiteStep,
    window.WallsStep,
    window.RoadsStep,
    window.BlocksStep,
    window.LotsStep,
    window.BuildingsStep,
    window.MonumentsStep,
    window.FaubourgsStep
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
    canvas: document.getElementById('map'),
    canvas3d: document.getElementById('map3d')
  };

  // ---------- Config (seed + per-step settings), persisted in the URL hash ----------

  const config = { seed: '', steps: {}, visible: {} };

  /** Reset every step setting and layer visibility to its default (the seed is kept). */
  function resetToDefaults() {
    for (const step of STEPS) {
      config.visible[step.id] = step.defaultVisible !== false;
      config.steps[step.id] = {};
      // Copied, so that editing an array value never changes the default.
      for (const s of step.settings) config.steps[step.id][s.key] = JSON.parse(JSON.stringify(s.default));
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
        if (s.type === 'curve' && !(window.validCurve(src[s.key]) && src[s.key].length === s.default.length)) continue;
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
    } else if (s.type === 'curve') {
      input = buildCurveEditor(s, values, id);
      label.htmlFor = id + '-canvas';
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

  /**
   * Editor for a strictly increasing curve from (0, 0) to (1, 1): the value is
   * the list of intermediate points [[x, y], …] (a fixed number of them). Drag
   * a point to move it (kept strictly between its neighbours in x and y); the
   * map is regenerated on release.
   */
  function buildCurveEditor(s, values, id) {
    const W = 252, H = 168, PAD = 10;
    const wrap = document.createElement('div');
    wrap.className = 'curve-editor';
    const cv = document.createElement('canvas');
    cv.id = id + '-canvas';
    const dpr = window.devicePixelRatio || 1;
    cv.width = W * dpr; cv.height = H * dpr;
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
    cv.title = 'Drag a point to move it';
    wrap.appendChild(cv);
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.textContent = 'Reset curve';
    wrap.appendChild(reset);

    const toPx = (p) => ({ x: PAD + p[0] * (W - 2 * PAD), y: H - PAD - p[1] * (H - 2 * PAD) });
    const fromEvent = (e) => {
      const r = cv.getBoundingClientRect();
      return [((e.clientX - r.left) * (W / r.width) - PAD) / (W - 2 * PAD), (H - PAD - (e.clientY - r.top) * (H / r.height)) / (H - 2 * PAD)];
    };
    const pts = () => values[s.key];
    const MIN_GAP = 0.01;

    function paint() {
      const g = cv.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.fillStyle = '#fffdf7';
      g.fillRect(0, 0, W, H);
      g.strokeStyle = '#e6d9bb';
      g.lineWidth = 1;
      for (let k = 0; k <= 4; k++) {
        const a = toPx([k / 4, 0]), b = toPx([k / 4, 1]), c = toPx([0, k / 4]), d = toPx([1, k / 4]);
        g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.moveTo(c.x, c.y); g.lineTo(d.x, d.y); g.stroke();
      }
      const f = window.curveFunction(pts());
      g.strokeStyle = '#8b3a1e';
      g.lineWidth = 2;
      g.beginPath();
      for (let k = 0; k <= 100; k++) {
        const p = toPx([k / 100, f(k / 100)]);
        if (k) g.lineTo(p.x, p.y); else g.moveTo(p.x, p.y);
      }
      g.stroke();
      [[0, 0]].concat(pts(), [[1, 1]]).forEach((q, i, all) => {
        const p = toPx(q), fixed = i === 0 || i === all.length - 1;
        g.fillStyle = fixed ? '#b9a98a' : '#8b3a1e';
        g.beginPath(); g.arc(p.x, p.y, fixed ? 3.5 : 5, 0, Math.PI * 2); g.fill();
      });
    }

    const hit = (e) => {
      const r = cv.getBoundingClientRect(), sx = W / r.width;
      const x = (e.clientX - r.left) * sx, y = (e.clientY - r.top) * sx;
      let best = -1, bd = 9;
      pts().forEach((q, i) => {
        const p = toPx(q), d = Math.hypot(p.x - x, p.y - y);
        if (d < bd) { bd = d; best = i; }
      });
      return best;
    };

    let drag = -1;
    cv.addEventListener('pointerdown', (e) => {
      drag = hit(e);
      if (drag >= 0) { cv.setPointerCapture(e.pointerId); e.preventDefault(); }
    });
    cv.addEventListener('pointermove', (e) => {
      if (drag < 0) return;
      const P = pts(), [x, y] = fromEvent(e);
      const lo = drag ? P[drag - 1] : [0, 0], hi = drag + 1 < P.length ? P[drag + 1] : [1, 1];
      P[drag] = [
        Math.round(Math.min(hi[0] - MIN_GAP, Math.max(lo[0] + MIN_GAP, x)) * 1000) / 1000,
        Math.round(Math.min(hi[1] - MIN_GAP, Math.max(lo[1] + MIN_GAP, y)) * 1000) / 1000
      ];
      paint();
    });
    const release = () => { if (drag >= 0) { drag = -1; changed(); } };
    cv.addEventListener('pointerup', release);
    cv.addEventListener('pointercancel', release);
    reset.addEventListener('click', () => {
      values[s.key] = JSON.parse(JSON.stringify(s.default));
      paint();
      changed();
    });
    paint();
    return wrap;
  }

  function buildPanel() {
    els.steps.innerHTML = '';
    STEPS.forEach((step, i) => {
      const li = document.createElement('li');
      li.className = 'step closed';  // collapsed by default; click the header to open

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

  // Cache of the upstream steps: after every step from the first cached one on,
  // a shallow snapshot of the state. When a setting changes, generation resumes
  // from the snapshot taken before the first step whose settings (or the seed)
  // changed. This relies on a rule for the steps from the first cached one on:
  // they add keys to the state (and may fill state.fields with fields that
  // depend only on earlier steps) but never alter what earlier steps built.
  // The terrain steps 1–10 do alter cells and nodes in place, so a change
  // there regenerates everything.
  const FIRST_CACHED = STEPS.indexOf(window.ReliefStep);
  const snapshots = [];   // snapshots[i]: the state right after step i
  const ranWith = [];     // ranWith[i]: seed + settings JSON that step i last ran with
  let stepTimes = [];

  function generate() {
    const t0 = performance.now();
    const keys = STEPS.map((step) => config.seed + '|' + JSON.stringify(config.steps[step.id]));
    let first = 0;
    while (first < STEPS.length && ranWith[first] === keys[first] && (first < FIRST_CACHED || snapshots[first])) first++;
    if (first >= STEPS.length) return;  // nothing changed
    // Resume from the snapshot before the first changed step, when there is one.
    let from = first > FIRST_CACHED && snapshots[first - 1] ? first : 0;
    if (from === 0) state = {};
    else state = Object.assign({}, snapshots[from - 1]);
    for (let i = from; i < STEPS.length; i++) {
      const step = STEPS[i];
      // Each step gets its own generator derived from the seed and its id,
      // so tweaking one step never reshuffles the randomness of another.
      const rng = new Rng(config.seed + '|' + step.id);
      const t1 = performance.now();
      const info = step.run(state, config.steps[step.id], rng, ctx);
      stepTimes[i] = performance.now() - t1;
      infoEls[step.id].textContent = info || '';
      ranWith[i] = keys[i];
      snapshots[i] = i >= FIRST_CACHED ? Object.assign({}, state) : null;
    }
    const total = Math.round(performance.now() - t0);
    els.status.textContent = 'Generated in ' + total + ' ms' + (from > 0 ? ' (from step ' + (from + 1) + ', the earlier ones cached)' : '');
    els.status.title = STEPS.map((step, i) => (i + 1) + '. ' + step.title + ': ' + Math.round(stepTimes[i] || 0) + ' ms').join('\n');
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

  // View of the 2D map on the canvas: `scale` CSS px per map unit, (`x`, `y`)
  // CSS px position of the map's origin on the canvas. The map is fitted to
  // the stage at first; the wheel (or a pinch) zooms about the pointer, a drag
  // pans, a double-click (or double-tap) fits the map again.
  const view = { scale: 1, x: 0, y: 0, fit: 1, fitted: true };
  const VIEW_PAD = 12;       // CSS px kept around the map when fitted
  const MAX_SCALE = 64;      // CSS px per map unit at the largest zoom
  let stageW = 0, stageH = 0;  // canvas size in CSS px

  /** Scale at which the whole map fits in the stage with its padding. */
  function fitScale() {
    return Math.max(1e-6, Math.min((stageW - 2 * VIEW_PAD) / MAP_W, (stageH - 2 * VIEW_PAD) / MAP_H));
  }

  /** Center the map on an axis when it is smaller than the stage, else keep the stage inside it. */
  function clampAxis(pos, mapPx, stagePx) {
    if (mapPx <= stagePx - 2 * VIEW_PAD) return (stagePx - mapPx) / 2;
    return Math.min(VIEW_PAD, Math.max(stagePx - VIEW_PAD - mapPx, pos));
  }

  function clampView() {
    view.fit = fitScale();
    view.scale = Math.min(MAX_SCALE, Math.max(view.fit, view.scale));
    view.x = clampAxis(view.x, MAP_W * view.scale, stageW);
    view.y = clampAxis(view.y, MAP_H * view.scale, stageH);
    view.fitted = view.scale <= view.fit * 1.0001;
  }

  function fitView() {
    view.scale = fitScale();
    view.x = view.y = 0;
    clampView();
  }

  /** Zoom by `factor` keeping the map point under the stage point (cx, cy) in place. */
  function zoomAt(cx, cy, factor) {
    const s0 = view.scale;
    view.scale = Math.min(MAX_SCALE, Math.max(fitScale(), s0 * factor));
    const k = view.scale / s0;
    view.x = cx - (cx - view.x) * k;
    view.y = cy - (cy - view.y) * k;
    clampView();
  }

  /** Stage point (CSS px, relative to the canvas) of a pointer event. */
  function stagePoint(e) {
    const r = els.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  let drawPending = false;
  function requestDraw() {
    if (drawPending) return;
    drawPending = true;
    requestAnimationFrame(() => { drawPending = false; draw(); });
  }

  els.canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    // Lines (Firefox with a mouse wheel) count for about 16 px each.
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    const p = stagePoint(e);
    zoomAt(p.x, p.y, Math.exp(-dy * 0.0015));
    requestDraw();
  }, { passive: false });

  // Drag to pan; two pointers pinch to zoom (and pan with their midpoint).
  const pointers = new Map();
  let pinch = null;  // { dist, mid } of the previous pinch frame
  els.canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    els.canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, stagePoint(e));
    pinch = null;
    els.canvas.classList.add('dragging');
  });
  els.canvas.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    const p = stagePoint(e);
    if (pointers.size === 1) {
      const q = pointers.get(e.pointerId);
      view.x += p.x - q.x;
      view.y += p.y - q.y;
      clampView();
    } else {
      pointers.set(e.pointerId, p);
      const [a, b] = Array.from(pointers.values());
      const cur = { dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
      if (pinch) {
        view.x += cur.mid.x - pinch.mid.x;
        view.y += cur.mid.y - pinch.mid.y;
        zoomAt(cur.mid.x, cur.mid.y, cur.dist / pinch.dist);
      }
      pinch = cur;
    }
    pointers.set(e.pointerId, p);
    requestDraw();
  });
  const endPointer = (e) => {
    pointers.delete(e.pointerId);
    pinch = null;
    if (!pointers.size) els.canvas.classList.remove('dragging');
  };
  els.canvas.addEventListener('pointerup', endPointer);
  els.canvas.addEventListener('pointercancel', endPointer);
  els.canvas.addEventListener('dblclick', (e) => {
    e.preventDefault();
    fitView();
    requestDraw();
  });

  function resize() {
    const r = els.stage.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    // Keep the map point at the center of the stage where it is, unless the map was fitted.
    const cx = (stageW / 2 - view.x) / view.scale, cy = (stageH / 2 - view.y) / view.scale;
    const wasFitted = view.fitted;
    stageW = Math.max(50, Math.floor(r.width));
    stageH = Math.max(50, Math.floor(r.height));
    els.canvas.style.width = stageW + 'px';
    els.canvas.style.height = stageH + 'px';
    els.canvas.width = Math.round(stageW * dpr);
    els.canvas.height = Math.round(stageH * dpr);
    if (wasFitted) {
      fitView();
    } else {
      view.x = stageW / 2 - cx * view.scale;
      view.y = stageH / 2 - cy * view.scale;
      clampView();
    }
    draw();
  }

  function draw() {
    if (!state) return;
    // A step with `view3d` replaces the 2D map while its layer is shown.
    const v3 = STEPS.find((st) => st.view3d && config.visible[st.id]);
    els.canvas.style.display = v3 ? 'none' : '';
    els.canvas3d.style.display = v3 ? '' : 'none';
    if (v3) {
      const err = window.View3D.show(els.canvas3d, state, config.steps[v3.id]);
      if (err) infoEls[v3.id].textContent = err;
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    const g = els.canvas.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, els.canvas.width, els.canvas.height);
    g.setTransform(view.scale * dpr, 0, 0, view.scale * dpr, view.x * dpr, view.y * dpr);
    g.save();
    g.shadowColor = 'rgba(0,0,0,.45)';
    g.shadowBlur = 24 / view.scale;
    g.shadowOffsetY = 4 / view.scale;
    g.fillStyle = '#efe4c8';
    g.fillRect(0, 0, MAP_W, MAP_H);
    g.restore();
    // Layers only draw inside the map, as they did when the canvas was the map.
    g.save();
    g.beginPath();
    g.rect(0, 0, MAP_W, MAP_H);
    g.clip();
    const layers = STEPS
      .map((step, i) => ({ step: step, z: step.zIndex !== undefined ? step.zIndex : i }))
      .sort((a, b) => a.z - b.z);
    ctx.visible = config.visible;
    ctx.scale = view.scale;      // CSS px per map unit (for level of detail)
    ctx.px = 1 / view.scale;     // map units per CSS px (for hairlines)
    for (const l of layers) {
      ctx.settings = config.steps[l.step.id];  // the step's own settings, for its layer
      if (config.visible[l.step.id]) l.step.draw(g, state, ctx);
    }
    g.restore();
    drawScaleBar(g, dpr);
  }

  /** Scale bar at the bottom right of the stage: a round number of metres, 80–200 px long. */
  function drawScaleBar(g, dpr) {
    const metresPerPx = Units.METRES_PER_UNIT / view.scale;
    let m = Math.pow(10, Math.floor(Math.log10(150 * metresPerPx)));
    for (const f of [5, 2, 1]) if (f * m * 0.98 <= 200 * metresPerPx) { m *= f; break; }
    const len = m / metresPerPx;
    const x1 = stageW - 16, x0 = x1 - len, y = stageH - 18;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.font = '12px Georgia, serif';
    g.textAlign = 'right';
    g.textBaseline = 'bottom';
    const label = m >= 1000 ? (m / 1000) + ' km' : m + ' m';
    const tw = g.measureText(label).width;
    g.fillStyle = 'rgba(243, 234, 216, .85)';
    g.fillRect(x0 - 8, y - 22, len + 16 + Math.max(0, tw - len), 30);
    g.fillStyle = '#3a2e22';
    g.fillText(label, x1, y - 4);
    g.fillRect(x0, y, len, 3);
    g.fillRect(x0, y - 4, 1, 7);
    g.fillRect(x1 - 1, y - 4, 1, 7);
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
