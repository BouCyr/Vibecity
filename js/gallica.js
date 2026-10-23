// Gallica (BnF) browser: keyword search (SRU), document manifest and page images (IIIF),
// full-resolution download by stitching IIIF tiles into a canvas.
// Views are driven by the URL hash: #q=…&type=…&max=…&start=… (search), #ark=… (document), #ark=…&f=… (page).
(function () {
  'use strict';

  const GALLICA = 'https://gallica.bnf.fr';
  const IIIF = GALLICA + '/iiif';
  const SRU = GALLICA + '/SRU';
  const DELAY = 250;              // ms between two API or tile requests (stay polite with the BnF)
  const MAX_PIXELS = 100e6;       // canvas area browsers reliably handle
  const MAX_SIDE = 16000;         // canvas side browsers reliably handle
  const TILE_WORKERS = 3;

  const els = {
    form: document.getElementById('search-form'),
    q: document.getElementById('q'),
    type: document.getElementById('type'),
    max: document.getElementById('max'),
    proxy: document.getElementById('proxy'),
    view: document.getElementById('view'),
    status: document.getElementById('status')
  };

  // ---------- Small helpers ----------

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Build an element: h('a', {href: '#'}, 'text', child…). Text is always set as text, never as HTML. */
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k in el && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v);
    }
    for (const c of children.flat(Infinity)) {
      if (c == null || c === false) continue;
      el.append(c instanceof Node ? c : String(c));
    }
    return el;
  }

  /** Gallica manifest values may contain HTML (links): keep the text only. */
  function plainText(v) {
    if (v == null) return '';
    if (Array.isArray(v)) return v.map(plainText).join(' / ');
    if (typeof v === 'object') {
      if ('@value' in v) return plainText(v['@value']);
      return Object.values(v).map(plainText).join(' ');   // Presentation 3.0 language map
    }
    return new DOMParser().parseFromString(String(v), 'text/html').body.textContent.trim();
  }

  function hashParams() { return new URLSearchParams(location.hash.slice(1)); }
  function hashFor(params) { return '#' + new URLSearchParams(params).toString(); }

  function setStatus(text) { els.status.textContent = text || ''; }

  function errorBox(err) {
    return h('div', { class: 'error' }, err.message || String(err));
  }

  // ---------- Settings (CORS proxy), kept in localStorage when available ----------

  try { els.proxy.value = localStorage.getItem('gallica.proxy') || ''; } catch (e) { /* storage blocked */ }
  els.proxy.addEventListener('change', () => {
    try { localStorage.setItem('gallica.proxy', els.proxy.value.trim()); } catch (e) { /* storage blocked */ }
  });

  function proxied(url) {
    const p = els.proxy.value.trim();
    if (!p) return null;
    return p.includes('{url}') ? p.replace('{url}', encodeURIComponent(url)) : p + url;
  }

  // ---------- HTTP: throttled, retried, with CORS-proxy fallback ----------

  let nextSlot = 0;
  /** Resolve when this request may start: requests are spaced by DELAY ms. */
  function throttle() {
    const now = Date.now();
    const at = Math.max(now, nextSlot);
    nextSlot = at + DELAY;
    return sleep(at - now);
  }

  const viaProxy = new Set();   // hosts/paths ('sru', 'iiif') that failed directly and work via the proxy

  async function fetchText(url, kind) {
    for (let attempt = 0; ; attempt++) {
      await throttle();
      let res;
      const useProxy = viaProxy.has(kind) && proxied(url);
      try {
        res = await fetch(useProxy || url);
      } catch (e) {
        // A network error here is most often a CORS refusal.
        if (!useProxy && proxied(url)) { viaProxy.add(kind); attempt--; continue; }
        throw new Error(proxied(url)
          ? 'Échec de la requête, même via le proxy : ' + url
          : 'Le navigateur n\'a pas pu joindre Gallica (réseau coupé, ou appel refusé par Gallica pour une page '
            + 'hébergée ailleurs — CORS). Renseignez un proxy CORS dans « Réglages ». Requête : ' + url);
      }
      if (res.ok) return res.text();
      if ([429, 500, 502, 503, 504].includes(res.status) && attempt < 3) {
        const retryAfter = parseInt(res.headers.get('Retry-After'), 10);
        const pause = (retryAfter > 0 ? retryAfter : 2 ** (attempt + 1)) * 1000;
        setStatus('Gallica occupé (HTTP ' + res.status + '), nouvel essai dans ' + pause / 1000 + ' s…');
        await sleep(pause);
        continue;
      }
      throw new Error('Gallica a répondu HTTP ' + res.status + ' : ' + url);
    }
  }

  async function fetchJson(url, kind) {
    const text = await fetchText(url, kind);
    try { return JSON.parse(text); } catch (e) { throw new Error('Réponse JSON invalide : ' + url); }
  }

  // ---------- Gallica APIs ----------

  const docUrl = (ark) => IIIF + '/ark:/12148/' + ark;
  const pageUrl = (ark, f) => docUrl(ark) + '/f' + f;
  const imageUrl = (ark, f, region, size, quality) =>
    pageUrl(ark, f) + '/' + region + '/' + size + '/0/' + quality + '.jpg';
  // Gallica implements Image API 1.1, whose quality is "native"; used until info.json says otherwise.
  const thumbUrl = (ark, f, size) => imageUrl(ark, f, 'full', size, 'native');

  async function search(words, type, max, start) {
    let query = 'gallica all "' + words.replace(/"/g, '') + '"';
    if (type) query += ' and dc.type all "' + type.replace(/"/g, '') + '"';
    const url = SRU + '?' + new URLSearchParams({
      operation: 'searchRetrieve', version: '1.2', query,
      startRecord: start, maximumRecords: max
    });
    const xml = new DOMParser().parseFromString(await fetchText(url, 'sru'), 'application/xml');
    if (xml.getElementsByTagName('parsererror').length) throw new Error('Réponse de recherche illisible.');
    const first = (root, name) => {
      const el = root.getElementsByTagNameNS('*', name)[0];
      return el ? el.textContent.trim() : '';
    };
    const all = (root, name) => Array.from(root.getElementsByTagNameNS('*', name))
      .map((e) => e.textContent.trim()).filter(Boolean);
    const diag = first(xml, 'message');
    if (diag && !xml.getElementsByTagNameNS('*', 'recordData').length) throw new Error('Gallica : ' + diag);
    const results = [];
    for (const rec of xml.getElementsByTagNameNS('*', 'recordData')) {
      const ark = all(rec, 'identifier').map((i) => (i.match(/ark:\/12148\/([A-Za-z0-9]+)/) || [])[1]).find(Boolean);
      if (!ark) continue;
      results.push({
        ark,
        title: all(rec, 'title').join(' '),
        date: all(rec, 'date').join(', '),
        creator: all(rec, 'creator').join(' ; '),
        type: [...new Set(all(rec, 'type'))].join(', ')
      });
    }
    return { total: parseInt(first(xml, 'numberOfRecords'), 10) || 0, results };
  }

  const manifests = new Map();
  function getManifest(ark) {
    if (!manifests.has(ark)) {
      const p = fetchJson(docUrl(ark) + '/manifest.json', 'iiif');
      p.catch(() => manifests.delete(ark));
      manifests.set(ark, p);
    }
    return manifests.get(ark);
  }

  /** [{label, width, height}] from a Presentation 2.0 (sequences) or 3.0 (items) manifest. */
  function canvases(manifest) {
    const list = (manifest.sequences && manifest.sequences[0] && manifest.sequences[0].canvases) || manifest.items || [];
    return list.map((c) => ({ label: plainText(c.label), width: c.width, height: c.height }));
  }

  const getInfo = (ark, f) => fetchJson(pageUrl(ark, f) + '/info.json', 'iiif');

  function apiVersion(info) {
    const ctx = [].concat(info['@context'] || []).join(' ');
    const m = ctx.match(/\/image\/(\d)/);
    if (m) return +m[1];
    return 'tile_width' in info ? 1 : 2;
  }

  const qualityOf = (info) => (apiVersion(info) === 1 ? 'native' : 'default');

  /** {tw, th, scales} from a 1.1 or 2.x/3.x info.json. */
  function tileParams(info) {
    if ('tile_width' in info) {
      return { tw: info.tile_width, th: info.tile_height || info.tile_width, scales: info.scale_factors || [1, 2, 4, 8] };
    }
    const t = (info.tiles && info.tiles[0]) || {};
    const tw = t.width || 1024;
    return { tw, th: t.height || tw, scales: t.scaleFactors || [1, 2, 4, 8] };
  }

  // ---------- Views ----------

  let sessionLastSearch = null;   // hash of the last search, for the "← Résultats" link
  let renderId = 0;   // a newer render makes older async renders drop their output

  async function render() {
    const id = ++renderId;
    const p = hashParams();
    const show = (...nodes) => { if (id === renderId) els.view.replaceChildren(...nodes); };
    const alive = () => id === renderId;
    setStatus('');
    try {
      if (p.get('ark')) {
        const ark = p.get('ark');
        if (p.get('f')) await renderPage(ark, Math.max(1, parseInt(p.get('f'), 10) || 1), show, alive);
        else await renderDocument(ark, show, alive);
      } else if (p.get('q')) {
        await renderSearch(p, show, alive);
      } else {
        show(h('p', { class: 'intro' },
          'Recherchez des documents de Gallica, la bibliothèque numérique de la BnF : plans de villes, cartes, '
          + 'estampes, manuscrits… Choisissez un document pour voir ses pages, puis téléchargez une page en '
          + 'haute définition.'));
      }
    } catch (err) {
      show(errorBox(err));
    }
    if (alive()) setStatus('');
  }

  async function renderSearch(p, show, alive) {
    const words = p.get('q'), type = p.get('type') || '';
    const max = Math.min(50, parseInt(p.get('max'), 10) || 20);
    const start = Math.max(1, parseInt(p.get('start'), 10) || 1);
    els.q.value = words; els.type.value = type; els.max.value = String(max);
    setStatus('Recherche…');
    const { total, results } = await search(words, type, max, start);
    if (!alive()) return;
    const page = (s) => hashFor({ q: words, type, max, start: s });
    const pager = h('div', { class: 'pager' },
      h('button', { disabled: start <= 1, onclick: () => { location.hash = page(Math.max(1, start - max)); } }, '← Précédents'),
      results.length ? `${start}–${start + results.length - 1} sur ${total}` : '',
      h('button', { disabled: start + results.length > total || !results.length,
        onclick: () => { location.hash = page(start + max); } }, 'Suivants →'));
    show(
      h('p', { class: 'count' }, total ? `${total} document${total > 1 ? 's' : ''} pour « ${words} »` : `Aucun document pour « ${words} ».`),
      h('ul', { class: 'results' }, results.map((r) => h('li', { class: 'result' },
        h('a', { class: 'thumb', href: hashFor({ ark: r.ark }) },
          h('img', { src: thumbUrl(r.ark, 1, ',140'), alt: '', loading: 'lazy', onerror: (e) => { e.target.remove(); } })),
        h('div', {},
          h('a', { class: 'title', href: hashFor({ ark: r.ark }) }, r.title || r.ark),
          h('div', { class: 'meta' }, [r.date, r.creator].filter(Boolean).join(' — ')),
          h('div', { class: 'meta' }, r.type),
          h('div', { class: 'meta' }, h('a', { href: GALLICA + '/ark:/12148/' + r.ark, target: '_blank', rel: 'noopener' },
            'Voir sur Gallica'), ' · ark ', r.ark))))),
      total > max ? pager : '');
  }

  async function renderDocument(ark, show, alive) {
    setStatus('Chargement du document…');
    const m = await getManifest(ark);
    if (!alive()) return;
    const pages = canvases(m);
    show(
      h('div', { class: 'crumbs' }, backToSearch(),
        h('a', { href: GALLICA + '/ark:/12148/' + ark, target: '_blank', rel: 'noopener' }, 'Voir sur Gallica')),
      h('h2', {}, plainText(m.label) || ark),
      h('dl', { class: 'md' }, (m.metadata || []).map((md) => [h('dt', {}, plainText(md.label)), h('dd', {}, plainText(md.value))])),
      h('p', { class: 'count' }, `${pages.length} page${pages.length > 1 ? 's' : ''} (vue${pages.length > 1 ? 's' : ''})`),
      h('div', { class: 'pages' }, pages.map((c, i) => h('a', { class: 'page', href: hashFor({ ark, f: i + 1 }) },
        h('img', { src: thumbUrl(ark, i + 1, ',160'), alt: '', loading: 'lazy' }),
        c.label || 'f' + (i + 1)))));
  }

  async function renderPage(ark, f, show, alive) {
    setStatus('Chargement de la page…');
    const [info, manifest] = await Promise.all([getInfo(ark, f), getManifest(ark).catch(() => null)]);
    if (!alive()) return;
    const count = manifest ? canvases(manifest).length : null;
    const q = qualityOf(info);
    const w = info.width, hgt = info.height;
    const { tw, th, scales } = tileParams(info);

    const viewW = (width) => (width === 'full' ? 'full' : Math.min(width, w) + ',');
    const viewer = h('div', { class: 'viewer' },
      h('img', { src: imageUrl(ark, f, 'full', viewW(1200), q), alt: 'Page ' + f }));
    const widthSel = h('select', { onchange: () => { viewer.firstChild.src = imageUrl(ark, f, 'full', viewW(+widthSel.value), q); } },
      [800, 1200, 2000].filter((x) => x < w).concat([w]).map((x) =>
        h('option', { value: x, selected: x === Math.min(1200, w) }, x === w ? `${x} px (entière)` : `${x} px`)));

    // Full resolution: tiles of tw × th px, each covering (tw·k) × (th·k) px of the page.
    const options = scales.map((k) => {
      const W = Math.ceil(w / k), H = Math.ceil(hgt / k);
      return { k, W, H, n: Math.ceil(w / (tw * k)) * Math.ceil(hgt / (th * k)), ok: W * H <= MAX_PIXELS && W <= MAX_SIDE && H <= MAX_SIDE };
    });
    const best = options.filter((o) => o.ok).sort((a, b) => a.k - b.k)[0];
    const scaleSel = h('select', {}, options.map((o) => h('option', { value: o.k, disabled: !o.ok, selected: o === best },
      `1/${o.k} — ${o.W} × ${o.H} px, ${o.n} tuile${o.n > 1 ? 's' : ''}${o.ok ? '' : ' (trop grand pour le navigateur)'}`)));
    const hdOut = h('div', { class: 'viewer' });
    const hdBtn = h('button', { disabled: !best, onclick: async () => {
      hdBtn.disabled = true;
      try { await stitch(ark, f, info, +scaleSel.value, hdOut, alive); } catch (err) { hdOut.replaceChildren(errorBox(err)); }
      hdBtn.disabled = false;
    } }, 'Assembler');

    const nav = (to, text) => h('button', { disabled: to < 1 || (count && to > count),
      onclick: () => { location.hash = hashFor({ ark, f: to }); } }, text);
    show(
      h('div', { class: 'crumbs' }, backToSearch(),
        h('a', { href: hashFor({ ark }) }, '↑ Document'),
        nav(f - 1, '← Page précédente'), `Page ${f}${count ? ' / ' + count : ''}`, nav(f + 1, 'Page suivante →')),
      h('h2', {}, manifest ? plainText(manifest.label) : ark),
      h('div', { class: 'tools' },
        `${w} × ${hgt} px`, ' · Affichage ', widthSel,
        h('a', { href: imageUrl(ark, f, 'full', 'full', q), target: '_blank', rel: 'noopener' }, 'Ouvrir l\'image entière'),
        h('a', { href: GALLICA + '/ark:/12148/' + ark + '/f' + f + '.item', target: '_blank', rel: 'noopener' }, 'Voir sur Gallica')),
      viewer,
      h('div', { class: 'hd' },
        h('h3', {}, 'Haute définition'),
        h('p', { class: 'hint' }, 'Gallica livre les grandes images par morceaux (tuiles) : la page les télécharge une à une '
          + 'et les assemble, puis propose d\'enregistrer le résultat en JPEG.'),
        h('div', { class: 'tools' }, 'Échelle ', scaleSel, hdBtn),
        hdOut));
  }

  function backToSearch() {
    const last = sessionLastSearch;
    return last ? h('a', { href: last }, '← Résultats') : null;
  }

  // ---------- Tile stitching ----------

  /** Load an image usable in a canvas: CORS first, then the proxy; failing both, a tainted (display-only) image. */
  function loadImage(url, mode) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      if (mode !== 'tainted') img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Tuile non chargée : ' + url));
      img.src = mode === 'proxy' ? proxied(url) : url;
    });
  }

  async function stitch(ark, f, info, k, out, alive) {
    const { tw, th } = tileParams(info);
    const q = qualityOf(info);
    const w = info.width, hgt = info.height;
    const rw = tw * k, rh = th * k;
    const W = Math.ceil(w / k), H = Math.ceil(hgt / k);
    const canvas = h('canvas', { width: W, height: H });
    const g = canvas.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);

    const jobs = [];
    for (let y = 0; y < hgt; y += rh) {
      for (let x = 0; x < w; x += rw) {
        const cw = Math.min(rw, w - x), ch = Math.min(rh, hgt - y);
        jobs.push({ url: imageUrl(ark, f, `${x},${y},${cw},${ch}`, Math.ceil(cw / k) + ',', q), dx: x / k, dy: y / k });
      }
    }
    const total = jobs.length;
    const bar = h('progress', { max: total, value: 0 });
    const label = h('span', {}, `0 / ${total} tuiles`);
    out.replaceChildren(h('div', { class: 'tools' }, bar, label));

    // Pick the loading mode on the first tile, then keep it for the others.
    let mode = 'cors';
    const first = jobs.shift();
    let img;
    try { img = await loadImage(first.url, mode); } catch (e) {
      if (proxied(first.url)) {
        mode = 'proxy';
        try { img = await loadImage(first.url, mode); } catch (e2) { mode = 'tainted'; }
      } else {
        mode = 'tainted';
      }
      if (mode === 'tainted') img = await loadImage(first.url, mode);
    }
    g.drawImage(img, first.dx, first.dy);
    let done = 1;
    bar.value = done; label.textContent = `${done} / ${total} tuiles`;

    async function worker() {
      while (jobs.length && alive()) {
        const job = jobs.shift();
        await throttle();
        let tile;
        for (let attempt = 0; ; attempt++) {
          try { tile = await loadImage(job.url, mode); break; } catch (e) {
            if (attempt >= 2) throw e;
            await sleep(2000 * 2 ** attempt);
          }
        }
        g.drawImage(tile, job.dx, job.dy);
        done++;
        bar.value = done; label.textContent = `${done} / ${total} tuiles`;
      }
    }
    await Promise.all(Array.from({ length: TILE_WORKERS }, worker));
    if (!alive()) return;

    const name = `${ark}_f${f}_${W}x${H}.jpg`;
    const save = h('button', { onclick: () => {
      try {
        canvas.toBlob((blob) => {
          const a = h('a', { href: URL.createObjectURL(blob), download: name });
          document.body.append(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(a.href), 10000);
        }, 'image/jpeg', 0.92);
      } catch (err) {
        out.append(errorBox(new Error('Enregistrement impossible : Gallica n\'autorise pas cette page à lire '
          + 'les pixels de ses images (CORS). Faites un clic droit sur l\'image, ou renseignez un proxy CORS.')));
      }
    } }, `Enregistrer ${name}`);
    out.replaceChildren(
      h('div', { class: 'tools' }, `${W} × ${H} px, ${total} tuiles`, save,
        mode === 'tainted' ? h('span', { class: 'hint' }, '(affichage seul : Gallica bloque l\'export, voir Réglages → proxy)') : null),
      canvas);
  }

  // ---------- Wiring ----------

  els.form.addEventListener('submit', (e) => {
    e.preventDefault();
    const words = els.q.value.trim();
    if (!words) return;
    location.hash = hashFor({ q: words, type: els.type.value, max: els.max.value, start: 1 });
  });

  window.addEventListener('hashchange', () => {
    if (hashParams().get('q')) sessionLastSearch = location.hash;
    render();
  });
  if (hashParams().get('q')) sessionLastSearch = location.hash;
  render();
})();
