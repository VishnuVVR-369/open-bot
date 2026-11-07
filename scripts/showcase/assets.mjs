// Screenshots the teammates "took" and the HTML pages they "published", rendered with Playwright.
// Everything here is invented: the sites, prices and people do not exist.
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function loadChromium() {
  const require = createRequire(path.join(root, "package.json"));
  const mod = await import(pathToFileURL(require.resolve("@playwright/test")).href);
  return mod.chromium ?? mod.default.chromium;
}

/* ------------------------------------------------------------------ Browser screenshots */

function browser({ url, tab, body, css = "" }) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0;padding:0}
body{width:1280px;height:800px;overflow:hidden;font:14px/1.45 -apple-system,"Segoe UI",Inter,Helvetica,Arial,sans-serif;background:#fff;color:#1f2430}
.tabs{height:38px;background:#dfe2e8;display:flex;align-items:flex-end;padding:0 12px;gap:2px}
.tab{height:30px;width:230px;background:#fff;border-radius:9px 9px 0 0;padding:6px 12px;font-size:12px;color:#333;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tab.off{background:#cfd3da;color:#555;width:170px}
.bar{height:42px;background:#fff;border-bottom:1px solid #dde0e6;display:flex;align-items:center;padding:0 14px;gap:12px}
.dots{display:flex;gap:6px}.dots i{width:11px;height:11px;border-radius:50%;background:#d8dbe1;display:block}
.url{flex:1;height:28px;background:#f0f2f5;border-radius:14px;padding:5px 16px;font-size:13px;color:#4b5160}
.page{height:720px;overflow:hidden;position:relative}
${css}
</style></head><body>
<div class="tabs"><div class="tab">${tab}</div><div class="tab off">New tab</div></div>
<div class="bar"><div class="dots"><i></i><i></i><i></i></div><div class="url">${url}</div></div>
<div class="page">${body}</div></body></html>`;
}

function flightsPage({ outbound, back }) {
  const rows = [
    [
      "TAP Air Portugal",
      "TP 234 / TP 233",
      "6:15 PM",
      "11:05 AM +1",
      "10h 50m",
      "Nonstop",
      "$842",
      true,
    ],
    [
      "United",
      "UA 118 + TP 1356",
      "3:40 PM",
      "1:20 PM +1",
      "15h 40m",
      "1 stop, EWR",
      "$716",
      false,
    ],
    [
      "Lufthansa",
      "LH 457 + LH 1170",
      "1:05 PM",
      "11:50 AM +1",
      "14h 45m",
      "1 stop, FRA (55m)",
      "$689",
      false,
    ],
    [
      "Air France",
      "AF 83 + AF 1224",
      "4:20 PM",
      "2:35 PM +1",
      "16h 15m",
      "1 stop, CDG",
      "$771",
      false,
    ],
    [
      "Delta",
      "DL 402 + DL 8611",
      "11:55 AM",
      "11:15 AM +1",
      "17h 20m",
      "1 stop, JFK",
      "$758",
      false,
    ],
  ];
  const row = (
    r,
  ) => `<div class="row ${r[7] ? "best" : ""}"><div class="air"><b>${r[0]}</b><span>${r[1]}</span></div>
<div class="t"><b>${r[2]} - ${r[3]}</b><span>SFO - LIS</span></div><div class="d"><b>${r[4]}</b><span>${r[5]}</span></div>
<div class="p">${r[6]}<span>round trip</span></div></div>`;
  return browser({
    url: "flights.example.com/search?from=SFO&to=LIS",
    tab: "SFO to Lisbon - Flights",
    body: `<div class="head"><div class="logo">farefinder</div><div class="chips"><span>San Francisco (SFO)</span><span>Lisbon (LIS)</span><span>${outbound} - ${back}</span><span>1 adult</span></div></div>
<div class="wrap"><div class="side"><h4>Stops</h4><p>Nonstop only</p><p>1 stop or fewer</p><h4>Airlines</h4><p>TAP Air Portugal</p><p>United</p><p>Lufthansa</p><h4>Price</h4><div class="slider"></div></div>
<div class="list"><div class="sort"><b>Best</b><span>Cheapest</span><span>Fastest</span></div>${rows.map(row).join("")}</div></div>`,
    css: `.head{height:72px;background:#16324f;color:#fff;display:flex;align-items:center;gap:28px;padding:0 36px}.logo{font-weight:700;font-size:20px;letter-spacing:-.02em}
.chips{display:flex;gap:10px}.chips span{background:rgba(255,255,255,.14);padding:8px 14px;border-radius:8px;font-size:13px}
.wrap{display:flex;gap:28px;padding:28px 36px;background:#f6f7f9;height:648px}.side{width:200px;font-size:13px}.side h4{margin:16px 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#6b7280}.side p{padding:5px 0}
.slider{height:6px;background:#cbd5e1;border-radius:3px;position:relative}.slider:after{content:"";position:absolute;left:10%;right:30%;top:0;bottom:0;background:#2563eb;border-radius:3px}
.list{flex:1}.sort{display:flex;gap:22px;margin-bottom:14px;font-size:14px;color:#6b7280}.sort b{color:#16324f;border-bottom:2px solid #2563eb;padding-bottom:6px}
.row{display:grid;grid-template-columns:1.3fr 1.4fr 1.1fr .8fr;align-items:center;background:#fff;border:1px solid #e3e6eb;border-radius:12px;padding:16px 22px;margin-bottom:12px}
.row.best{border-color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,.12)}.row b{display:block;font-size:15px}.row span{color:#6b7280;font-size:12.5px}
.p{text-align:right;font-size:22px;font-weight:700}.p span{display:block;font-weight:400}`,
  });
}

function hotelsPage() {
  const hotels = [
    ["Hotel Avenida Palace Annex", "Baixa", "9 min walk", "$189", "8.9", "#c084fc"],
    ["Casa do Largo", "Principe Real", "14 min walk", "$164", "9.2", "#fb923c"],
    ["Alma Riverside", "Cais do Sodre", "6 min walk", "$212", "8.7", "#38bdf8"],
    ["The Quiet Fig", "Chiado", "11 min walk", "$198", "9.4", "#4ade80"],
    ["Residencia Tejo", "Alfama", "22 min walk", "$142", "8.5", "#f472b6"],
    ["Hotel Mirante 41", "Avenida", "17 min walk", "$176", "8.8", "#facc15"],
  ];
  return browser({
    url: "stays.example.com/lisbon?checkin=dec-1&checkout=dec-5",
    tab: "Lisbon stays near the Summit",
    body: `<div class="top"><b>stayswell</b><span>Lisbon, Portugal - 4 nights - Under $220</span></div><div class="grid">${hotels
      .map(
        (h) =>
          `<div class="card"><div class="img" style="background:linear-gradient(135deg,${h[5]},#fff2)"></div><div class="body"><b>${h[0]}</b><span>${h[1]} - ${h[2]} to the venue</span><div class="foot"><em>${h[4]}</em><strong>${h[3]}<small> / night</small></strong></div></div></div>`,
      )
      .join("")}</div>`,
    css: `.top{height:64px;display:flex;align-items:center;gap:24px;padding:0 36px;border-bottom:1px solid #e5e7eb}.top b{font-size:19px;color:#0f766e}.top span{color:#6b7280}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:22px;padding:28px 36px;background:#f8fafc;height:656px}.card{background:#fff;border:1px solid #e5e7eb;border-radius:14px;overflow:hidden}
.img{height:150px}.body{padding:14px 16px}.body b{display:block;font-size:15px}.body span{display:block;color:#6b7280;font-size:12.5px;margin-top:3px}.foot{display:flex;justify-content:space-between;align-items:center;margin-top:16px}
em{font-style:normal;background:#0f766e;color:#fff;border-radius:6px;padding:3px 8px;font-weight:600;font-size:13px}strong{font-size:18px}small{font-weight:400;color:#6b7280;font-size:12px}`,
  });
}

function pricingPage() {
  const tier = (name, price, bullets, hot) =>
    `<div class="tier ${hot ? "hot" : ""}"><h3>${name}</h3><div class="price">${price}<small>/mo</small></div><ul>${bullets.map((b) => `<li>${b}</li>`).join("")}</ul><div class="cta">Start free trial</div></div>`;
  return browser({
    url: "tallyfox.example.com/pricing",
    tab: "Pricing - Tallyfox",
    body: `<nav><b>tallyfox</b><span>Product</span><span>Pricing</span><span>Docs</span><span>Sign in</span></nav>
<div class="hero"><h1>Simple pricing, no surprises</h1><p>Privacy-friendly analytics for teams that ship.</p></div>
<div class="tiers">${tier("Starter", "$9", ["10k pageviews", "1 site", "6 months of data"])}${tier("Pro", "$34", ["100k pageviews", "10 sites", "Funnels and goals", "API access"], true)}${tier("Scale", "$89", ["1M pageviews", "Unlimited sites", "SSO", "Priority support"])}</div>`,
    css: `body{background:#fff7ed}nav{height:60px;display:flex;align-items:center;gap:28px;padding:0 48px;color:#7c2d12}nav b{font-size:20px;margin-right:auto;color:#ea580c}
.hero{text-align:center;padding:40px 0 28px}h1{font-size:40px;letter-spacing:-.03em;color:#431407}.hero p{color:#9a3412;margin-top:8px;font-size:16px}
.tiers{display:flex;gap:24px;justify-content:center;padding:12px 48px}.tier{width:300px;background:#fff;border:1px solid #fed7aa;border-radius:18px;padding:28px}.tier.hot{border:2px solid #ea580c;transform:translateY(-8px)}
h3{font-size:17px;color:#7c2d12}.price{font-size:46px;font-weight:700;margin:10px 0 16px;color:#431407}small{font-size:15px;font-weight:400;color:#9a3412}ul{list-style:none;display:grid;gap:9px;margin-bottom:24px}li:before{content:"✓ ";color:#ea580c;font-weight:700}
.cta{background:#ea580c;color:#fff;text-align:center;padding:12px;border-radius:10px;font-weight:600}`,
  });
}

function cmsLoginPage() {
  return browser({
    url: "cms.kestrel.example/login/verify",
    tab: "Verify it's you - Kestrel CMS",
    body: `<div class="c"><div class="box"><div class="mark">K</div><h2>Check your phone</h2><p>Enter the 6-digit code from your authenticator app to continue.</p>
<div class="code">${"<i></i>".repeat(6)}</div><div class="btn">Verify</div><small>Lost your device? Use a recovery code</small></div></div>`,
    css: `.c{height:720px;background:#f1f5f9;display:flex;align-items:center;justify-content:center}.box{width:420px;background:#fff;border-radius:16px;padding:38px;text-align:center;box-shadow:0 10px 40px rgba(15,23,42,.08)}
.mark{width:46px;height:46px;border-radius:12px;background:#111827;color:#fff;font-weight:700;font-size:22px;line-height:46px;margin:0 auto 18px}h2{font-size:22px;margin-bottom:8px}p{color:#64748b;margin-bottom:22px}
.code{display:flex;gap:10px;justify-content:center;margin-bottom:22px}.code i{width:46px;height:56px;border:1.5px solid #cbd5e1;border-radius:10px;display:block}.code i:first-child{border-color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,.15)}
.btn{background:#111827;color:#fff;padding:13px;border-radius:10px;font-weight:600;margin-bottom:16px}small{color:#64748b}`,
  });
}

function summaryPage({ days }) {
  const slots = [
    ["9:30", "Opening keynote: The next decade of product", "Main stage"],
    ["11:00", "Pricing is a product: lessons from 40 launches", "Room A"],
    ["11:00", "Analytics without cookies, in practice", "Room C"],
    ["13:30", "Investor office hours (sign-up)", "Terrace"],
    ["14:30", "Shipping weekly with a team of six", "Room B"],
    ["16:00", "Panel: What AI changed about roadmaps", "Main stage"],
  ];
  return browser({
    url: "atlanticsummit.example/schedule",
    tab: "Schedule - Atlantic Product Summit",
    body: `<header><b>Atlantic Product Summit</b><span>Lisbon - ${days}</span></header><div class="tabs2"><span>Wed</span><span class="on">Thu</span><span>Fri</span></div>
<div class="agenda">${slots.map((s) => `<div class="slot"><time>${s[0]}</time><div><b>${s[1]}</b><span>${s[2]}</span></div></div>`).join("")}</div>`,
    css: `header{height:90px;background:linear-gradient(120deg,#0f172a,#1e3a8a);color:#fff;padding:24px 48px}header b{font-size:24px;display:block}header span{opacity:.75}
.tabs2{display:flex;gap:6px;padding:16px 48px;border-bottom:1px solid #e5e7eb}.tabs2 span{padding:8px 20px;border-radius:999px;color:#475569}.tabs2 .on{background:#1e3a8a;color:#fff}
.agenda{padding:14px 48px}.slot{display:flex;gap:28px;padding:16px 0;border-bottom:1px solid #eef0f3}time{width:70px;font-weight:700;color:#1e3a8a}.slot b{display:block;font-size:16px}.slot span{color:#64748b;font-size:13px}`,
  });
}

/** PNG screenshots by key, at the size of the computer's screen. */
export async function renderScreens({ outbound, back, summitDays }) {
  const chromium = await loadChromium();
  const instance = await chromium.launch();
  const context = await instance.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const sources = {
    flights: flightsPage({ outbound, back }),
    hotels: hotelsPage(),
    pricing: pricingPage(),
    cms: cmsLoginPage(),
    summit: summaryPage({ days: summitDays }),
  };
  const shots = new Map();
  for (const [key, html] of Object.entries(sources)) {
    await page.setContent(html, { waitUntil: "load" });
    shots.set(key, await page.screenshot({ type: "png" }));
  }
  await instance.close();
  return shots;
}

/* ------------------------------------------------------------------ Pages */

const BASE_CSS = `
:root{--bg:#fbfaf8;--fg:#1c1b19;--muted:#6b675f;--card:#fff;--line:#e8e4dc;--accent:#5b4bdb;--ok:#15803d;--warn:#b45309;--bad:#b91c1c}
@media (prefers-color-scheme:dark){:root{--bg:#161513;--fg:#f1eee8;--muted:#a39e93;--card:#1f1d1a;--line:#2f2c27;--accent:#9a8cff;--ok:#4ade80;--warn:#fbbf24;--bad:#f87171}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 ui-sans-serif,-apple-system,"Segoe UI",Inter,sans-serif}
main{max-width:920px;margin:0 auto;padding:56px 32px 72px}h1{font-size:38px;letter-spacing:-.03em;line-height:1.12;margin:0 0 10px}h2{font-size:20px;margin:36px 0 12px;letter-spacing:-.01em}
.lede{color:var(--muted);font-size:18px;max-width:640px;margin:0 0 28px}.eyebrow{font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:var(--accent);font-weight:700;margin-bottom:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px 20px}.grid{display:grid;gap:14px}.g3{grid-template-columns:repeat(3,1fr)}.g2{grid-template-columns:repeat(2,1fr)}
.stat b{display:block;font-size:34px;letter-spacing:-.03em}.stat span{color:var(--muted);font-size:13px}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:11px 12px;border-bottom:1px solid var(--line);font-size:14.5px}th{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.06em}
.pill{display:inline-block;padding:2px 10px;border-radius:999px;font-size:12.5px;font-weight:600;background:color-mix(in oklab,var(--c) 16%,transparent);color:var(--c)}
.done{--c:var(--ok)}.risk{--c:var(--bad)}.prog{--c:var(--warn)}.todo{--c:var(--muted)}
.bar{height:10px;border-radius:999px;background:var(--line);overflow:hidden}.bar i{display:block;height:100%;background:var(--accent);border-radius:999px}
`;

const shell = (title, body, extra = "") =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${BASE_CSS}${extra}</style></head><body><main>${body}</main></body></html>`;

export function checklistPage({ launch, freeze, version }) {
  const rows = [
    ["Pricing page and plan names", "Juno", "done", "Final copy approved"],
    ["Migration script for v1 workspaces", "Kit", "done", "Dry run on 40 workspaces passed"],
    ["Announcement blog post", "Juno", "prog", "Draft 2 with you, review Thursday"],
    ["Changelog and release notes", "Kit + Juno", "prog", "Kit has the PR list, Juno is editing"],
    ["Status page and on-call rota", "Kit", "todo", "Needs Dana to confirm the rota"],
    ["Press and newsletter outreach", "Mira", "prog", "11 of 18 replies sent"],
    ["Investor update email", "Mira", "todo", "Waiting for your numbers on Monday"],
    ["Rollback plan rehearsal", "Kit", "risk", "Staging restore took 41 minutes, target is 15"],
  ];
  const label = { done: "Done", prog: "In progress", todo: "Not started", risk: "At risk" };
  return shell(
    "Kestrel 2.0 launch checklist",
    `<div class="eyebrow">Kestrel 2.0 launch</div><h1>Eight workstreams, one at risk</h1>
<p class="lede">Launch is ${launch}. Feature freeze is ${freeze}. ${version === 2 ? "Updated after the rollback rehearsal." : "First pass, built from the task board and your inbox."}</p>
<div class="grid g3"><div class="card stat"><b>2 / 8</b><span>workstreams done</span></div><div class="card stat"><b>3</b><span>in progress</span></div><div class="card stat"><b style="color:var(--bad)">1</b><span>at risk</span></div></div>
<h2>Readiness</h2><div class="bar"><i style="width:${version === 2 ? 52 : 44}%"></i></div>
<h2>Workstreams</h2><div class="card" style="padding:4px 8px"><table><thead><tr><th>Workstream</th><th>Owner</th><th>Status</th><th>Latest</th></tr></thead><tbody>
${rows.map((r) => `<tr><td>${r[0]}</td><td>${r[1]}</td><td><span class="pill ${r[2]}">${label[r[2]]}</span></td><td style="color:var(--muted)">${r[3]}</td></tr>`).join("")}
</tbody></table></div>`,
  );
}

export function itineraryPage({ days }) {
  const items = days.map(
    (d) =>
      `<div class="day"><div class="when"><b>${d.day}</b><span>${d.date}</span></div><div class="card"><b>${d.title}</b><p>${d.body}</p></div></div>`,
  );
  return shell(
    "Lisbon trip itinerary",
    `<div class="eyebrow">Atlantic Product Summit</div><h1>Lisbon, ${days[0].date} to ${days.at(-1).date}</h1>
<p class="lede">Nonstop on TAP, a quiet hotel in Chiado, and your two investor 1:1s slotted around the keynotes.</p>
<div class="grid g3"><div class="card stat"><b>$842</b><span>round trip, TAP nonstop</span></div><div class="card stat"><b>$198</b><span>per night, The Quiet Fig</span></div><div class="card stat"><b>11 min</b><span>walk to the venue</span></div></div>
<h2>Day by day</h2><div class="grid">${items.join("")}</div>`,
    `.day{display:grid;grid-template-columns:96px 1fr;gap:16px;align-items:start}.when b{display:block;font-size:18px}.when span{color:var(--muted);font-size:13px}.card p{margin:6px 0 0;color:var(--muted);font-size:14.5px}`,
  );
}

export function pricingComparisonPage() {
  const rows = [
    ["Tallyfox", 34, 100, "Funnels, API", "#ea580c"],
    ["Pinwheel Analytics", 29, 150, "Heatmaps", "#0ea5e9"],
    ["Quillmetrics", 49, 250, "Session replay", "#a855f7"],
    ["Kestrel 2.0", 25, 200, "Funnels, API, EU hosting", "#5b4bdb"],
  ];
  const bar = (r) =>
    `<div style="margin:10px 0"><div style="display:flex;justify-content:space-between;font-size:14px"><span>${r[0]}</span><b>$${r[1]}/mo</b></div><div class="bar"><i style="width:${(r[1] / 55) * 100}%;background:${r[4]}"></i></div></div>`;
  return shell(
    "Analytics pricing landscape",
    `<div class="eyebrow">Competitor research</div><h1>Where Kestrel 2.0 sits on price</h1>
<p class="lede">Entry-level paid plans for three comparable tools, checked this week from their public pricing pages.</p>
<div class="grid g2"><div class="card"><b>Price of the mid-tier plan</b>${rows.map(bar).join("")}</div>
<div class="card"><b>Pageviews included per dollar</b><table style="margin-top:8px"><tbody>${rows.map((r) => `<tr><td>${r[0]}</td><td style="text-align:right"><b>${(r[2] / r[1]).toFixed(1)}k</b></td></tr>`).join("")}</tbody></table></div></div>
<h2>Detail</h2><div class="card" style="padding:4px 8px"><table><thead><tr><th>Tool</th><th>Mid-tier</th><th>Pageviews</th><th>Notable</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${r[0]}</td><td>$${r[1]}</td><td>${r[2]}k</td><td style="color:var(--muted)">${r[3]}</td></tr>`).join("")}</tbody></table></div>
<p style="color:var(--muted);font-size:13px;margin-top:18px">Prices are monthly, billed annually. Tallyfox raised its Pro plan from $29 to $34 two days ago.</p>`,
  );
}

export function announcementPage({ version }) {
  const intro =
    version === 1
      ? "Today we are releasing Kestrel 2.0, the biggest update since we started. Over the last eight months we rebuilt the dashboard, rewrote the ingestion pipeline, added funnels and goals, and moved every workspace to a new storage layer that is faster and cheaper to run. We think it is the best version of Kestrel we have made, and we cannot wait for you to try it."
      : "Kestrel 2.0 is out today. It is faster, it has funnels, and it still never sets a cookie. Here is what changed and what to do if you are on v1.";
  return shell(
    "Kestrel 2.0 announcement (draft)",
    `<div class="eyebrow">Draft ${version} - Juno</div><h1>Kestrel 2.0 is here</h1>
<p class="lede">${intro}</p>
<h2>What is new</h2><div class="grid g2"><div class="card"><b>Funnels and goals</b><p style="color:var(--muted);margin:6px 0 0">Define a path, see where people drop off, and share it with your team.</p></div><div class="card"><b>Dashboards in under 200 ms</b><p style="color:var(--muted);margin:6px 0 0">The new storage layer cuts median load time by 4x on large sites.</p></div><div class="card"><b>EU hosting</b><p style="color:var(--muted);margin:6px 0 0">Pick a region per site. Data never leaves it.</p></div><div class="card"><b>A public API</b><p style="color:var(--muted);margin:6px 0 0">Everything in the dashboard is available over REST.</p></div></div>
<h2>Upgrading from v1</h2><p>Your workspace migrates automatically on launch day. Nothing to install, and your tracking snippet keeps working. If you would rather move on your own schedule, you can do it from Settings any time this month.</p>
${version >= 3 ? `<h2>Upgrading from v1: questions we expect</h2><div class="grid"><div class="card"><b>Do I need to change my tracking snippet?</b><p style="color:var(--muted);margin:6px 0 0">No. It keeps working.</p></div><div class="card"><b>When does my workspace move?</b><p style="color:var(--muted);margin:6px 0 0">Automatically, on launch day. You will get an email first.</p></div><div class="card"><b>Can I stay on v1 for now?</b><p style="color:var(--muted);margin:6px 0 0">Yes, until the end of the month. Switch from Settings whenever you are ready.</p></div></div>` : ""}
<h2>Thank you</h2><p>To the 412 teams who tried the beta and sent us bugs, ideas and the occasional strongly worded email: this one is for you.</p>`,
  );
}

/** JPEG thumbnails of a page at laptop width, light and dark. */
export async function renderThumbnails(pagesByKey) {
  const chromium = await loadChromium();
  const instance = await chromium.launch();
  const out = new Map();
  for (const scheme of ["light", "dark"]) {
    const context = await instance.newContext({
      viewport: { width: 1280, height: 800 },
      colorScheme: scheme,
    });
    const page = await context.newPage();
    for (const [key, html] of Object.entries(pagesByKey)) {
      await page.setContent(html, { waitUntil: "load" });
      const bytes = await page.screenshot({ type: "jpeg", quality: 82 });
      out.set(`${key}:${scheme}`, bytes);
    }
    await context.close();
  }
  await instance.close();
  return out;
}
