// A pen the drawing is written against, with two backends: the canvas of the
// page (widths and text sizes in screen px, whatever the zoom; a viewport to
// cull against) and an SVG document (the whole map at one unit per px, the
// same code producing the file to export). Styles are plain objects:
//   { fill, stroke, width (screen px), dash ([px, px]), alpha, cap, join }
// Text styles add { size (screen px), font, weight, italic, align, baseline, halo }.
(function (global) {
  'use strict';

  const DEFAULT_FONT = 'Georgia, "Times New Roman", serif';

  /** Pen on a 2D canvas context already transformed to map coordinates; `ctx.px` is map units per screen px. */
  class CanvasPen {
    constructor(g, ctx) {
      this.g = g;
      this.px = ctx.px;
      this.scale = ctx.scale;
      this.rect = ctx.viewRect || { x0: -Infinity, y0: -Infinity, x1: Infinity, y1: Infinity };
    }
    /** Is a map-space box at least partly on screen? */
    visible(x0, y0, x1, y1) { return x1 >= this.rect.x0 && x0 <= this.rect.x1 && y1 >= this.rect.y0 && y0 <= this.rect.y1; }
    group() {}
    endGroup() {}
    _style(st) {
      const g = this.g;
      g.globalAlpha = st.alpha === undefined ? 1 : st.alpha;
      g.lineWidth = (st.width || 1) * this.px;
      g.lineCap = st.cap || 'round';
      g.lineJoin = st.join || 'round';
      g.setLineDash(st.dash ? st.dash.map((d) => d * this.px) : []);
      if (st.fill) g.fillStyle = st.fill;
      if (st.stroke) g.strokeStyle = st.stroke;
    }
    _path(pts, close) {
      const g = this.g;
      g.beginPath();
      for (let i = 0; i < pts.length; i++) (i ? g.lineTo(pts[i].x, pts[i].y) : g.moveTo(pts[i].x, pts[i].y));
      if (close) g.closePath();
    }
    polygon(pts, st) {
      if (pts.length < 3) return;
      this._style(st);
      this._path(pts, true);
      if (st.fill) this.g.fill();
      if (st.stroke) this.g.stroke();
    }
    polyline(pts, st) {
      if (pts.length < 2) return;
      this._style(st);
      this._path(pts, false);
      this.g.stroke();
    }
    /** Many segments [x1, y1, x2, y2, …] in one stroke (a flat array). */
    segments(flat, st) {
      if (!flat || flat.length < 4) return;
      this._style(st);
      const g = this.g, r = this.rect;
      g.beginPath();
      for (let k = 0; k + 3 < flat.length; k += 4) {
        const x1 = flat[k], y1 = flat[k + 1], x2 = flat[k + 2], y2 = flat[k + 3];
        if (Math.max(x1, x2) < r.x0 || Math.min(x1, x2) > r.x1 || Math.max(y1, y2) < r.y0 || Math.min(y1, y2) > r.y1) continue;
        g.moveTo(x1, y1);
        g.lineTo(x2, y2);
      }
      g.stroke();
    }
    circle(x, y, r, st) {
      this._style(st);
      this.g.beginPath();
      this.g.arc(x, y, r, 0, Math.PI * 2);
      if (st.fill) this.g.fill();
      if (st.stroke) this.g.stroke();
    }
    /** An image (a canvas) stretched over a map rectangle. */
    image(img, x, y, w, h, alpha) {
      const g = this.g;
      g.save();
      g.globalAlpha = alpha === undefined ? 1 : alpha;
      g.imageSmoothingEnabled = true;
      g.drawImage(img, x, y, w, h);
      g.restore();
    }
    _font(st) {
      return (st.italic ? 'italic ' : '') + (st.weight || 'normal') + ' ' + ((st.size || 12) * this.px) + 'px ' + (st.font || DEFAULT_FONT);
    }
    text(str, x, y, st) {
      const g = this.g;
      g.globalAlpha = st.alpha === undefined ? 1 : st.alpha;
      g.font = this._font(st);
      g.textAlign = st.align || 'center';
      g.textBaseline = st.baseline || 'middle';
      g.setLineDash([]);
      if (st.letterSpacing !== undefined && 'letterSpacing' in g) g.letterSpacing = (st.letterSpacing * this.px) + 'px';
      if (st.halo) { g.strokeStyle = st.halo; g.lineWidth = (st.haloWidth || 3) * this.px; g.lineJoin = 'round'; g.strokeText(str, x, y); }
      g.fillStyle = st.fill || '#000';
      g.fillText(str, x, y);
      if ('letterSpacing' in g) g.letterSpacing = '0px';
    }
    /** Text laid along a polyline, centred on it, reading left to right. */
    textAlong(str, pts, st) {
      const g = this.g;
      if (pts.length < 2) return;
      if (pts[pts.length - 1].x < pts[0].x) pts = pts.slice().reverse();
      const cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
      const total = cum[cum.length - 1];
      g.font = this._font(st);
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.setLineDash([]);
      const widths = Array.from(str).map((c) => g.measureText(c).width);
      const spacing = (st.letterSpacing || 0) * this.px;
      const length = widths.reduce((a, b) => a + b, 0) + spacing * (str.length - 1);
      if (length > total) return;
      let s = (total - length) / 2;
      const at = (d) => {
        let i = 1;
        while (i < cum.length - 1 && cum[i] < d) i++;
        const a = pts[i - 1], b = pts[i], l = cum[i] - cum[i - 1] || 1, t = (d - cum[i - 1]) / l;
        return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, ang: Math.atan2(b.y - a.y, b.x - a.x) };
      };
      g.globalAlpha = st.alpha === undefined ? 1 : st.alpha;
      Array.from(str).forEach((ch, i) => {
        const p = at(s + widths[i] / 2);
        g.save();
        g.translate(p.x, p.y);
        g.rotate(p.ang);
        if (st.halo) { g.strokeStyle = st.halo; g.lineWidth = (st.haloWidth || 3) * this.px; g.strokeText(ch, 0, 0); }
        g.fillStyle = st.fill || '#000';
        g.fillText(ch, 0, 0);
        g.restore();
        s += widths[i] + spacing;
      });
    }
  }

  /** Pen writing an SVG document of the whole map, one unit per px. */
  class SvgPen {
    constructor(width, height) {
      this.px = 1;
      this.scale = 1;
      this.w = width; this.h = height;
      this.parts = [];
      this.defs = [];
      this.ids = 0;
    }
    visible() { return true; }
    group(name) { this.parts.push('<g id="' + esc(name) + '">'); }
    endGroup() { this.parts.push('</g>'); }
    _attrs(st, fillable) {
      let a = '';
      a += ' fill="' + (fillable && st.fill ? st.fill : 'none') + '"';
      if (st.stroke) {
        a += ' stroke="' + st.stroke + '" stroke-width="' + num(st.width || 1) + '" stroke-linecap="' + (st.cap || 'round') + '" stroke-linejoin="' + (st.join || 'round') + '"';
        if (st.dash) a += ' stroke-dasharray="' + st.dash.map(num).join(' ') + '"';
      }
      if (st.alpha !== undefined && st.alpha !== 1) a += ' opacity="' + num(st.alpha) + '"';
      return a;
    }
    _d(pts, close) {
      let d = '';
      for (let i = 0; i < pts.length; i++) d += (i ? 'L' : 'M') + num(pts[i].x) + ' ' + num(pts[i].y);
      return close ? d + 'Z' : d;
    }
    polygon(pts, st) { if (pts.length >= 3) this.parts.push('<path d="' + this._d(pts, true) + '"' + this._attrs(st, true) + '/>'); }
    polyline(pts, st) { if (pts.length >= 2) this.parts.push('<path d="' + this._d(pts, false) + '"' + this._attrs(st, false) + '/>'); }
    segments(flat, st) {
      if (!flat || flat.length < 4) return;
      let d = '';
      for (let k = 0; k + 3 < flat.length; k += 4) d += 'M' + num(flat[k]) + ' ' + num(flat[k + 1]) + 'L' + num(flat[k + 2]) + ' ' + num(flat[k + 3]);
      this.parts.push('<path d="' + d + '"' + this._attrs(st, false) + '/>');
    }
    circle(x, y, r, st) { this.parts.push('<circle cx="' + num(x) + '" cy="' + num(y) + '" r="' + num(r) + '"' + this._attrs(st, true) + '/>'); }
    image(img, x, y, w, h, alpha) {
      this.parts.push('<image href="' + img.toDataURL('image/png') + '" x="' + num(x) + '" y="' + num(y) + '" width="' + num(w) + '" height="' + num(h) + '"' +
        (alpha !== undefined && alpha !== 1 ? ' opacity="' + num(alpha) + '"' : '') + ' style="image-rendering:auto"/>');
    }
    _textAttrs(st) {
      let a = ' font-family="' + esc(st.font || DEFAULT_FONT) + '" font-size="' + num(st.size || 12) + '"';
      if (st.weight) a += ' font-weight="' + st.weight + '"';
      if (st.italic) a += ' font-style="italic"';
      if (st.letterSpacing) a += ' letter-spacing="' + num(st.letterSpacing) + '"';
      a += ' fill="' + (st.fill || '#000') + '"';
      if (st.halo) a += ' stroke="' + st.halo + '" stroke-width="' + num(st.haloWidth || 3) + '" stroke-linejoin="round" paint-order="stroke"';
      if (st.alpha !== undefined && st.alpha !== 1) a += ' opacity="' + num(st.alpha) + '"';
      return a;
    }
    text(str, x, y, st) {
      const anchor = { left: 'start', right: 'end', center: 'middle' }[st.align || 'center'];
      const base = { top: 'hanging', bottom: 'auto', middle: 'central', alphabetic: 'auto' }[st.baseline || 'middle'];
      this.parts.push('<text x="' + num(x) + '" y="' + num(y) + '" text-anchor="' + anchor + '" dominant-baseline="' + base + '"' + this._textAttrs(st) + '>' + esc(str) + '</text>');
    }
    textAlong(str, pts, st) {
      if (pts.length < 2) return;
      if (pts[pts.length - 1].x < pts[0].x) pts = pts.slice().reverse();
      const id = 'tp' + (this.ids++);
      this.defs.push('<path id="' + id + '" d="' + this._d(pts, false) + '"/>');
      this.parts.push('<text' + this._textAttrs(st) + ' dominant-baseline="central"><textPath href="#' + id + '" startOffset="50%" text-anchor="middle">' + esc(str) + '</textPath></text>');
    }
    toString() {
      return '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="' + this.w + '" height="' + this.h + '" viewBox="0 0 ' + this.w + ' ' + this.h + '">\n' +
        (this.defs.length ? '<defs>' + this.defs.join('') + '</defs>\n' : '') + this.parts.join('\n') + '\n</svg>\n';
    }
  }

  const num = (v) => (Math.round(v * 100) / 100).toString();
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  global.Pen = { CanvasPen: CanvasPen, SvgPen: SvgPen };
})(window);
