// Shared blog helpers: inline-SVG chart generator, social share, and the
// /blog/index.html search + category filter. Extends the same inline-SVG
// approach as learn.html's buildSVGChart (no image assets, no build step).

function renderBlogChart(elId, data, opts) {
  opts = opts || {};
  const el = document.getElementById(elId);
  if (!el) return;
  el.innerHTML = opts.type === 'candlestick' ? buildCandlestickSVG(data) : buildLineSVG(data);
}

function buildLineSVG(data) {
  const w = 640, h = 220, pad = 20;
  const min = Math.min(...data) - 2, max = Math.max(...data) + 2;
  const xStep = (w - pad * 2) / (data.length - 1);
  const y = v => h - pad - ((v - min) / (max - min)) * (h - pad * 2);
  const pts = data.map((v, i) => `${pad + i * xStep},${y(v)}`).join(' ');
  const area = data.map((v, i) => `${pad + i * xStep},${y(v)}`).join(' L ');
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet">
<defs><linearGradient id="bcg" x1="0" y1="0" x2="0" y2="1">
<stop offset="0%" stop-color="#16d97e" stop-opacity="0.3"/>
<stop offset="100%" stop-color="#16d97e" stop-opacity="0"/>
</linearGradient></defs>
<path d="M ${area} L ${pad + (data.length - 1) * xStep},${h - pad} L ${pad},${h - pad} Z" fill="url(#bcg)"/>
<polyline points="${pts}" fill="none" stroke="#16d97e" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
${data.map((v, i) => i === data.length - 1 ? `<circle cx="${pad + i * xStep}" cy="${y(v)}" r="5" fill="#16d97e"/>` : '').join('')}
</svg>`;
}

// candles: [{o,h,l,c}, ...]
function buildCandlestickSVG(candles) {
  const w = 640, h = 220, pad = 20;
  const allVals = candles.flatMap(c => [c.o, c.h, c.l, c.c]);
  const min = Math.min(...allVals) - 1, max = Math.max(...allVals) + 1;
  const xStep = (w - pad * 2) / candles.length;
  const bodyW = Math.max(4, xStep * 0.55);
  const y = v => h - pad - ((v - min) / (max - min)) * (h - pad * 2);
  const bars = candles.map((c, i) => {
    const cx = pad + xStep * i + xStep / 2;
    const up = c.c >= c.o;
    const color = up ? '#16d97e' : '#f54242';
    const bodyTop = y(Math.max(c.o, c.c));
    const bodyBot = y(Math.min(c.o, c.c));
    const bodyH = Math.max(2, bodyBot - bodyTop);
    return `<line x1="${cx}" y1="${y(c.h)}" x2="${cx}" y2="${y(c.l)}" stroke="${color}" stroke-width="1.5"/>
<rect x="${cx - bodyW / 2}" y="${bodyTop}" width="${bodyW}" height="${bodyH}" fill="${color}"/>`;
  }).join('\n');
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet">${bars}</svg>`;
}

// --- Social share row ---

function blogShareX(title, url) {
  const u = `https://twitter.com/intent/tweet?text=${encodeURIComponent(title)}&url=${encodeURIComponent(url)}`;
  window.open(u, '_blank', 'noopener,noreferrer,width=560,height=480');
}

function blogShareLinkedIn(url) {
  const u = `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}`;
  window.open(u, '_blank', 'noopener,noreferrer,width=560,height=560');
}

function blogCopyLink(btn, url) {
  navigator.clipboard.writeText(url).then(() => {
    const original = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = original; }, 1800);
  });
}

// --- /blog/index.html + /blog/category/* shared rendering ---
// Both pages read from the same /blog/posts.json — that's the single source
// of truth for post content, so a new post or category shows up everywhere
// (index, its category page, category tabs) without touching any HTML.

const BLOG_PAGE_SIZE = 6;

// Must match how the existing /blog/category/*.html filenames were named —
// "Trading Education" -> "trading-education" — so a category page's URL
// slug can be matched back to the category strings in posts.json.
function slugifyCategory(cat) {
  return cat.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function postCardHTML(p) {
  return `<a class="post-card" href="/blog/${p.slug}">
    <span class="post-cat">${p.category}</span>
    <h3>${p.title}</h3>
    <p>${p.excerpt}</p>
    <span class="post-date">${p.date}</span>
  </a>`;
}

function pagerHTML(page, totalPages) {
  if (totalPages <= 1) return '';
  return `<div class="post-pager">
    <button type="button" class="pager-btn" id="pagerPrev" ${page <= 1 ? 'disabled' : ''}>&larr; Prev</button>
    <span class="pager-info">Page ${page} of ${totalPages}</span>
    <button type="button" class="pager-btn" id="pagerNext" ${page >= totalPages ? 'disabled' : ''}>Next &rarr;</button>
  </div>`;
}

function getPageParam() {
  return Math.max(1, parseInt(new URLSearchParams(location.search).get('page') || '1', 10) || 1);
}

function setPageParam(p) {
  const url = new URL(location.href);
  if (p <= 1) url.searchParams.delete('page'); else url.searchParams.set('page', p);
  history.replaceState(null, '', url);
}

// Renders `items` into `grid` for the given `page`, wires the pager buttons
// into `pagerWrap`, and returns the (possibly clamped) page number so the
// caller's state stays in sync.
function renderPostPage(grid, pagerWrap, items, page, emptyMsg, onPageChange) {
  const totalPages = Math.max(1, Math.ceil(items.length / BLOG_PAGE_SIZE));
  page = Math.min(page, totalPages);
  const pageItems = items.slice((page - 1) * BLOG_PAGE_SIZE, page * BLOG_PAGE_SIZE);

  grid.innerHTML = pageItems.length
    ? pageItems.map(postCardHTML).join('')
    : `<p class="post-empty">${emptyMsg}</p>`;

  if (pagerWrap) {
    pagerWrap.innerHTML = pagerHTML(page, totalPages);
    const prevBtn = document.getElementById('pagerPrev');
    const nextBtn = document.getElementById('pagerNext');
    if (prevBtn) prevBtn.addEventListener('click', () => onPageChange(page - 1));
    if (nextBtn) nextBtn.addEventListener('click', () => onPageChange(page + 1));
  }
  return page;
}

function initBlogIndex() {
  const grid = document.getElementById('postGrid');
  const search = document.getElementById('blogSearch');
  const tabsWrap = document.getElementById('catTabs');
  const pagerWrap = document.getElementById('postPager');
  if (!grid) return;

  fetch('/blog/posts.json').then(r => r.json()).then(posts => {
    let activeCategory = 'all';
    let page = getPageParam();

    // Tabs are built from whatever categories actually exist in posts.json,
    // not hardcoded — a new category on a new post gets a tab automatically.
    const categories = [...new Set(posts.map(p => p.category))].sort();
    if (tabsWrap) {
      tabsWrap.innerHTML = ['<button type="button" class="cat-tab active" data-category="all">All Posts</button>']
        .concat(categories.map(c => `<button type="button" class="cat-tab" data-category="${c}">${c}</button>`))
        .join('');
    }
    const tabs = document.querySelectorAll('.cat-tab');

    function render() {
      const q = (search && search.value || '').trim().toLowerCase();
      const filtered = posts.filter(p => {
        const inCategory = activeCategory === 'all' || p.category === activeCategory;
        if (!inCategory) return false;
        if (!q) return true;
        const haystack = (p.title + ' ' + p.excerpt + ' ' + (p.keywords || []).join(' ')).toLowerCase();
        return haystack.includes(q);
      });
      page = renderPostPage(grid, pagerWrap, filtered, page, 'No articles match your search.', (p) => {
        page = p;
        setPageParam(page);
        render();
        grid.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }

    if (search) search.addEventListener('input', () => { page = 1; setPageParam(1); render(); });
    tabs.forEach(tab => tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      activeCategory = tab.dataset.category;
      page = 1;
      setPageParam(1);
      render();
    }));

    render();
  });
}

// --- /blog/category/*.html — one dynamic renderer for every category page ---
// The category (and its display name) come from the URL's last path segment
// matched against slugifyCategory(post.category), not from hardcoded markup,
// so /blog/category/<anything>.html works for categories that don't have any
// posts yet too (renders an honest "nothing here yet" state instead of 404).
function initCategoryPage() {
  const grid = document.getElementById('postGrid');
  const pagerWrap = document.getElementById('postPager');
  if (!grid) return;

  const slug = location.pathname.replace(/\/+$/, '').split('/').pop().replace(/\.html$/, '');

  fetch('/blog/posts.json').then(r => r.json()).then(posts => {
    const catPosts = posts.filter(p => slugifyCategory(p.category) === slug);
    const displayName = catPosts.length
      ? catPosts[0].category
      : slug.split('-').filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ');

    const h1 = document.getElementById('catH1');
    if (h1) h1.innerHTML = `${displayName.split(' ')[0]} <em>${displayName.split(' ').slice(1).join(' ') || displayName.split(' ')[0]}</em>`;
    const pageTitle = `${displayName} Articles · ScalpClock Blog`;
    document.title = pageTitle;
    const crumb = document.getElementById('catCrumb');
    if (crumb) crumb.textContent = displayName;

    const canonicalUrl = `https://scalpclock.com/blog/category/${slug}`;
    let canonicalLink = document.querySelector('link[rel="canonical"]');
    if (!canonicalLink) {
      canonicalLink = document.createElement('link');
      canonicalLink.setAttribute('rel', 'canonical');
      document.head.appendChild(canonicalLink);
    }
    canonicalLink.setAttribute('href', canonicalUrl);

    // Only the pages served through the generic fallback (no dedicated static
    // HTML) start noindexed — once a category actually has posts, index it.
    // A category with a hand-authored page never has this meta tag at all.
    const robotsMeta = document.querySelector('meta[name="robots"]');
    if (robotsMeta) robotsMeta.setAttribute('content', catPosts.length ? 'index,follow' : 'noindex,follow');

    const desc = catPosts.length
      ? `${displayName} articles from the ScalpClock blog.`
      : `${displayName} articles from the ScalpClock blog — coming soon.`;
    ['meta[name="description"]', 'meta[property="og:description"]', 'meta[name="twitter:description"]'].forEach(sel => {
      const el = document.querySelector(sel);
      if (el) el.setAttribute('content', desc);
    });
    ['meta[property="og:title"]', 'meta[name="twitter:title"]'].forEach(sel => {
      const el = document.querySelector(sel);
      if (el) el.setAttribute('content', pageTitle);
    });
    const ogUrl = document.querySelector('meta[property="og:url"]');
    if (ogUrl) ogUrl.setAttribute('content', canonicalUrl);
    else {
      const m = document.createElement('meta');
      m.setAttribute('property', 'og:url');
      m.setAttribute('content', canonicalUrl);
      document.head.appendChild(m);
    }

    // Both JSON-LD blocks are built here (not hand-written per category page)
    // so they can never drift from what's actually rendered — the same slug
    // resolution and post list drive the visible page and the structured data.
    const breadcrumbLD = document.createElement('script');
    breadcrumbLD.type = 'application/ld+json';
    breadcrumbLD.textContent = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://scalpclock.com/' },
        { '@type': 'ListItem', position: 2, name: 'Blog', item: 'https://scalpclock.com/blog' },
        { '@type': 'ListItem', position: 3, name: displayName, item: `https://scalpclock.com/blog/category/${slug}` },
      ],
    });
    document.head.appendChild(breadcrumbLD);

    if (catPosts.length) {
      const itemListLD = document.createElement('script');
      itemListLD.type = 'application/ld+json';
      itemListLD.textContent = JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'ItemList',
        itemListElement: catPosts.map((p, i) => ({
          '@type': 'ListItem', position: i + 1, url: `https://scalpclock.com/blog/${p.slug}`,
        })),
      });
      document.head.appendChild(itemListLD);
    }

    let page = getPageParam();
    function render() {
      page = renderPostPage(grid, pagerWrap, catPosts, page, 'No articles in this category yet — check back soon.', (p) => {
        page = p;
        setPageParam(page);
        render();
        grid.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
    render();
  });
}

// --- Email capture (shared backend: /api/waitlist) ---
// Mirrors maintenance.html's real fetch/validate/success/error handler.
// formId must contain elements with ids `${formId}Email`, `${formId}Btn`,
// `${formId}Msg`. `source` is passed through to the waitlist endpoint for
// segmentation (e.g. 'blog-article', 'landing-page').

function initEmailCapture(formId, source) {
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const form = document.getElementById(formId);
  if (!form) return;
  const input = document.getElementById(formId + 'Email');
  const btn = document.getElementById(formId + 'Btn');
  const msg = document.getElementById(formId + 'Msg');

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    const email = input.value.trim();

    msg.textContent = '';
    msg.className = 'email-capture-msg';

    if (!EMAIL_RE.test(email)) {
      msg.textContent = 'Please enter a valid email address.';
      msg.classList.add('is-error');
      return;
    }

    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Submitting…';

    try {
      const res = await fetch('/api/waitlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, source }),
      });
      const data = await res.json().catch(() => ({}));

      if (res.ok && data.ok) {
        msg.textContent = "You're subscribed — look out for new lessons in your inbox.";
        msg.classList.add('is-success');
        input.value = '';
        input.disabled = true;
        btn.textContent = 'Subscribed';
        btn.disabled = true;
      } else {
        msg.textContent = data.error || 'Please enter a valid email address.';
        msg.classList.add('is-error');
        btn.disabled = false;
        btn.textContent = original;
      }
    } catch (err) {
      msg.textContent = 'Something went wrong. Please try again.';
      msg.classList.add('is-error');
      btn.disabled = false;
      btn.textContent = original;
    }
  });
}
