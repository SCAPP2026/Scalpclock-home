// ── SC_LEARN — shared progress module for /learn-options-trading ──
// Reuses the SAME localStorage keys as learn.html / dashboard.html /
// scalpchart.html (sc_learn_xp, sc_earned_badges) so reading an SEO
// article awards real, cross-feature XP instead of a disconnected
// counter — see learn.html's getXP()/addXP()/earnBadge() for the
// canonical implementation this mirrors.
(function (global) {
  const LS = {
    get: (k, d) => { try { const v = localStorage.getItem(k); return v !== null ? JSON.parse(v) : d; } catch { return d; } },
    set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };

  const READ_KEY = 'sc_seo_articles_read';
  const ARTICLE_XP = 15;

  // Full designed size of each category (per the 30-article launch plan) —
  // used for "X/7 read" style progress bars so they reflect the eventual
  // curriculum, not just what's live today.
  const CATEGORY_TOTALS = {
    'options-basics': 7,
    'strategies': 5,
    'technical-analysis': 6,
    'scalping': 5,
    'psychology': 5,
  };

  // Slug -> category for every article that actually exists right now.
  // Add an entry here the moment a new article ships so progress tracking
  // picks it up automatically everywhere (hub + category pages).
  const ARTICLE_CATEGORY = {
    'options-basics/what-is-options-trading': 'options-basics',
    'strategies/best-options-strategies-for-beginners': 'strategies',
    'technical-analysis/how-to-read-candlestick-charts': 'technical-analysis',
    'scalping/what-is-options-scalping': 'scalping',
    'psychology/why-most-options-traders-fail': 'psychology',
  };

  const AVAILABLE_ARTICLES = Object.keys(ARTICLE_CATEGORY);

  function getXP() { return LS.get('sc_learn_xp', 0); }
  function addXP(n) { LS.set('sc_learn_xp', getXP() + n); }

  function getEarnedBadges() { return LS.get('sc_earned_badges', []); }
  function earnBadge(id) {
    const b = getEarnedBadges();
    if (!b.includes(id)) { b.push(id); LS.set('sc_earned_badges', b); return true; }
    return false;
  }

  function getReadArticles() { return LS.get(READ_KEY, []); }

  function readByCategory() {
    const read = getReadArticles();
    const out = {};
    for (const slug of read) {
      const cat = ARTICLE_CATEGORY[slug];
      if (cat) out[cat] = (out[cat] || 0) + 1;
    }
    return out;
  }

  // Call from an article page once the reader has genuinely engaged with
  // it (see article template's scroll-depth trigger). Returns the list of
  // newly-earned badges (empty if none) so the caller can show a toast.
  function markRead(slug) {
    const read = getReadArticles();
    if (read.includes(slug)) return [];
    read.push(slug);
    LS.set(READ_KEY, read);
    addXP(ARTICLE_XP);

    const newBadges = [];
    const distinctCategories = new Set(read.map(s => ARTICLE_CATEGORY[s]).filter(Boolean)).size;
    if (read.length >= 1 && earnBadge('seo_first_lesson')) newBadges.push({ icon: '🌱', name: 'First Lesson' });
    if (read.length >= 3 && earnBadge('seo_three_lessons')) newBadges.push({ icon: '📚', name: 'Getting Serious' });
    if (read.length >= AVAILABLE_ARTICLES.length && AVAILABLE_ARTICLES.length > 0 && earnBadge('seo_all_available')) newBadges.push({ icon: '🏆', name: 'Caught Up' });
    if (distinctCategories >= 3 && earnBadge('seo_explorer')) newBadges.push({ icon: '🧭', name: 'Explorer' });
    return newBadges;
  }

  global.SC_LEARN = {
    CATEGORY_TOTALS,
    ARTICLE_CATEGORY,
    AVAILABLE_ARTICLES,
    getXP,
    addXP,
    getEarnedBadges,
    earnBadge,
    getReadArticles,
    readByCategory,
    markRead,
  };
})(window);
