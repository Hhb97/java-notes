(function () {
  'use strict';

  var NAV = window.NAV;
  var $ = function (id) { return document.getElementById(id); };
  var content = $('content'), navEl = $('nav'), tocEl = $('toc');
  var cache = {};          // path -> markdown 文本
  var pages = [];          // 扁平化页面列表 {title, path, trail}
  var currentPath = null;
  var spy = null;

  /* ---------- 目录数据 ---------- */
  function flatten(items, trail) {
    items.forEach(function (n) {
      if (n.children) flatten(n.children, trail.concat(n.title));
      else pages.push({ title: n.title, path: n.path, trail: trail });
    });
  }
  flatten(NAV, []);
  var byPath = {};
  pages.forEach(function (p) { byPath[p.path] = p; });

  /* ---------- 渲染侧边栏 ---------- */
  function buildNav(items, parent) {
    items.forEach(function (n) {
      if (n.children) {
        var g = document.createElement('div');
        g.className = 'nav-group';
        var h = document.createElement('button');
        h.className = 'nav-head';
        h.innerHTML = '<span class="arrow">▶</span><span></span>';
        h.lastChild.textContent = n.title;
        h.addEventListener('click', function () { g.classList.toggle('open'); });
        var c = document.createElement('div');
        c.className = 'nav-children';
        g.appendChild(h); g.appendChild(c);
        buildNav(n.children, c);
        parent.appendChild(g);
      } else {
        var a = document.createElement('a');
        a.className = 'nav-link' + (parent === navEl ? ' nav-top' : '');
        a.href = '#/' + n.path;
        a.dataset.path = n.path;
        a.textContent = n.title;
        parent.appendChild(a);
      }
    });
  }
  buildNav(NAV, navEl);

  function markActive(path) {
    var prev = navEl.querySelector('.nav-link.active');
    if (prev) prev.classList.remove('active');
    var a = navEl.querySelector('.nav-link[data-path="' + path + '"]');
    if (!a) return;
    a.classList.add('active');
    for (var el = a.parentElement; el && el !== navEl; el = el.parentElement) {
      if (el.classList.contains('nav-group')) el.classList.add('open');
    }
    var box = $('sidebar'), r = a.getBoundingClientRect(), br = box.getBoundingClientRect();
    if (r.top < br.top + 40 || r.bottom > br.bottom - 40) a.scrollIntoView({ block: 'center' });
  }

  /* ---------- Markdown ---------- */
  marked.use({
    gfm: true,
    renderer: {
      code: function (code, info) {
        var lang = (info || '').trim().split(/\s+/)[0];
        var out;
        if (lang && window.hljs && hljs.getLanguage(lang)) {
          out = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
        } else {
          out = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        }
        return '<pre><code class="hljs' + (lang ? ' language-' + lang : '') + '">' + out + '</code></pre>';
      }
    }
  });

  function fetchDoc(path) {
    if (cache[path] !== undefined) return Promise.resolve(cache[path]);
    return fetch('docs/' + path + '.md').then(function (r) {
      if (!r.ok) throw new Error(r.status);
      return r.text();
    }).then(function (t) { cache[path] = t; return t; });
  }

  function slug(s, used) {
    var base = s.trim().toLowerCase().replace(/[^\w\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '') || 'section';
    var id = base, i = 1;
    while (used[id]) id = base + '-' + (++i);
    used[id] = true;
    return id;
  }

  function enhance() {
    // 表格横向滚动容器
    content.querySelectorAll('table').forEach(function (t) {
      var w = document.createElement('div');
      w.className = 'table-wrap';
      t.parentNode.insertBefore(w, t);
      w.appendChild(t);
    });
    // 复制按钮
    content.querySelectorAll('pre').forEach(function (pre) {
      var b = document.createElement('button');
      b.className = 'copy-btn';
      b.textContent = '复制';
      b.addEventListener('click', function () {
        var txt = pre.querySelector('code').innerText;
        var done = function () { b.textContent = '已复制'; setTimeout(function () { b.textContent = '复制'; }, 1400); };
        if (navigator.clipboard) navigator.clipboard.writeText(txt).then(done, done); else done();
      });
      pre.appendChild(b);
    });
    // 站内链接：相对路径 .md 或 #/ 都走路由
    content.querySelectorAll('a[href]').forEach(function (a) {
      var h = a.getAttribute('href');
      if (/^https?:/.test(h)) { a.target = '_blank'; a.rel = 'noopener'; }
    });
  }

  function buildToc() {
    var used = {}, heads = content.querySelectorAll('h2, h3');
    if (spy) spy.disconnect();
    if (!heads.length) { tocEl.innerHTML = ''; return; }
    var html = '<h4>本页内容</h4>';
    heads.forEach(function (h) {
      h.id = slug(h.textContent, used);
      html += '<a href="#' + h.id + '" class="' + (h.tagName === 'H3' ? 'l3' : 'l2') + '">' +
        h.innerHTML.replace(/<[^>]+>/g, '') + '</a>';
    });
    tocEl.innerHTML = html;
    var links = tocEl.querySelectorAll('a');
    links.forEach(function (a) {
      a.addEventListener('click', function (e) {
        e.preventDefault();
        var t = document.getElementById(a.getAttribute('href').slice(1));
        if (t) t.scrollIntoView({ behavior: 'smooth' });
      });
    });
    spy = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        links.forEach(function (l) { l.classList.toggle('active', l.getAttribute('href') === '#' + en.target.id); });
      });
    }, { rootMargin: '-70px 0px -70% 0px' });
    heads.forEach(function (h) { spy.observe(h); });
  }

  function buildPager(path) {
    var i = pages.findIndex(function (p) { return p.path === path; });
    var html = '';
    if (i > 0) html += '<a class="prev" href="#/' + pages[i - 1].path + '"><small>← 上一篇</small>' + pages[i - 1].title + '</a>';
    else html += '<span class="spacer"></span>';
    if (i >= 0 && i < pages.length - 1) html += '<a class="next" href="#/' + pages[i + 1].path + '"><small>下一篇 →</small>' + pages[i + 1].title + '</a>';
    else html += '<span class="spacer"></span>';
    $('pager').innerHTML = html;
  }

  function buildCrumbs(path) {
    var p = byPath[path], parts = ['首页'];
    if (p && path !== 'index') parts = parts.concat(p.trail, [p.title]);
    $('crumbs').innerHTML = parts.map(function (s) { return '<span></span>'; }).join('');
    $('crumbs').querySelectorAll('span').forEach(function (el, i) { el.textContent = parts[i]; });
  }

  /* ---------- 路由 ---------- */
  function route() {
    var h = decodeURIComponent(location.hash || '');
    var path = h.indexOf('#/') === 0 ? h.slice(2) : 'index';
    if (!byPath[path]) path = 'index';
    if (path === currentPath) return;
    currentPath = path;
    document.body.classList.remove('nav-open');
    markActive(path);
    fetchDoc(path).then(function (md) {
      if (currentPath !== path) return;
      content.innerHTML = marked.parse(md);
      var t = content.querySelector('h1');
      document.title = (t && path !== 'index' ? t.textContent + ' · ' : '') + 'Java 学习笔记';
      enhance(); buildToc(); buildCrumbs(path); buildPager(path);
      window.scrollTo(0, 0);
    }).catch(function () {
      content.innerHTML = '<h1>页面未找到</h1><p>无法加载 <code>docs/' + path + '.md</code>。</p>';
      tocEl.innerHTML = ''; $('pager').innerHTML = '';
    });
  }
  window.addEventListener('hashchange', route);
  route();

  /* ---------- 搜索 ---------- */
  var searchEl = $('search'), resultsEl = $('results'), indexReady = null, activeIdx = -1;

  function ensureIndex() {
    if (!indexReady) indexReady = Promise.all(pages.map(function (p) { return fetchDoc(p.path).catch(function () { return ''; }); }));
    return indexReady;
  }
  function esc(s) { return s.replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }
  function plain(md) { return md.replace(/```[\w]*\n?/g, ' ').replace(/[#>*`|_\-]+/g, ' ').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' '); }

  function doSearch() {
    var q = searchEl.value.trim().toLowerCase();
    activeIdx = -1;
    if (!q) { resultsEl.hidden = true; return; }
    ensureIndex().then(function () {
      var hits = [];
      pages.forEach(function (p) {
        var text = plain(cache[p.path] || ''), low = text.toLowerCase();
        var inTitle = p.title.toLowerCase().indexOf(q) >= 0;
        var pos = low.indexOf(q);
        if (!inTitle && pos < 0) return;
        var snip = '';
        if (pos >= 0) {
          var s = Math.max(0, pos - 24), e = Math.min(text.length, pos + q.length + 70);
          snip = (s > 0 ? '…' : '') + esc(text.slice(s, e)) + (e < text.length ? '…' : '');
          var re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[&<>]/g, '.'), 'ig');
          snip = snip.replace(re, '<mark>$&</mark>');
        }
        hits.push({ p: p, score: (inTitle ? 100 : 0) - (pos < 0 ? 0 : pos / 1000), snip: snip });
      });
      hits.sort(function (a, b) { return b.score - a.score; });
      resultsEl.hidden = false;
      if (!hits.length) { resultsEl.innerHTML = '<div class="empty">没有找到「' + esc(q) + '」相关内容</div>'; return; }
      resultsEl.innerHTML = hits.slice(0, 12).map(function (h) {
        return '<a href="#/' + h.p.path + '"><div class="r-title">' + esc(h.p.title) + '</div><div class="r-path">' +
          esc(h.p.trail.join(' / ')) + '</div>' + (h.snip ? '<div class="r-snip">' + h.snip + '</div>' : '') + '</a>';
      }).join('');
    });
  }
  searchEl.addEventListener('input', doSearch);
  searchEl.addEventListener('focus', function () { ensureIndex(); if (searchEl.value) doSearch(); });
  searchEl.addEventListener('keydown', function (e) {
    var items = resultsEl.querySelectorAll('a');
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!items.length) return;
      e.preventDefault();
      activeIdx = (activeIdx + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items.forEach(function (a, i) { a.classList.toggle('active', i === activeIdx); });
    } else if (e.key === 'Enter' && items.length) {
      location.hash = (items[Math.max(activeIdx, 0)]).getAttribute('href');
      resultsEl.hidden = true; searchEl.blur();
    } else if (e.key === 'Escape') { resultsEl.hidden = true; searchEl.blur(); }
  });
  document.addEventListener('click', function (e) {
    if (!e.target.closest('.search')) resultsEl.hidden = true;
    else if (e.target.closest('.results a')) { resultsEl.hidden = true; }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === '/' && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) { e.preventDefault(); searchEl.focus(); }
  });

  /* ---------- 主题 / 移动端菜单 ---------- */
  $('themeBtn').addEventListener('click', function () {
    var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('theme', next); } catch (e) { /* ignore */ }
  });
  $('menuBtn').addEventListener('click', function () { document.body.classList.toggle('nav-open'); });
  $('scrim').addEventListener('click', function () { document.body.classList.remove('nav-open'); });
})();
