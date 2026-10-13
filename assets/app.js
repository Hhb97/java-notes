(function () {
  'use strict';

  var NAV = window.NAV;
  var $ = function (id) { return document.getElementById(id); };
  var content = $('content'), navEl = $('nav'), tocEl = $('toc'), docHead = $('docHead');
  var SITE = 'Java 后端工程师笔记';

  var cache = {};           // path -> 原始 markdown
  var pages = [];           // 扁平化文章 {title, path, cat, trail}
  var byPath = {};
  var catById = {};
  var current = { path: null };
  var spy = null;

  /* ================= 目录数据 ================= */
  NAV.forEach(function (cat) {
    catById[cat.id] = cat;
    cat.pages = [];
    (function walk(items, trail) {
      items.forEach(function (n) {
        if (n.children) return walk(n.children, trail.concat(n.title));
        var p = { title: n.title, path: n.path, cat: cat, trail: trail };
        pages.push(p); cat.pages.push(p); byPath[n.path] = p;
      });
    })(cat.children, []);
  });

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  }

  var ICON = {
    chev: '<svg class="chev" viewBox="0 0 16 16" width="16" height="16"><path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    clock: '<svg viewBox="0 0 16 16" width="14" height="14"><circle cx="8" cy="8" r="6.2" stroke="currentColor" stroke-width="1.4" fill="none"/><path d="M8 4.8V8l2.2 1.4" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round"/></svg>',
    fig: '<svg viewBox="0 0 16 16" width="14" height="14"><rect x="1.8" y="2.5" width="12.4" height="11" rx="2" stroke="currentColor" stroke-width="1.4" fill="none"/><path d="M4.5 10.5l2.5-3 2 2 1.5-1.5 1.5 2.5" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linejoin="round"/></svg>',
    qa: '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linejoin="round"/></svg>'
  };
  var CALLOUT = {
    NOTE: ['说明', '<circle cx="8" cy="8" r="6.3" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M8 7.2v4M8 4.9v.1" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>'],
    TIP: ['实践建议', '<path d="M5.5 11.5h5M6.3 14h3.4M8 1.8a4.4 4.4 0 0 0-2.6 8c.4.3.6.7.6 1.2v.5h4v-.5c0-.5.2-.9.6-1.2A4.4 4.4 0 0 0 8 1.8z" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linejoin="round"/>'],
    IMPORTANT: ['重要', '<path d="M2.5 3h11v8h-6l-3 2.5V11h-2z" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linejoin="round"/><path d="M8 5v3M8 9.6v.1" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>'],
    WARNING: ['注意', '<path d="M8 1.8L14.6 13.5H1.4z" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linejoin="round"/><path d="M8 6.3v3.3M8 11.5v.1" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>'],
    CAUTION: ['危险操作', '<path d="M5.3 1.8h5.4l3.5 3.5v5.4l-3.5 3.5H5.3l-3.5-3.5V5.3z" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linejoin="round"/><path d="M8 4.8v3.8M8 10.8v.1" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>'],
    ABSTRACT: ['核心要点', '<path d="M3 3.5h10M3 6.5h10M3 9.5h7M3 12.5h5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>']
  };

  /* ================= 顶部分类 & 侧边栏 ================= */
  var TAB_GROUPS = [
    { title: 'Java 与框架', ids: ['java', 'spring', 'cs'] },
    { title: '数据存储', ids: ['mysql', 'pg', 'redis', 'db', 'bigdata'] },
    { title: '中间件与物联网', ids: ['mw', 'iot'] },
    { title: '分布式与架构', ids: ['distributed', 'design'] },
    { title: '运维与安全', ids: ['infra', 'security'] },
    { title: 'AI', ids: ['ai', 'aimodel'] }
  ];
  (function buildTabs() {
    var byId = {}, used = {};
    NAV.forEach(function (c) { byId[c.id] = c; });
    var groups = TAB_GROUPS.map(function (g) {
      return { title: g.title, cats: g.ids.filter(function (id) { return byId[id]; }).map(function (id) { used[id] = 1; return byId[id]; }) };
    }).filter(function (g) { return g.cats.length; });
    var rest = NAV.filter(function (c) { return !used[c.id]; });
    if (rest.length) groups.push({ title: '更多', cats: rest });
    $('tabs').innerHTML = groups.map(function (g, i) {
      return '<button type="button" class="tab" data-group="' + i + '" aria-haspopup="true">' + esc(g.title) + '<svg class="tab-caret" viewBox="0 0 10 6" width="9" height="6"><path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></button>';
    }).join('');
    var menus = document.createElement('div');
    menus.id = 'tabMenus';
    menus.innerHTML = groups.map(function (g, i) {
      return '<div class="tab-menu" data-group="' + i + '" hidden>' + g.cats.map(function (c) {
        return '<a data-cat="' + c.id + '" href="#/' + c.pages[0].path + '"><b>' + esc(c.title) + '</b><small>' + esc(c.desc) + ' · ' + c.pages.length + ' 篇</small></a>';
      }).join('') + '</div>';
    }).join('');
    document.querySelector('.topbar').appendChild(menus);
    var openIdx = -1, timer = null;
    function close() { openIdx = -1; menus.querySelectorAll('.tab-menu').forEach(function (m) { m.hidden = true; }); document.querySelectorAll('.tab.open').forEach(function (t) { t.classList.remove('open'); }); }
    function open(i) {
      clearTimeout(timer);
      if (openIdx === i) return;
      close(); openIdx = i;
      var tab = document.querySelector('.tab[data-group="' + i + '"]'), m = menus.querySelector('.tab-menu[data-group="' + i + '"]');
      var tr = tab.getBoundingClientRect(), bw = document.querySelector('.topbar').getBoundingClientRect().width;
      m.hidden = false; tab.classList.add('open');
      m.style.left = Math.max(8, Math.min(tr.left, bw - m.offsetWidth - 8)) + 'px';
    }
    function later() { clearTimeout(timer); timer = setTimeout(close, 160); }
    document.querySelectorAll('.tab').forEach(function (t) {
      var i = +t.dataset.group;
      t.addEventListener('mouseenter', function () { open(i); });
      t.addEventListener('mouseleave', later);
      t.addEventListener('click', function (e) { e.stopPropagation(); open(i); });
    });
    menus.addEventListener('mouseenter', function () { clearTimeout(timer); });
    menus.addEventListener('mouseleave', later);
    menus.addEventListener('click', close);
    document.addEventListener('click', close);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
    window.__tabGroups = groups;
  })();

  function renderNavItems(items, depth) {
    return items.map(function (n) {
      if (!n.children) {
        return '<a class="nav-link" href="#/' + n.path + '" data-path="' + n.path + '">' + esc(n.title) + '</a>';
      }
      if (depth === 0) {
        var count = 0;
        (function c(xs) { xs.forEach(function (x) { if (x.children) c(x.children); else count++; }); })(n.children);
        return '<div class="nav-section"><div class="nav-label"><span>' + esc(n.title) + '</span><span>' + count + '</span></div>' +
          renderNavItems(n.children, depth + 1) + '</div>';
      }
      return '<div class="nav-group"><button class="nav-head">' + ICON.chev + '<span>' + esc(n.title) + '</span></button>' +
        '<div class="nav-children">' + renderNavItems(n.children, depth + 1) + '</div></div>';
    }).join('');
  }

  var navCat = undefined;
  function renderSidebar(cat) {
    if (navCat === cat) return;
    navCat = cat;
    if (!cat) {
      $('sideHead').innerHTML = '<div class="kicker">Knowledge Base</div><h2>全部分类</h2><p>' + pages.length + ' 篇笔记，按技术领域组织。</p>';
      navEl.innerHTML = NAV.map(function (c) {
        return '<a class="nav-cat" href="#/' + c.pages[0].path + '"><b>' + esc(c.title) + '</b><small>' + esc(c.desc) + ' · ' + c.pages.length + ' 篇</small></a>';
      }).join('');
      return;
    }
    $('sideHead').innerHTML = '<div class="side-cats">' + NAV.map(function (c) {
      return '<a class="' + (c === cat ? 'on' : '') + '" href="#/' + c.pages[0].path + '">' + esc(c.title) + '</a>';
    }).join('') + '</div>' +
      '<div class="kicker">分类</div><h2>' + esc(cat.title) + '</h2><p>' + esc(cat.desc) + '</p>' +
      '<span class="count">' + cat.pages.length + ' 篇笔记</span>';
    navEl.innerHTML = renderNavItems(cat.children, 0);
  }
  navEl.addEventListener('click', function (e) {
    var h = e.target.closest('.nav-head');
    if (h) h.parentElement.classList.toggle('open');
  });

  function markActive(path, cat) {
    var gs = window.__tabGroups || [];
    document.querySelectorAll('.tab').forEach(function (t) {
      var g = gs[+t.dataset.group];
      t.classList.toggle('active', !!cat && !!g && g.cats.indexOf(cat) >= 0);
    });
    document.querySelectorAll('#tabMenus a').forEach(function (a) { a.classList.toggle('on', !!cat && a.dataset.cat === cat.id); });
    var prev = navEl.querySelector('.nav-link.active');
    if (prev) prev.classList.remove('active');
    var a = navEl.querySelector('.nav-link[data-path="' + path + '"]');
    if (!a) return;
    a.classList.add('active');
    for (var el = a.parentElement; el && el !== navEl; el = el.parentElement) {
      if (el.classList.contains('nav-group')) el.classList.add('open');
    }
    var box = $('sidebar'), r = a.getBoundingClientRect(), br = box.getBoundingClientRect();
    if (r.top < br.top + 60 || r.bottom > br.bottom - 40) a.scrollIntoView({ block: 'center' });
  }

  /* ================= Markdown ================= */
  marked.use({
    gfm: true,
    renderer: {
      code: function (code, info) {
        var lang = (info || '').trim().split(/\s+/)[0].toLowerCase();
        var out = (lang && window.hljs && hljs.getLanguage(lang))
          ? hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
          : esc(code);
        return '<div class="code' + (lang ? '' : ' plain') + '"><div class="code-bar"><span class="dots"><i></i><i></i><i></i></span>' +
          '<span class="lang">' + esc(lang || '') + '</span><button class="copy-btn" type="button">复制</button></div>' +
          '<pre><code class="hljs">' + out + '</code></pre></div>';
      }
    }
  });

  function parseFront(md) {
    var meta = {}, m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(md);
    if (!m) return { meta: meta, body: md };
    m[1].split(/\r?\n/).forEach(function (line) {
      var kv = /^(\w+)\s*:\s*(.*)$/.exec(line);
      if (!kv) return;
      var v = kv[2].trim();
      if (/^\[.*\]$/.test(v)) v = v.slice(1, -1).split(',').map(function (s) { return s.trim().replace(/^['"]|['"]$/g, ''); }).filter(Boolean);
      else v = v.replace(/^['"]|['"]$/g, '');
      meta[kv[1]] = v;
    });
    return { meta: meta, body: md.slice(m[0].length) };
  }

  function fetchDoc(path) {
    if (cache[path] !== undefined) return Promise.resolve(cache[path]);
    return fetch('docs/' + path + '.md').then(function (r) {
      if (!r.ok) throw new Error(r.status);
      return r.text();
    }).then(function (t) { cache[path] = t; return t; });
  }

  function slugify(s, used) {
    var base = s.trim().toLowerCase().replace(/[^\w一-龥]+/g, '-').replace(/^-+|-+$/g, '') || 'section';
    var id = base, i = 1;
    while (used[id]) id = base + '-' + (++i);
    used[id] = true;
    return id;
  }

  function transformCallouts(root) {
    root.querySelectorAll('blockquote').forEach(function (bq) {
      var p = bq.firstElementChild;
      if (!p || p.tagName !== 'P') return;
      var m = /^\s*\[!(\w+)\][ \t]*([^\n]*)(?:\n|$)/.exec(p.innerHTML);
      if (!m) return;
      var type = m[1].toUpperCase(), title = m[2].trim();
      var rest = p.innerHTML.slice(m[0].length);
      if (rest.trim()) p.innerHTML = rest; else p.remove();

      if (type === 'QUESTION') {
        var d = document.createElement('details');
        d.className = 'qa';
        d.innerHTML = '<summary><span class="q">Q</span><span class="qt">' + (title || '面试追问') + '</span>' + ICON.chev + '</summary><div class="qa-body"></div>';
        var body = d.querySelector('.qa-body');
        while (bq.firstChild) body.appendChild(bq.firstChild);
        bq.replaceWith(d);
        return;
      }
      var def = CALLOUT[type] || CALLOUT.NOTE;
      var box = document.createElement('div');
      box.className = 'callout callout-' + (CALLOUT[type] ? type : 'NOTE');
      box.innerHTML = '<div class="callout-title"><svg viewBox="0 0 16 16" width="16" height="16">' + def[1] + '</svg><span>' + (title || def[0]) + '</span></div>';
      while (bq.firstChild) box.appendChild(bq.firstChild);
      bq.replaceWith(box);
    });

    // 连续的追问前加「全部展开」
    var qas = root.querySelectorAll('.qa');
    if (qas.length > 1) {
      var bar = document.createElement('div');
      bar.className = 'qa-tools';
      bar.innerHTML = '<button type="button">全部展开</button>';
      qas[0].parentNode.insertBefore(bar, qas[0]);
      bar.firstChild.addEventListener('click', function () {
        var open = this.textContent === '全部展开';
        root.querySelectorAll('.qa').forEach(function (q) { q.open = open; });
        this.textContent = open ? '全部收起' : '全部展开';
      });
    }
  }

  // CommonMark 中「**含全角标点结尾**紧跟汉字」不会被识别为加粗，这里补一遍
  function fixStrong(root) {
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        if (n.nodeValue.indexOf('**') < 0) return NodeFilter.FILTER_REJECT;
        return n.parentElement.closest('code, pre, svg, script, style') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      }
    });
    var nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(function (n) {
      var parts = n.nodeValue.split(/\*\*([^*\n]+?)\*\*/);
      if (parts.length < 3) return;
      var frag = document.createDocumentFragment();
      parts.forEach(function (s, i) {
        if (i % 2) { var b = document.createElement('strong'); b.textContent = s; frag.appendChild(b); }
        else if (s) frag.appendChild(document.createTextNode(s));
      });
      n.parentNode.replaceChild(frag, n);
    });
  }

  function enhance(path) {
    fixStrong(content);
    transformCallouts(content);
    content.querySelectorAll('table').forEach(function (t) {
      var w = document.createElement('div');
      w.className = 'table-wrap';
      t.parentNode.insertBefore(w, t);
      w.appendChild(t);
    });
    content.querySelectorAll('a[href]').forEach(function (a) {
      var h = a.getAttribute('href');
      if (/^https?:/.test(h)) { a.target = '_blank'; a.rel = 'noopener'; }
      else if (/^#[^/]/.test(h)) a.setAttribute('href', '#/' + path + h);
      else if (/^#\//.test(h)) {
        var target = h.slice(2).split('#')[0];
        if (target !== 'index' && !byPath[target]) {   // 目标笔记尚未发布
          a.classList.add('soon');
          a.title = '该笔记编写中';
          a.removeAttribute('href');
        }
      }
    });
  }

  /* ================= 文章头 / 目录 / 翻页 ================= */
  function readingMinutes(el) {
    var t = el.textContent || '';
    var cjk = (t.match(/[一-龥]/g) || []).length;
    var words = (t.replace(/[一-龥]/g, ' ').match(/[A-Za-z0-9_]+/g) || []).length;
    return Math.max(1, Math.round(cjk / 450 + words / 220));
  }

  function renderHead(p, meta, h1) {
    var title = h1 ? h1.textContent : p.title;
    var figs = content.querySelectorAll('figure.fig').length;
    var qas = content.querySelectorAll('.qa').length;
    var tags = Array.isArray(meta.tags) ? meta.tags : (meta.tags ? [meta.tags] : []);
    var html = '<h1>' + esc(title) + '</h1>';
    if (meta.summary) html += '<p class="summary">' + esc(meta.summary) + '</p>';
    html += '<div class="meta">';
    if (meta.level) html += '<span class="lv lv-' + esc(meta.level) + '">' + esc(meta.level) + '</span>';
    html += '<span class="m">' + ICON.clock + '约 ' + readingMinutes(content) + ' 分钟</span>';
    if (figs) html += '<span class="m">' + ICON.fig + figs + ' 张图解</span>';
    if (qas) html += '<span class="m">' + ICON.qa + qas + ' 道追问</span>';
    if (tags.length) html += '<span class="tags">' + tags.map(function (t) { return '<span class="tag">' + esc(t) + '</span>'; }).join('') + '</span>';
    html += '</div>';
    docHead.innerHTML = html;
    if (h1) h1.remove();
    return title;
  }

  function buildToc(path) {
    var used = {}, heads = content.querySelectorAll('h2, h3');
    if (spy) spy.disconnect();
    if (heads.length < 2) { tocEl.innerHTML = ''; return; }
    var html = '<h4>本页目录</h4>';
    heads.forEach(function (h) {
      h.id = slugify(h.textContent, used);
      var href = '#/' + path + '#' + h.id;
      h.insertAdjacentHTML('afterbegin', '<a class="anchor" href="' + href + '" aria-hidden="true">#</a>');
      html += '<a href="' + href + '" data-id="' + h.id + '" class="' + (h.tagName === 'H3' ? 'l3' : 'l2') + '">' + esc(h.textContent.replace(/^#/, '')) + '</a>';
    });
    html += '<a class="back-top" href="#/' + path + '">↑ 回到顶部</a>';
    tocEl.innerHTML = html;
    var links = tocEl.querySelectorAll('a[data-id]');
    spy = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        links.forEach(function (l) { l.classList.toggle('active', l.dataset.id === en.target.id); });
      });
    }, { rootMargin: '-72px 0px -72% 0px' });
    heads.forEach(function (h) { spy.observe(h); });
  }

  function buildPager(path) {
    var i = pages.findIndex(function (p) { return p.path === path; });
    var html = '';
    if (i > 0) html += '<a class="prev" href="#/' + pages[i - 1].path + '"><small>← 上一篇 · ' + esc(pages[i - 1].cat.title) + '</small><b>' + esc(pages[i - 1].title) + '</b></a>';
    if (i >= 0 && i < pages.length - 1) html += '<a class="next" href="#/' + pages[i + 1].path + '"><small>' + esc(pages[i + 1].cat.title) + ' · 下一篇 →</small><b>' + esc(pages[i + 1].title) + '</b></a>';
    $('pager').innerHTML = html;
  }

  function buildCrumbs(p) {
    var parts = ['<a href="#/index">首页</a>'];
    if (p) {
      parts.push('<a href="#/' + p.cat.pages[0].path + '">' + esc(p.cat.title) + '</a>');
      p.trail.forEach(function (t) { parts.push('<span>' + esc(t) + '</span>'); });
    }
    $('crumbs').innerHTML = parts.join('<span class="sep">/</span>');
  }

  /* ================= 首页 ================= */
  function renderHome() {
    var cats = $('home-cats');
    if (cats) {
      cats.className = 'cat-grid';
      cats.innerHTML = NAV.map(function (c) {
        var groups = c.children.map(function (g) { return g.title; }).slice(0, 6);
        return '<a class="cat-card" href="#/' + c.pages[0].path + '"><div class="ch"><b>' + esc(c.title) + '</b><span class="n">' + c.pages.length + ' 篇</span></div>' +
          '<p>' + esc(c.desc) + '</p><ul>' + groups.map(function (g) { return '<li>' + esc(g) + '</li>'; }).join('') + '</ul></a>';
      }).join('');
    }
    var stats = $('home-stats');
    if (!stats) return;
    stats.className = 'stats';
    var set = function (figs, qas) {
      stats.innerHTML = [[NAV.length, '技术分类'], [pages.length, '篇深度笔记'], [figs, '张原理图解'], [qas, '道面试追问']]
        .map(function (s) { return '<div class="stat"><b>' + s[0] + '</b><span>' + s[1] + '</span></div>'; }).join('');
    };
    set('…', '…');
    ensureIndex().then(function () {
      var figs = 0, qas = 0;
      docs.forEach(function (d) { figs += d.f; qas += d.q; });
      if ($('home-stats') === stats) set(figs, qas);
    });
  }

  /* ================= 路由 ================= */
  function parseHash() {
    var h = decodeURIComponent(location.hash || '');
    if (h.indexOf('#/') !== 0) return { path: 'index', anchor: '' };
    var rest = h.slice(2), k = rest.indexOf('#');
    return { path: k >= 0 ? rest.slice(0, k) : rest, anchor: k >= 0 ? rest.slice(k + 1) : '' };
  }

  function scrollToAnchor(anchor, smooth) {
    if (!anchor) return false;
    var t = document.getElementById(anchor);
    if (t) t.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto' });
    return !!t;
  }

  function route() {
    var r = parseHash(), path = r.path;
    if (path !== 'index' && !byPath[path]) path = 'index';
    if (path === current.path) { scrollToAnchor(r.anchor, true); return; }
    current.path = path;
    document.body.classList.remove('nav-open');
    var p = byPath[path] || null;
    renderSidebar(p ? p.cat : null);
    markActive(path, p ? p.cat : null);

    var file = path === 'index' ? 'index' : path;
    fetchDoc(file).then(function (md) {
      if (current.path !== path) return;
      var fm = parseFront(md);
      content.innerHTML = marked.parse(fm.body);
      enhance(path);
      buildCrumbs(p);
      if (p) {
        var title = renderHead(p, fm.meta, content.querySelector('h1'));
        document.title = title + ' · ' + SITE;
        buildPager(path);
      } else {
        docHead.innerHTML = '';
        document.title = SITE;
        $('pager').innerHTML = '';
        renderHome();
      }
      buildToc(path);
      if (!scrollToAnchor(r.anchor, false)) window.scrollTo(0, 0);
      updateProgress();
    }).catch(function () {
      docHead.innerHTML = '<h1>页面未找到</h1>';
      content.innerHTML = '<p>无法加载 <code>docs/' + esc(file) + '.md</code>，这篇笔记可能还在编写中。</p>';
      tocEl.innerHTML = ''; $('pager').innerHTML = '';
    });
  }
  window.addEventListener('hashchange', route);

  /* ================= 交互：复制 / 图解放大 ================= */
  content.addEventListener('click', function (e) {
    var btn = e.target.closest('.copy-btn');
    if (btn) {
      var txt = btn.closest('.code').querySelector('code').innerText;
      var done = function () { btn.textContent = '已复制'; setTimeout(function () { btn.textContent = '复制'; }, 1400); };
      if (navigator.clipboard) navigator.clipboard.writeText(txt).then(done, done); else done();
      return;
    }
    var fig = e.target.closest('figure.fig');
    if (fig && !e.target.closest('a')) {
      var lb = $('lightbox');
      lb.innerHTML = '';
      lb.appendChild(fig.cloneNode(true));
      lb.hidden = false;
    }
  });
  $('lightbox').addEventListener('click', function () { this.hidden = true; this.innerHTML = ''; });

  /* ================= 阅读进度 ================= */
  function updateProgress() {
    var d = document.documentElement, max = d.scrollHeight - d.clientHeight;
    $('progress').style.width = (max > 0 ? Math.min(100, d.scrollTop / max * 100) : 0) + '%';
  }
  window.addEventListener('scroll', updateProgress, { passive: true });

  /* ================= 搜索 ================= */
  var palette = $('palette'), searchEl = $('search'), resultsEl = $('results');
  var indexReady = null, docs = null, activeIdx = -1;

  function plain(md) {
    return md.replace(/<figure[\s\S]*?<\/figure>/g, ' ')
      .replace(/```\w*/g, ' ').replace(/<[^>]+>/g, ' ')
      .replace(/\[!(\w+)\]/g, ' ').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/[#>*`|_]+/g, ' ').replace(/-{3,}/g, ' ').replace(/\s+/g, ' ');
  }
  function ensureIndex() {
    if (!indexReady) {
      // 优先使用构建好的单文件索引（tools/build_index.py）；索引里缺的页面再单独拉取，失败则回退为逐页加载
      indexReady = fetch('assets/search-index.json').then(function (r) {
        if (!r.ok) throw new Error('no index');
        return r.json();
      }).catch(function () { return null; }).then(function (idx) {
        var pre = (idx && idx.docs) || {};
        return Promise.all(pages.map(function (p) {
          if (pre[p.path]) return pre[p.path];
          return fetchDoc(p.path).then(function (md) {
            var fm = parseFront(md || '');
            var tags = Array.isArray(fm.meta.tags) ? fm.meta.tags.join(' ') : (fm.meta.tags || '');
            return {
              t: tags.toLowerCase(), x: plain(fm.body),
              f: (fm.body.match(/<figure class="fig"/g) || []).length,
              q: (fm.body.match(/^>\s*\[!QUESTION\]/gm) || []).length
            };
          }).catch(function () { return { t: '', x: '' }; });
        })).then(function (list) {
          docs = pages.map(function (p, i) { return { p: p, text: list[i].x, tags: list[i].t, f: list[i].f || 0, q: list[i].q || 0 }; });
        });
      });
    }
    return indexReady;
  }

  function openSearch() {
    palette.hidden = false;
    searchEl.focus(); searchEl.select();
    ensureIndex().then(doSearch);
  }
  function closeSearch() { palette.hidden = true; }

  function doSearch() {
    var q = searchEl.value.trim().toLowerCase();
    activeIdx = -1;
    if (!q) {
      resultsEl.innerHTML = '<div class="grp">快速跳转</div>' + NAV.map(function (c) {
        return '<a href="#/' + c.pages[0].path + '"><span class="r-title">' + esc(c.title) + '</span><span class="r-path">' + esc(c.desc) + '</span></a>';
      }).join('');
      return;
    }
    if (!docs) { resultsEl.innerHTML = '<div class="empty">正在建立索引…</div>'; return; }
    var terms = q.split(/\s+/).filter(Boolean);
    var hits = [];
    docs.forEach(function (d) {
      var title = d.p.title.toLowerCase(), low = d.text.toLowerCase(), score = 0, firstPos = -1;
      for (var i = 0; i < terms.length; i++) {
        var t = terms[i], s = 0;
        if (title.indexOf(t) >= 0) s += 100;
        if (d.tags.indexOf(t) >= 0) s += 40;
        var pos = low.indexOf(t);
        if (pos >= 0) { s += 10 + Math.min(20, low.split(t).length); if (firstPos < 0) firstPos = pos; }
        if (!s) return;          // 所有关键词都要命中
        score += s;
      }
      var snip = '';
      if (firstPos >= 0) {
        var st = Math.max(0, firstPos - 30), en = Math.min(d.text.length, firstPos + 90);
        snip = (st > 0 ? '…' : '') + esc(d.text.slice(st, en)) + (en < d.text.length ? '…' : '');
        terms.forEach(function (t) {
          var re = new RegExp(esc(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig');
          snip = snip.replace(re, '<mark>$&</mark>');
        });
      }
      hits.push({ p: d.p, score: score, snip: snip });
    });
    hits.sort(function (a, b) { return b.score - a.score; });
    if (!hits.length) { resultsEl.innerHTML = '<div class="empty">没有找到「' + esc(q) + '」相关内容</div>'; return; }
    var html = '', lastCat = null;
    hits.slice(0, 20).forEach(function (h) {
      if (h.p.cat !== lastCat) { html += '<div class="grp">' + esc(h.p.cat.title) + '</div>'; lastCat = h.p.cat; }
      html += '<a href="#/' + h.p.path + '"><span class="r-title">' + esc(h.p.title) + '</span><span class="r-path">' +
        esc(h.p.trail.join(' / ')) + '</span>' + (h.snip ? '<div class="r-snip">' + h.snip + '</div>' : '') + '</a>';
    });
    resultsEl.innerHTML = html;
  }

  searchEl.addEventListener('input', doSearch);
  searchEl.addEventListener('keydown', function (e) {
    var items = resultsEl.querySelectorAll('a');
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!items.length) return;
      e.preventDefault();
      activeIdx = (activeIdx + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items.forEach(function (a, i) { a.classList.toggle('active', i === activeIdx); });
      items[activeIdx].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && items.length) {
      location.hash = items[Math.max(activeIdx, 0)].getAttribute('href');
      closeSearch();
    }
  });
  resultsEl.addEventListener('click', function (e) { if (e.target.closest('a')) closeSearch(); });
  palette.addEventListener('click', function (e) { if (e.target === palette) closeSearch(); });
  $('searchBtn').addEventListener('click', openSearch);

  document.addEventListener('keydown', function (e) {
    var typing = /INPUT|TEXTAREA/.test(document.activeElement.tagName);
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); palette.hidden ? openSearch() : closeSearch(); }
    else if (e.key === '/' && !typing && palette.hidden) { e.preventDefault(); openSearch(); }
    else if (e.key === 'Escape') {
      if (!palette.hidden) closeSearch();
      if (!$('lightbox').hidden) { $('lightbox').hidden = true; $('lightbox').innerHTML = ''; }
    }
  });

  /* ================= 主题 / 移动端菜单 ================= */
  $('themeBtn').addEventListener('click', function () {
    var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('theme', next); } catch (e) { /* 忽略 */ }
  });
  $('menuBtn').addEventListener('click', function () { document.body.classList.toggle('nav-open'); });
  $('scrim').addEventListener('click', function () { document.body.classList.remove('nav-open'); });

  route();
})();
