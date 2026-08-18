/**
 * Shared nav + auth gate for /admin/linkhunter/*.html pages.
 * Mirrors the admin-referrals.html pattern: client-side check of
 * session.user.app_metadata.is_admin decides which view to render, and
 * every API call carries the bearer token — the server independently
 * re-verifies admin status on every request (never trusts this check).
 *
 * Usage: <script src="/js/linkhunter-nav.js"></script>
 *        <script>LinkHunterAuth.init('prospects').then(({ token, user }) => { ... });</script>
 * init() resolves only when the caller is a verified admin; otherwise it
 * redirects to /login or renders the deny view and never resolves.
 */
(function () {
  const SUPABASE_URL = 'https://fnuqxiflqqejjttxymbz.supabase.co';
  const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZudXF4aWZscXFlamp0dHh5bWJ6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI0MzMxODksImV4cCI6MjA5ODAwOTE4OX0.XE1-LPW0043gRFEAl9onCahkmpQ8BMAAtGkF9FqJLiY';

  const SECTIONS = [
    { key: 'dashboard',      label: 'Dashboard',      href: '/admin/linkhunter/dashboard' },
    { key: 'prospects',      label: 'Prospects',      href: '/admin/linkhunter/prospects' },
    { key: 'opportunities',  label: 'Opportunities',  href: '/admin/linkhunter/opportunities' },
    { key: 'outreach',       label: 'Outreach',       href: '/admin/linkhunter/outreach' },
    { key: 'backlinks',      label: 'Backlinks',      href: '/admin/linkhunter/backlinks' },
    { key: 'campaigns',      label: 'Campaigns',      href: '/admin/linkhunter/campaigns' },
    { key: 'content-assets', label: 'Content Assets', href: '/admin/linkhunter/content-assets' },
    { key: 'settings',       label: 'Settings',       href: '/admin/linkhunter/settings' },
  ];

  function renderShell(activeKey) {
    const links = SECTIONS.map(s =>
      `<a class="lh-nav-link${s.key === activeKey ? ' active' : ''}" href="${s.href}">${s.label}</a>`
    ).join('');

    document.body.insertAdjacentHTML('afterbegin', `
      <nav class="lh-nav">
        <div class="lh-nav-in">
          <span class="lh-nav-title">Link<span>Hunter</span> AI</span>
          <a class="lh-nav-back" href="/dashboard">&larr; ScalpClock Dashboard</a>
        </div>
        <div class="lh-nav-sub">${links}</div>
      </nav>
    `);

    const style = document.createElement('style');
    style.textContent = `
      .lh-nav{position:sticky;top:0;z-index:60;backdrop-filter:blur(14px);background:rgba(247,249,247,.92);border-bottom:1px solid var(--line);}
      .lh-nav-in{max-width:1200px;margin:0 auto;padding:0 24px;display:flex;align-items:center;justify-content:space-between;height:56px;}
      .lh-nav-title{font-family:var(--disp);font-weight:700;font-size:1.1rem;color:var(--text);}
      .lh-nav-title span{color:var(--green-ink);}
      .lh-nav-back{font-size:.8rem;color:var(--t65);text-decoration:none;}
      .lh-nav-back:hover{color:var(--text);}
      .lh-nav-sub{max-width:1200px;margin:0 auto;padding:0 24px 10px;display:flex;gap:4px;flex-wrap:wrap;}
      .lh-nav-link{font-size:.82rem;color:var(--t65);padding:6px 12px;border-radius:8px;text-decoration:none;transition:.15s;}
      .lh-nav-link:hover{color:var(--text);background:var(--green-soft);}
      .lh-nav-link.active{color:var(--green-ink);background:var(--green-soft);font-weight:600;}
      .lh-shell{max-width:1200px;margin:0 auto;padding:28px 24px 60px;}
      .lh-deny-card{background:var(--panel);border:1px solid var(--line);border-radius:var(--r-card);box-shadow:var(--shadow-sm);padding:40px 32px;text-align:center;max-width:480px;margin:60px auto;}
      .lh-deny-card h2{font-family:var(--disp);font-weight:700;font-size:1.3rem;margin-bottom:10px;}
      .lh-deny-card p{color:var(--t65);font-size:.9rem;}
    `;
    document.head.appendChild(style);
  }

  function renderDeny() {
    const shell = document.getElementById('lhApp');
    if (shell) {
      shell.innerHTML = `<div class="lh-deny-card"><h2>Access Denied</h2><p>LinkHunter is restricted to ScalpClock admins.</p></div>`;
    }
  }

  async function authedFetch(url, options = {}, token) {
    return fetch(url, {
      ...options,
      headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` },
    });
  }

  async function init(activeKey) {
    renderShell(activeKey);

    let sb = null;
    try {
      sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    } catch (e) {
      console.warn('Supabase init failed:', e.message);
    }
    if (!sb) {
      window.location.href = '/login';
      return new Promise(() => {});
    }

    const { data: { session } } = await sb.auth.getSession();
    if (!session) {
      window.location.href = '/login';
      return new Promise(() => {});
    }

    if (session.user.app_metadata?.is_admin !== true) {
      renderDeny();
      return new Promise(() => {});
    }

    const token = session.access_token;
    return {
      token,
      user: session.user,
      authedFetch: (url, options) => authedFetch(url, options, token),
    };
  }

  window.LinkHunterAuth = { init, SECTIONS };
})();
