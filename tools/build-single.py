#!/usr/bin/env python3
"""Bundle index.html, its stylesheet and scripts into one self-contained HTML page.

Usage: python3 tools/build-single.py OUTPUT.html
"""
import os
import re
import sys

root = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
html = open(os.path.join(root, 'index.html')).read()
body = html[html.index('<body>') + 6:html.index('</body>')]
scripts = re.findall(r'<script src="([^"]+)"></script>', body)
body = re.sub(r'\s*<script src="[^"]+"></script>', '', body).strip()
css = open(os.path.join(root, 'css/style.css')).read()
js = '\n'.join(open(os.path.join(root, s)).read() for s in scripts)
with open(sys.argv[1], 'w') as f:
    f.write('<title>Vibecity</title>\n<style>\n%s\n</style>\n%s\n<script>\n%s\n</script>\n' % (css, body, js))
