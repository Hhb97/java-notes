#!/usr/bin/env python3
"""SVG 图解排版检查（启发式）：在仓库根目录运行 `python tools/svgcheck.py [md 文件或目录 ...]`，默认检查 docs/math。

按 CSS 里的字号估算每个 <text> 的宽高，报告：
  OVERFLOW  文字超出 viewBox
  BOX       文字比包着它的方块（rect）还宽/高
  OVERLAP   两段文字互相重叠
  OFFCANVAS 形状（rect / circle / line）超出 viewBox
这是估算（中文按 1 个字号宽，英文按约 0.56），留有余量；报告的位置请对着图再看一眼。有 OVERFLOW / BOX / OVERLAP 时退出码为 1。
"""
import pathlib
import re
import sys

SIZE = {'t': 13, 'tb': 13, 'th': 15, 'ts': 11.5, 'ta': 13, 'tw': 13, 'tm': 12}
BOLD = {'tb': 1.05, 'th': 1.05, 'ta': 1.03, 'tw': 1.03}
ATTR = re.compile(r'([\w:-]+)="([^"]*)"')


def char_w(ch, size, mono):
    o = ord(ch)
    if mono:
        return size * 0.6
    if o >= 0x2E80 or ch in '，。：；（）“”‘’！？、—…·【】《》':
        return size * 1.0
    if ch == ' ':
        return size * 0.32
    if ch in 'il.,:;|!\'`':
        return size * 0.3
    if ch in 'mwMW':
        return size * 0.85
    if ch.isupper():
        return size * 0.68
    if ch.isascii():
        return size * 0.56
    return size * 0.7  # ∂ ∇ Σ θ ² √ 等符号


def text_box(attrs, content):
    cls = (attrs.get('class') or 't').split()[0]
    size = SIZE.get(cls, 13)
    mono = cls == 'tm'
    w = sum(char_w(c, size, mono) for c in content) * BOLD.get(cls, 1.0)
    x = float(attrs.get('x', 0))
    y = float(attrs.get('y', 0))
    anchor = attrs.get('text-anchor', 'start')
    if anchor == 'middle':
        x0, x1 = x - w / 2, x + w / 2
    elif anchor == 'end':
        x0, x1 = x - w, x
    else:
        x0, x1 = x, x + w
    if attrs.get('dominant-baseline') == 'middle':
        y0, y1 = y - size * 0.55, y + size * 0.55
    else:
        y0, y1 = y - size * 0.85, y + size * 0.25
    return x0, y0, x1, y1


def clean(t):
    return re.sub(r'<[^>]+>', '', t).replace('&lt;', '<').replace('&gt;', '>').replace('&amp;', '&').strip()


def check_svg(svg, label, out):
    m = re.search(r'viewBox="0 0 ([\d.]+) ([\d.]+)"', svg)
    if not m:
        return 0
    W, H = float(m.group(1)), float(m.group(2))
    rects, shapes, texts = [], [], []
    for tag in re.finditer(r'<(rect|circle|line|text)\b([^>]*?)(?:/>|>(.*?)</text>)', svg, re.S):
        kind, raw, inner = tag.group(1), tag.group(2), tag.group(3)
        a = dict(ATTR.findall(raw))
        try:
            if kind == 'rect':
                x, y, w, h = (float(a[k]) for k in ('x', 'y', 'width', 'height'))
                rects.append((x, y, x + w, y + h, a.get('class', '')))
                shapes.append(('rect', x, y, x + w, y + h))
            elif kind == 'circle':
                cx, cy, r = (float(a[k]) for k in ('cx', 'cy', 'r'))
                shapes.append(('circle', cx - r, cy - r, cx + r, cy + r))
            elif kind == 'line':
                x1, y1, x2, y2 = (float(a[k]) for k in ('x1', 'y1', 'x2', 'y2'))
                shapes.append(('line', min(x1, x2), min(y1, y2), max(x1, x2), max(y1, y2)))
            elif kind == 'text' and inner is not None:
                content = clean(inner)
                if content:
                    texts.append((content, text_box(a, content), a))
        except (KeyError, ValueError):
            continue
    n = 0
    for kind, x0, y0, x1, y1 in shapes:
        if x0 < -3 or y0 < -3 or x1 > W + 3 or y1 > H + 3:
            out.append(f'  {label} OFFCANVAS {kind} ({x0:.0f},{y0:.0f})-({x1:.0f},{y1:.0f}) 超出 viewBox {W:.0f}x{H:.0f}')
    for content, (x0, y0, x1, y1), a in texts:
        if x0 < -4 or x1 > W + 4 or y0 < -4 or y1 > H + 4:
            out.append(f'  {label} OVERFLOW 「{content[:24]}」估算占 x {x0:.0f}~{x1:.0f}, y {y0:.0f}~{y1:.0f}，viewBox {W:.0f}x{H:.0f}')
            n += 1
        cx, cy = float(a.get('x', 0)), float(a.get('y', 0))
        holders = [r for r in rects if r[0] <= cx <= r[2] and r[1] <= cy <= r[3] and 'bg' not in r[4].split()]
        if holders:
            r = min(holders, key=lambda r: (r[2] - r[0]) * (r[3] - r[1]))
            if x0 < r[0] + 2 or x1 > r[2] - 2:
                out.append(f'  {label} BOX 「{content[:24]}」约宽 {x1 - x0:.0f}，方块宽 {r[2] - r[0]:.0f}（x {r[0]:.0f}~{r[2]:.0f}）')
                n += 1
        else:
            bgs = [r for r in rects if 'bg' in r[4].split() and r[0] <= cx <= r[2] and r[1] <= cy <= r[3]]
            if bgs:
                r = min(bgs, key=lambda r: (r[2] - r[0]) * (r[3] - r[1]))
                if x0 < r[0] + 2 or x1 > r[2] - 2:
                    out.append(f'  {label} BOX 「{content[:24]}」伸出分组框（框 x {r[0]:.0f}~{r[2]:.0f}，文字约 {x0:.0f}~{x1:.0f}）')
                    n += 1
    for i in range(len(texts)):
        for j in range(i + 1, len(texts)):
            (ci, bi, _), (cj, bj, _) = texts[i], texts[j]
            ix = min(bi[2], bj[2]) - max(bi[0], bj[0])
            iy = min(bi[3], bj[3]) - max(bi[1], bj[1])
            if ix > 2 and iy > 2:
                area = ix * iy
                small = min((bi[2] - bi[0]) * (bi[3] - bi[1]), (bj[2] - bj[0]) * (bj[3] - bj[1]))
                if small > 0 and area / small > 0.25:
                    out.append(f'  {label} OVERLAP 「{ci[:16]}」与「{cj[:16]}」重叠约 {ix:.0f}x{iy:.0f}')
                    n += 1
    return n


def main():
    root = pathlib.Path('.').resolve()
    targets = [pathlib.Path(a) for a in sys.argv[1:]] or [root / 'docs' / 'math']
    files = []
    for t in targets:
        files += sorted(t.rglob('*.md')) if t.is_dir() else [t]
    bad = 0
    for f in files:
        text = f.read_text(encoding='utf-8')
        figs = re.findall(r'<svg\b.*?</svg>', text, re.S)
        out = []
        n = 0
        for i, s in enumerate(figs, 1):
            n += check_svg(s, f'图{i}', out)
        print(f'{f.relative_to(root) if f.is_absolute() and root in f.parents else f}: {len(figs)} 张图, {n} 个问题')
        for line in out:
            print(line)
        bad += n
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    main()
