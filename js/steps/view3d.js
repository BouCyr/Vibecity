// Step 11 — 3D view (optional display mode, hidden by default). The map is
// turned into a WebGL relief: each cell is a fan of triangles from its centre
// to its polygon points, at their altitudes; water (sea and river cells) in
// blue, land coloured like the Altitude layer. Lighting: ambient + diffuse
// (Lambert) from a directional light. Drag to orbit, right-drag or shift-drag
// to pan, wheel to zoom. When its layer is shown, it replaces the 2D map.
(function (global) {
  'use strict';

  const WATER = [95, 134, 168];
  const CLIFF = [150, 132, 110];

  // ---------- Small matrix helpers (column-major, as WebGL expects) ----------

  function perspective(fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
  }

  function lookAt(eye, target, up) {
    const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const z = norm(sub(eye, target)), x = norm(cross(up, z)), y = cross(z, x);
    return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1];
  }

  function multiply(a, b) {
    const out = new Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        let sum = 0;
        for (let k = 0; k < 4; k++) sum += a[k * 4 + r] * b[c * 4 + k];
        out[c * 4 + r] = sum;
      }
    }
    return out;
  }

  // ---------- Mesh ----------

  /**
   * Triangles of the relief: positions (x, height, y), smooth normals (face
   * normals summed at shared points) and colours (0–1). The sea is a flat
   * surface at 0; where the land along the coast is higher, a vertical cliff
   * closes the gap (flat-shaded).
   */
  function buildMesh(state, s, width, height) {
    const top = state.altitudeMax || 1;
    // Without the altitude curve step, altitudes are in [0, 1]: show them as 300 m.
    const metres = state.altitudeMax ? 1 : 300;
    const lift = (a) => a * metres * s.verticalScale;
    const pos = [], col = [], walls = [];
    // Polygon edges of the land (and river) cells: where a sea cell meets them, a cliff.
    const pk = (p) => Math.round(p.x * 10) + ',' + Math.round(p.y * 10);
    const ek = (a, b) => { const x = pk(a), y = pk(b); return x < y ? x + '|' + y : y + '|' + x; };
    const landEdges = new Set();
    for (const c of state.cells) {
      if (c.sea || !c.poly) continue;
      c.poly.forEach((p, k) => landEdges.add(ek(p, c.poly[(k + 1) % c.poly.length])));
    }
    const colour = (water, a) => (water ? WATER : global.altitudeRampRGB(a / top)).map((v) => v / 255);
    for (const c of state.cells) {
      const poly = c.poly || c.nodes.map((id) => state.nodes[id]);
      const alt = c.polyAlt || c.nodes.map((id) => state.nodes[id].altitude);
      if (poly.length < 3) continue;
      const water = !!c.sea || c.river !== undefined;
      const h = c.sea ? () => 0 : (a) => lift(a);
      const centre = [c.site.x, h(c.altitude), c.site.y], cc = colour(water, c.altitude);
      for (let k = 0; k < poly.length; k++) {
        const k2 = (k + 1) % poly.length;
        pos.push(centre[0], centre[1], centre[2], poly[k].x, h(alt[k]), poly[k].y, poly[k2].x, h(alt[k2]), poly[k2].y);
        col.push(...cc, ...colour(water, alt[k]), ...colour(water, alt[k2]));
        if (c.sea && (alt[k] > 0 || alt[k2] > 0) && landEdges.has(ek(poly[k], poly[k2]))) {
          // Cliff from the sea up to the land, facing the sea cell's centre.
          const a = poly[k], b = poly[k2], ha = lift(alt[k]), hb = lift(alt[k2]);
          let nx = -(b.y - a.y), nz = b.x - a.x;
          const mx = (a.x + b.x) / 2 - c.site.x, mz = (a.y + b.y) / 2 - c.site.y;
          if (nx * mx + nz * mz > 0) { nx = -nx; nz = -nz; }
          const l = Math.hypot(nx, nz) || 1;
          walls.push([[a.x, 0, a.y, b.x, 0, b.y, b.x, hb, b.y, a.x, 0, a.y, b.x, hb, b.y, a.x, ha, a.y], [nx / l, 0, nz / l]]);
        }
      }
    }
    // Smooth normals: sum the face normals at each shared point (by position).
    const n = pos.length / 3;
    const acc = new Map(), keys = new Array(n);
    for (let t = 0; t < n; t += 3) {
      const a = t * 3, b = a + 3, d = a + 6;
      const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
      const vx = pos[d] - pos[a], vy = pos[d + 1] - pos[a + 1], vz = pos[d + 2] - pos[a + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; } // facing up, whatever the winding
      for (let v = t; v < t + 3; v++) {
        const key = Math.round(pos[v * 3] * 10) + ',' + Math.round(pos[v * 3 + 2] * 10);
        keys[v] = key;
        const sum = acc.get(key);
        if (sum) { sum[0] += nx; sum[1] += ny; sum[2] += nz; } else acc.set(key, [nx, ny, nz]);
      }
    }
    const nrm = [];
    for (let v = 0; v < n; v++) {
      const sum = acc.get(keys[v]), l = Math.hypot(sum[0], sum[1], sum[2]) || 1;
      nrm.push(sum[0] / l, sum[1] / l, sum[2] / l);
    }
    // Cliffs, flat-shaded.
    const cliff = CLIFF.map((v) => v / 255);
    for (const [quad, wn] of walls) {
      pos.push(...quad);
      for (let k = 0; k < 6; k++) { nrm.push(...wn); col.push(...cliff); }
    }
    return { pos: new Float32Array(pos), nrm: new Float32Array(nrm), col: new Float32Array(col), count: pos.length / 3, width: width, height: height };
  }

  // ---------- Renderer ----------

  const VS = [
    'attribute vec3 aPos; attribute vec3 aNrm; attribute vec3 aCol;',
    'uniform mat4 uMVP; varying vec3 vNrm; varying vec3 vCol;',
    'void main() { vNrm = aNrm; vCol = aCol; gl_Position = uMVP * vec4(aPos, 1.0); }'
  ].join('\n');
  const FS = [
    'precision mediump float;',
    'uniform vec3 uLight; uniform float uAmbient; varying vec3 vNrm; varying vec3 vCol;',
    'void main() {',
    '  float diffuse = max(dot(normalize(vNrm), uLight), 0.0);',
    '  gl_FragColor = vec4(vCol * (uAmbient + (1.0 - uAmbient) * diffuse), 1.0);',
    '}'
  ].join('\n');

  const view = {
    canvas: null, gl: null, prog: null, buffers: null, mesh: null, state: null, settings: null,
    camera: { yaw: Math.PI / 6, pitch: 0.75, dist: 2700, target: [1000, 0, 1000] },
    error: ''
  };

  function initGL(canvas) {
    const gl = canvas.getContext('webgl', { antialias: true }) || canvas.getContext('experimental-webgl');
    if (!gl) { view.error = 'WebGL is not available in this browser'; return null; }
    const shader = (type, src) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
      return sh;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, shader(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    view.prog = prog;
    view.buffers = { pos: gl.createBuffer(), nrm: gl.createBuffer(), col: gl.createBuffer() };
    gl.enable(gl.DEPTH_TEST);
    return gl;
  }

  /** Orbit (drag), pan (right- or shift-drag), zoom (wheel, pinch). */
  function attachControls(canvas) {
    const cam = view.camera, pointers = new Map();
    let pinch = 0;
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey });
    });
    canvas.addEventListener('pointermove', (e) => {
      const p = pointers.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch) cam.dist = Math.max(300, Math.min(8000, cam.dist * pinch / d));
        pinch = d;
      } else if (p.pan) {
        const k = cam.dist / canvas.clientHeight;
        const sx = Math.cos(cam.yaw), sz = -Math.sin(cam.yaw);
        const fx = -Math.sin(cam.yaw), fz = -Math.cos(cam.yaw);
        cam.target[0] -= (dx * sx - dy * fx) * k;
        cam.target[2] -= (dx * sz - dy * fz) * k;
      } else {
        cam.yaw -= dx * 0.008;
        cam.pitch = Math.max(0.08, Math.min(1.55, cam.pitch + dy * 0.006));
      }
      render();
    });
    const up = (e) => { pointers.delete(e.pointerId); pinch = 0; };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      cam.dist = Math.max(300, Math.min(8000, cam.dist * Math.exp(e.deltaY * 0.001)));
      render();
    }, { passive: false });
  }

  function render() {
    const canvas = view.canvas, gl = view.gl, mesh = view.mesh, s = view.settings;
    if (!gl || !mesh) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    gl.viewport(0, 0, w, h);
    gl.clearColor(0.17, 0.15, 0.13, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const cam = view.camera, t = cam.target;
    const eye = [
      t[0] + cam.dist * Math.cos(cam.pitch) * Math.sin(cam.yaw),
      t[1] + cam.dist * Math.sin(cam.pitch),
      t[2] + cam.dist * Math.cos(cam.pitch) * Math.cos(cam.yaw)
    ];
    const mvp = multiply(perspective(Math.PI / 4, w / h, cam.dist * 0.02, cam.dist * 4), lookAt(eye, t, [0, 1, 0]));

    gl.useProgram(view.prog);
    const attr = (name, buf) => {
      const loc = gl.getAttribLocation(view.prog, name);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0);
    };
    attr('aPos', view.buffers.pos);
    attr('aNrm', view.buffers.nrm);
    attr('aCol', view.buffers.col);
    gl.uniformMatrix4fv(gl.getUniformLocation(view.prog, 'uMVP'), false, new Float32Array(mvp));
    // Light direction from azimuth (0° = north, clockwise) and elevation.
    const az = (s.lightAzimuth * Math.PI) / 180, el = (s.lightElevation * Math.PI) / 180;
    gl.uniform3f(gl.getUniformLocation(view.prog, 'uLight'), Math.cos(el) * Math.sin(az), Math.sin(el), -Math.cos(el) * Math.cos(az));
    gl.uniform1f(gl.getUniformLocation(view.prog, 'uAmbient'), s.ambient);
    gl.drawArrays(gl.TRIANGLES, 0, mesh.count);
  }

  global.View3D = {
    /** Shows the 3D view of `state` in `canvas` (set up on first use). */
    show(canvas, state, settings) {
      if (view.canvas !== canvas) {
        view.canvas = canvas;
        try { view.gl = initGL(canvas); } catch (e) { view.gl = null; view.error = 'WebGL error: ' + e.message; }
        if (view.gl) attachControls(canvas);
      }
      view.settings = settings;
      if (state.mesh3d && state.mesh3d !== view.mesh && view.gl) {
        const gl = view.gl;
        view.mesh = state.mesh3d;
        gl.bindBuffer(gl.ARRAY_BUFFER, view.buffers.pos); gl.bufferData(gl.ARRAY_BUFFER, view.mesh.pos, gl.STATIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, view.buffers.nrm); gl.bufferData(gl.ARRAY_BUFFER, view.mesh.nrm, gl.STATIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, view.buffers.col); gl.bufferData(gl.ARRAY_BUFFER, view.mesh.col, gl.STATIC_DRAW);
      }
      render();
      return view.error;
    }
  };

  global.View3DStep = {
    id: 'view3d',
    title: '3D view',
    // Optional display mode: its checkbox switches the stage to the 3D view.
    defaultVisible: false,
    view3d: true,
    settings: [
      { key: 'verticalScale', label: 'Vertical scale (px per metre)', type: 'range', min: 0, max: 5, step: 0.1, default: 1 },
      { key: 'ambient', label: 'Ambient light', type: 'range', min: 0, max: 1, step: 0.05, default: 0.35 },
      { key: 'lightAzimuth', label: 'Light direction (°, 0 = north)', type: 'range', min: 0, max: 360, step: 5, default: 315 },
      { key: 'lightElevation', label: 'Light elevation (°)', type: 'range', min: 5, max: 90, step: 1, default: 45 }
    ],

    run(state, s, rng, ctx) {
      state.mesh3d = buildMesh(state, s, ctx.width, ctx.height);
      return (state.mesh3d.count / 3) + ' triangles. Tick the box to show it: drag to orbit, right- or shift-drag to pan, wheel to zoom.';
    },

    draw() {}
  };
})(window);
