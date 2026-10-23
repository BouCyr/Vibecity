#!/usr/bin/env python3
"""Query the IIIF APIs of Gallica (BnF): image info, document manifest, images and tiles.

Standard library only (Pillow, if installed, is used to stitch tiles into one image).

Usage:
  python3 tools/gallica-iiif.py search   WORDS... [--type carte] [--max N] [--start K]
                                             [--download] [--size S] [-o DIR]
  python3 tools/gallica-iiif.py info     ARK [--page N]
  python3 tools/gallica-iiif.py manifest ARK [--save FILE]
  python3 tools/gallica-iiif.py image    ARK [--pages 1,3-5|all] [--region R] [--size S]
                                             [--rotation D] [--quality Q] [--format F] [-o DIR]
  python3 tools/gallica-iiif.py tiles    ARK [--page N] [--scale K] [-o DIR] [--stitch]

search queries the SRU API (https://gallica.bnf.fr/SRU) and lists matching documents with their
ARK; --download also saves the first page of each result.

ARK: `btv1b8490098q`, `ark:/12148/btv1b8490098q` or any Gallica URL containing it.

Image API URL: {base}/ark:/12148/{id}/f{page}/{region}/{size}/{rotation}/{quality}.{format}
Gallica implements old spec versions (Image 1.1, Presentation 2.0): the quality defaults to
`native` for Image 1.x and `default` for 2.x+, read from info.json.

Gallica content is free for non-commercial reuse with source attribution ("Source gallica.bnf.fr /
BnF"); commercial use needs a BnF licence. Requests are spaced by --delay seconds (default 1) and
retried with back-off on 429/5xx: do not harvest aggressively, the BnF blocks abusive clients.
"""
import argparse
import json
import math
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

BASE = 'https://gallica.bnf.fr/iiif'
SRU = 'https://gallica.bnf.fr/SRU'
USER_AGENT = 'Vibecity-gallica-iiif/1.0 (+https://github.com/BouCyr/Vibecity)'


class Client:
    def __init__(self, base=BASE, delay=1.0, retries=4, timeout=60):
        self.base = base.rstrip('/')
        self.delay = delay
        self.retries = retries
        self.timeout = timeout
        self._last = 0.0

    def get(self, url):
        """GET url, return bytes; spaces requests and retries on 429/5xx/network errors."""
        for attempt in range(self.retries + 1):
            wait = self._last + self.delay - time.monotonic()
            if wait > 0:
                time.sleep(wait)
            self._last = time.monotonic()
            req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as r:
                    return r.read()
            except urllib.error.HTTPError as e:
                if e.code not in (429, 500, 502, 503, 504) or attempt == self.retries:
                    raise
                retry_after = e.headers.get('Retry-After', '')
                pause = int(retry_after) if retry_after.isdigit() else 2 ** (attempt + 1)
            except (urllib.error.URLError, TimeoutError):
                if attempt == self.retries:
                    raise
                pause = 2 ** (attempt + 1)
            print('  retry in %ds: %s' % (pause, url), file=sys.stderr)
            time.sleep(pause)

    def get_json(self, url):
        return json.loads(self.get(url).decode('utf-8'))

    def doc_url(self, ark):
        return '%s/ark:/12148/%s' % (self.base, ark)

    def page_url(self, ark, page):
        return '%s/f%d' % (self.doc_url(ark), page)

    def info(self, ark, page):
        return self.get_json(self.page_url(ark, page) + '/info.json')

    def manifest(self, ark):
        return self.get_json(self.doc_url(ark) + '/manifest.json')

    def image_url(self, ark, page, region='full', size='full', rotation='0', quality='native', fmt='jpg'):
        return '%s/%s/%s/%s/%s.%s' % (self.page_url(ark, page), region, size, rotation, quality, fmt)


def parse_ark(s):
    m = re.search(r'ark:/12148/([A-Za-z0-9]+)', s)
    if m:
        return m.group(1)
    if re.fullmatch(r'[A-Za-z0-9]+', s):
        return s
    sys.exit('Not a Gallica ARK: %s' % s)


def parse_pages(spec, count):
    """'all', '3', '1,4-6' -> sorted page numbers (1-based)."""
    if spec == 'all':
        if count is None:
            sys.exit('--pages all needs the manifest (page count unknown)')
        return list(range(1, count + 1))
    pages = set()
    for part in spec.split(','):
        a, _, b = part.strip().partition('-')
        pages.update(range(int(a), int(b or a) + 1))
    return sorted(pages)


def api_version(info):
    """Major version of the Image API described by info.json (1, 2 or 3)."""
    ctx = info.get('@context', '')
    ctx = ' '.join(ctx) if isinstance(ctx, list) else ctx
    m = re.search(r'/image/(\d)', ctx)
    if m:
        return int(m.group(1))
    return 1 if 'tile_width' in info else 2


def default_quality(info):
    return 'native' if api_version(info) == 1 else 'default'


def tile_params(info):
    """(tile width, tile height, scale factors) from a 1.1 or 2.x/3.x info.json."""
    if 'tile_width' in info:  # Image API 1.1
        w = info['tile_width']
        return w, info.get('tile_height', w), info.get('scale_factors', [1])
    tiles = (info.get('tiles') or [{}])[0]
    w = tiles.get('width', 1024)
    return w, tiles.get('height', w), tiles.get('scaleFactors', [1])


def manifest_canvases(manifest):
    """[(label, width, height)] from a Presentation 2.0 (sequences) or 3.0 (items) manifest."""
    canvases = manifest.get('sequences', [{}])[0].get('canvases') or manifest.get('items') or []
    out = []
    for c in canvases:
        label = c.get('label', '')
        if isinstance(label, dict):  # 3.0 language map
            label = ' '.join(v for vals in label.values() for v in vals)
        out.append((label, c.get('width'), c.get('height')))
    return out


def label_text(v):
    if isinstance(v, dict):
        return ' '.join(x for vals in v.values() for x in vals)
    if isinstance(v, list):
        return ' / '.join(label_text(x) for x in v)
    return str(v)


def write(path, data):
    os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
    with open(path, 'wb') as f:
        f.write(data)
    print('  %s (%d KB)' % (path, (len(data) + 1023) // 1024))


def search(c, sru, words, doc_type=None, count=10, start=1):
    """SRU search -> (total hits, [{ark, title, date, creator, type}])."""
    query = 'gallica all "%s"' % words.replace('"', '')
    if doc_type:
        query += ' and dc.type all "%s"' % doc_type.replace('"', '')
    url = sru + '?' + urllib.parse.urlencode({
        'operation': 'searchRetrieve', 'version': '1.2', 'query': query,
        'startRecord': start, 'maximumRecords': count})
    root = ET.fromstring(c.get(url))
    total = int(root.findtext('.//{*}numberOfRecords') or 0)
    results = []
    for rec in root.findall('.//{*}recordData'):
        def field(name, rec=rec):
            return [e.text.strip() for e in rec.findall('.//{*}' + name) if e.text and e.text.strip()]
        arks = [m.group(1) for i in field('identifier') for m in [re.search(r'ark:/12148/([A-Za-z0-9]+)', i)] if m]
        if arks:
            results.append({'ark': arks[0], 'title': ' '.join(field('title')),
                            'date': ', '.join(field('date')), 'creator': '; '.join(field('creator')),
                            'type': ', '.join(field('type'))})
    return total, results


def cmd_search(c, a):
    words = ' '.join(a.words)
    total, results = search(c, a.sru, words, a.type, a.max, a.start)
    print('%d documents for "%s"%s' % (total, words, ' (type: %s)' % a.type if a.type else ''))
    for i, r in enumerate(results, a.start):
        print('\n%3d. %s' % (i, r['title'][:110]))
        print('     ark %s   %s' % (r['ark'], ' | '.join(x for x in (r['date'], r['creator'][:60]) if x)))
        print('     %s' % r['type'][:110])
        print('     https://gallica.bnf.fr/ark:/12148/%s' % r['ark'])
        if a.download:
            try:
                quality = default_quality(c.info(r['ark'], 1))
                write(os.path.join(a.out, '%s_f1.jpg' % r['ark']),
                      c.get(c.image_url(r['ark'], 1, size=a.size, quality=quality)))
            except urllib.error.HTTPError as e:
                print('     (no image: HTTP %d)' % e.code)
    if total > a.start + len(results) - 1:
        print('\nMore: --start %d' % (a.start + len(results)))


def cmd_info(c, a):
    info = c.info(a.ark, a.page)
    if a.json:
        print(json.dumps(info, indent=2, ensure_ascii=False))
        return
    tw, th, scales = tile_params(info)
    print('ARK        ark:/12148/%s, page f%d' % (a.ark, a.page))
    print('Image API  %d (quality: %s)' % (api_version(info), default_quality(info)))
    print('Size       %d x %d px' % (info['width'], info['height']))
    print('Tiles      %d x %d px, scale factors %s' % (tw, th, scales))
    for key in ('formats', 'qualities', 'profile'):
        if key in info:
            print('%-10s %s' % (key.capitalize(), info[key]))


def cmd_manifest(c, a):
    m = c.manifest(a.ark)
    if a.save:
        write(a.save, json.dumps(m, indent=2, ensure_ascii=False).encode('utf-8'))
    print('Title   %s' % label_text(m.get('label', '')))
    for md in m.get('metadata', []):
        print('  %-14s %s' % (label_text(md.get('label', '')) + ':', label_text(md.get('value', ''))[:100]))
    canvases = manifest_canvases(m)
    print('Pages   %d' % len(canvases))
    for i, (label, w, h) in enumerate(canvases[:a.list], 1):
        print('  f%-4d %-20s %s x %s' % (i, label, w, h))
    if len(canvases) > a.list:
        print('  ... (%d more, --list N to show more)' % (len(canvases) - a.list))


def cmd_image(c, a):
    count = len(manifest_canvases(c.manifest(a.ark))) if a.pages == 'all' else None
    pages = parse_pages(a.pages, count)
    quality = a.quality or default_quality(c.info(a.ark, pages[0]))
    for p in pages:
        url = c.image_url(a.ark, p, a.region, a.size, a.rotation, quality, a.format)
        print(url)
        write(os.path.join(a.out, '%s_f%d.%s' % (a.ark, p, a.format)), c.get(url))


def cmd_tiles(c, a):
    info = c.info(a.ark, a.page)
    w, h = info['width'], info['height']
    tw, th, scales = tile_params(info)
    k = a.scale or 1
    if k not in scales:
        print('warning: scale %d not in advertised scale factors %s' % (k, scales), file=sys.stderr)
    quality = default_quality(info)
    # One tile covers (tw*k) x (th*k) px of the full image, delivered at tw x th px.
    rw, rh = tw * k, th * k
    cols, rows = math.ceil(w / rw), math.ceil(h / rh)
    print('%d x %d px, scale 1/%d -> %d x %d tiles of %d px' % (w, h, k, cols, rows, tw))
    out = os.path.join(a.out, '%s_f%d_s%d' % (a.ark, a.page, k))
    paths = {}
    for row in range(rows):
        for col in range(cols):
            x, y = col * rw, row * rh
            cw, ch = min(rw, w - x), min(rh, h - y)
            size = '%d,' % math.ceil(cw / k)
            path = os.path.join(out, 'tile_%03d_%03d.jpg' % (row, col))
            paths[row, col] = path
            if os.path.exists(path):
                continue  # resume an interrupted download
            write(path, c.get(c.image_url(a.ark, a.page, '%d,%d,%d,%d' % (x, y, cw, ch), size, '0', quality)))
    if a.stitch:
        stitch(paths, tw, th, math.ceil(w / k), math.ceil(h / k), out + '.jpg')


def stitch(paths, tw, th, w, h, dest):
    try:
        from PIL import Image
    except ImportError:
        sys.exit('--stitch needs Pillow (pip install Pillow); tiles are kept as separate files')
    canvas = Image.new('RGB', (w, h), 'white')
    for (row, col), path in paths.items():
        with Image.open(path) as tile:
            canvas.paste(tile.convert('RGB'), (col * tw, row * th))
    canvas.save(dest, quality=92)
    print('stitched -> %s (%d x %d px)' % (dest, w, h))


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    p.add_argument('--base', default=BASE, help='IIIF base URL (default %(default)s)')
    p.add_argument('--sru', default=SRU, help='SRU search URL (default %(default)s)')
    p.add_argument('--delay', type=float, default=1.0, help='seconds between requests (default 1)')
    sub = p.add_subparsers(dest='cmd', required=True)

    s = sub.add_parser('search', help='find documents by keywords (SRU)')
    s.add_argument('words', nargs='+')
    s.add_argument('--type', help="document type: carte, image, monographie, manuscrit, fascicule...")
    s.add_argument('--max', type=int, default=10, help='results per page (default 10, max 50)')
    s.add_argument('--start', type=int, default=1, help='first result (default 1)')
    s.add_argument('--download', action='store_true', help='save the first page of each result')
    s.add_argument('--size', default='1000,', help="image size for --download (default '1000,')")
    s.add_argument('-o', '--out', default='gallica')
    s.set_defaults(func=cmd_search)

    s = sub.add_parser('info', help='image info of one page (info.json)')
    s.add_argument('ark')
    s.add_argument('--page', type=int, default=1)
    s.add_argument('--json', action='store_true', help='print the raw info.json')
    s.set_defaults(func=cmd_info)

    s = sub.add_parser('manifest', help='document manifest: title, metadata, pages')
    s.add_argument('ark')
    s.add_argument('--save', metavar='FILE', help='also save the manifest JSON')
    s.add_argument('--list', type=int, default=10, help='pages to list (default 10)')
    s.set_defaults(func=cmd_manifest)

    s = sub.add_parser('image', help='download page images')
    s.add_argument('ark')
    s.add_argument('--pages', default='1', help="'1', '1,3-5' or 'all' (default 1)")
    s.add_argument('--region', default='full', help="'full' or 'x,y,w,h' (default full)")
    s.add_argument('--size', default='full', help="'full', 'w,', ',h', 'pct:n' (default full)")
    s.add_argument('--rotation', default='0')
    s.add_argument('--quality', help='native/default/color/gray/bitonal (default from info.json)')
    s.add_argument('--format', default='jpg')
    s.add_argument('-o', '--out', default='gallica')
    s.set_defaults(func=cmd_image)

    s = sub.add_parser('tiles', help='download one page as tiles (optionally stitched)')
    s.add_argument('ark')
    s.add_argument('--page', type=int, default=1)
    s.add_argument('--scale', type=int, help='scale factor, 1 = full resolution (default 1)')
    s.add_argument('-o', '--out', default='gallica')
    s.add_argument('--stitch', action='store_true', help='assemble the tiles (needs Pillow)')
    s.set_defaults(func=cmd_tiles)

    a = p.parse_args(argv)
    if a.cmd != 'search':
        a.ark = parse_ark(a.ark)
    try:
        a.func(Client(a.base, a.delay), a)
    except urllib.error.HTTPError as e:
        sys.exit('HTTP %d on %s' % (e.code, e.url))
    except urllib.error.URLError as e:
        sys.exit('Network error: %s' % e.reason)


if __name__ == '__main__':
    main()
