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

// --- /blog/index.html search + category filter ---

function initBlogIndex() {
  const grid = document.getElementById('postGrid');
  const search = document.getElementById('blogSearch');
  const tabs = document.querySelectorAll('.cat-tab');
  if (!grid) return;

  fetch('/blog/posts.json').then(r => r.json()).then(posts => {
    let activeCategory = 'all';

    function cardHTML(p) {
      return `<a class="post-card" href="/blog/${p.slug}">
        <span class="post-cat">${p.category}</span>
        <h3>${p.title}</h3>
        <p>${p.excerpt}</p>
        <span class="post-date">${p.date}</span>
      </a>`;
    }

    function render() {
      const q = (search && search.value || '').trim().toLowerCase();
      const filtered = posts.filter(p => {
        const inCategory = activeCategory === 'all' || p.category === activeCategory;
        if (!inCategory) return false;
        if (!q) return true;
        const haystack = (p.title + ' ' + p.excerpt + ' ' + (p.keywords || []).join(' ')).toLowerCase();
        return haystack.includes(q);
      });
      grid.innerHTML = filtered.length
        ? filtered.map(cardHTML).join('')
        : '<p class="post-empty">No articles match your search.</p>';
    }

    if (search) search.addEventListener('input', render);
    tabs.forEach(tab => tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      activeCategory = tab.dataset.category;
      render();
    }));

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
