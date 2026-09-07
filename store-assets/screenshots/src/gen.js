// Generates the 5 store-screenshot compositions (1280x800) with "Erasechat"
// branding. Faithful recreation of the originals (marketing mockups), using the
// product's own Outfit font (inlined) so it renders offline.
const fs = require('fs');
const path = require('path');

// Regenerate the store screenshots after a branding/content change:
//   node store-assets/screenshots/src/gen.js      # writes the 5 HTML files here
//   for s in 01-overview 02-preview 03-safety 04-progress 05-privacy; do \
//     google-chrome --headless=new --no-sandbox --hide-scrollbars \
//       --force-device-scale-factor=1 --window-size=1280,800 \
//       --screenshot="store-assets/screenshots/$s.png" \
//       "file://$PWD/store-assets/screenshots/src/$s.html"; done
const ROOT = path.resolve(__dirname, '../../..'); // repo root
const OUT = __dirname;
const fontB64 = fs.readFileSync(path.join(ROOT, 'fonts/outfit-variable.woff2')).toString('base64');

// Logo mark (broom + speech bubble), reused from icons/icon.svg, sized via viewBox.
const LOGO = (size) => `
<svg width="${size}" height="${size}" viewBox="0 0 512 512" style="flex:0 0 auto;filter:drop-shadow(0 6px 16px rgba(139,92,246,.35))">
  <defs>
    <linearGradient id="bub" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8B5CF6"/><stop offset="1" stop-color="#EC4899"/></linearGradient>
    <linearGradient id="tl" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#241F47"/><stop offset="1" stop-color="#12172B"/></linearGradient>
  </defs>
  <rect width="512" height="512" rx="118" fill="url(#tl)"/>
  <rect x="86" y="104" width="340" height="232" rx="56" fill="url(#bub)"/>
  <path d="M150 300 L118 402 L236 322 Z" fill="url(#bub)"/>
  <g transform="rotate(34 256 232) translate(6 -6)">
    <rect x="245" y="96" width="24" height="150" rx="12" fill="#F8FAFC"/>
    <rect x="234" y="240" width="46" height="26" rx="9" fill="#CBD5E1"/>
    <path d="M234 266 H280 L312 372 Q257 386 202 372 Z" fill="#F8FAFC"/>
    <g stroke="#94A3B8" stroke-width="7" stroke-linecap="round"><line x1="245" y1="272" x2="233" y2="368"/><line x1="257" y1="272" x2="257" y2="372"/><line x1="269" y1="272" x2="281" y2="368"/></g>
  </g>
  <path d="M368 150 l10 24 24 10 -24 10 -10 24 -10 -24 -24 -10 24 -10 Z" fill="#fff"/>
  <path d="M150 168 l7 16 16 7 -16 7 -7 16 -7 -16 -16 -7 16 -7 Z" fill="#F9A8D4"/>
  <circle cx="410" cy="330" r="12" fill="#F9A8D4"/><circle cx="132" cy="392" r="9" fill="#fff" opacity=".9"/>
</svg>`;

const brand = (nameSize) => `
<span style="display:inline-flex;align-items:center;gap:12px">
  ${LOGO(nameSize + 20)}
  <span style="display:inline-flex;align-items:baseline;gap:10px">
    <span style="font-weight:800;font-size:${nameSize}px;color:#F8FAFC;letter-spacing:-.5px">Erasechat</span>
  </span>
</span>`;

const CSS = `
@font-face{font-family:'Outfit';src:url(data:font/woff2;base64,${fontB64}) format('woff2');font-weight:100 900;font-display:block}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:1280px;height:800px;overflow:hidden}
body{font-family:'Outfit',-apple-system,'DejaVu Sans',sans-serif;color:#e2e8f0;
  background:
    radial-gradient(60% 55% at 14% 92%, rgba(139,92,246,.22), transparent 70%),
    radial-gradient(50% 50% at 92% 8%, rgba(236,72,153,.12), transparent 70%),
    linear-gradient(135deg,#0b1020 0%,#0f0c24 55%,#0a0a18 100%);
  position:relative}
.grid{position:absolute;inset:0;background-image:
  linear-gradient(rgba(148,163,184,.045) 1px,transparent 1px),
  linear-gradient(90deg,rgba(148,163,184,.045) 1px,transparent 1px);
  background-size:44px 44px;-webkit-mask-image:radial-gradient(90% 80% at 50% 30%,#000,transparent)}
.page{position:relative;padding:38px 56px 0}
.top{display:flex;justify-content:space-between;align-items:center}
.tag{font-size:14px;font-weight:700;letter-spacing:3px;color:#8b93a7;text-transform:uppercase}
h1{font-size:52px;line-height:1.06;font-weight:800;letter-spacing:-1px;margin-top:30px}
.a{background:linear-gradient(120deg,#a78bfa,#f472b6);-webkit-background-clip:text;background-clip:text;color:transparent}
.sub{font-size:20px;line-height:1.5;color:#94a3b8;max-width:820px;margin-top:16px;font-weight:400}
.card{background:linear-gradient(180deg,rgba(30,27,58,.72),rgba(17,20,38,.72));border:1px solid rgba(148,163,184,.14);
  border-radius:18px;box-shadow:0 30px 80px rgba(0,0,0,.45);backdrop-filter:blur(6px)}
.pill{display:inline-flex;align-items:center;gap:8px;font-size:15px;font-weight:600;color:#cbd5e1;
  background:rgba(15,23,42,.7);border:1px solid rgba(148,163,184,.16);border-radius:999px;padding:9px 16px}
.panelTitle{font-size:16px;font-weight:700;color:#fff;display:flex;align-items:center;gap:9px}
.panelTitle::before{content:"";width:4px;height:16px;border-radius:2px;background:linear-gradient(#8b5cf6,#ec4899)}
.lbl{color:#94a3b8;font-size:14px}.val{color:#f1f5f9;font-size:14px;font-weight:700}
.row{display:flex;justify-content:space-between;align-items:center;padding:9px 0}
.field label{display:block;color:#94a3b8;font-size:13px;margin-bottom:6px}
.field .inp{background:rgba(15,23,42,.65);border:1px solid rgba(148,163,184,.18);border-radius:10px;padding:11px 13px;font-size:14px;color:#e2e8f0}
.badge2{font-size:11px;font-weight:700;letter-spacing:1px;color:#a78bfa;border:1px solid rgba(139,92,246,.5);background:rgba(139,92,246,.12);padding:5px 10px;border-radius:999px}
.tog{width:46px;height:26px;border-radius:999px;position:relative;flex:0 0 auto}
.tog i{position:absolute;top:3px;width:20px;height:20px;border-radius:50%;background:#fff}
.tog.on{background:linear-gradient(135deg,#8b5cf6,#ec4899)}.tog.on i{right:3px}
.tog.off{background:#334155}.tog.off i{left:3px}
.btn{font-size:15px;font-weight:700;border-radius:10px;padding:11px 20px;border:1px solid transparent}
.btn.ghost{background:rgba(15,23,42,.6);border-color:rgba(148,163,184,.2);color:#e2e8f0}
.btn.grad{background:linear-gradient(135deg,#8b5cf6,#ec4899);color:#fff}
.btn.red{background:#ef4444;color:#fff}
.av{width:30px;height:30px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#fff;flex:0 0 auto}
.chk{width:18px;height:18px;border-radius:5px;flex:0 0 auto}
.chk.on{background:#3b82f6}.chk.off{background:transparent;border:2px solid #475569}
code,.mono{font-family:'DejaVu Sans Mono',monospace}
`;

const page = (bodyInner) => `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head>
<body><div class="grid"></div><div class="page">${bodyInner}</div></body></html>`;

const head = (tag, h1html, sub) => `
<div class="top">${brand(22)}${tag?`<div class="tag">${tag}</div>`:'<div></div>'}</div>
<h1>${h1html}</h1><div class="sub">${sub}</div>`;

// ---------- Slide 1: overview ----------
const s1 = page(head('',
  `Bulk-clean your Slack —<br><span class="a">with surgical control.</span>`,
  `Filter by sender, date, keyword, threads and attachments. Then delete in bulk — from any channel, group, or DM.`) + `
<div class="card" style="margin-top:30px;padding:26px 30px">
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:40px">
    <div>
      <div class="panelTitle">Session Connection</div>
      <div style="margin-top:14px">
        <div class="row"><span class="lbl">Workspace Name</span><span class="val">Acme Corp</span></div>
        <div class="row"><span class="lbl">Workspace URL</span><span class="val">acme.slack.com</span></div>
        <div class="row"><span class="lbl">User ID</span><span class="val">U04ACME9Z</span></div>
        <div class="row"><span class="lbl">Mode</span><span class="val">Safe · Single-Channel</span></div>
        <div class="row"><span class="lbl">Local Protection</span><span class="badge2">CURRENT CHAT SCOPE</span></div>
      </div>
    </div>
    <div>
      <div class="panelTitle">Deletion Filter Matrix</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:14px">
        <div class="field"><label>Sender Profile</label><div class="inp">Only My Messages ▾</div></div>
        <div class="field"><label>Date Threshold</label><div class="inp">Older than X days ▾</div></div>
        <div class="field"><label>Text Match (Optional)</label><div class="inp">standup</div></div>
        <div class="field"><label>Days Old Threshold</label><div class="inp">30</div></div>
      </div>
      <div class="row" style="margin-top:8px"><div><div style="color:#fff;font-weight:600;font-size:14px">Include Thread Replies</div><div style="color:#94a3b8;font-size:12px">Scan and delete messages inside threads</div></div><span class="tog on"><i></i></span></div>
      <div class="row"><div><div style="color:#fff;font-weight:600;font-size:14px">Only Delete Attachments</div><div style="color:#94a3b8;font-size:12px">Deletes files/images but preserves message text</div></div><span class="tog off"><i></i></span></div>
    </div>
  </div>
  <div style="display:flex;justify-content:space-between;align-items:center;margin-top:22px;padding-top:20px;border-top:1px solid rgba(148,163,184,.12)">
    <div><div style="font-weight:700;color:#fff;font-size:16px">#project-phoenix</div><div style="color:#94a3b8;font-size:13px">Public channel · targeting your messages older than 30 days matching "standup".</div></div>
    <div style="display:flex;gap:12px"><span class="btn ghost">Scan Messages</span><span class="btn grad">Start Deleting</span></div>
  </div>
</div>`);

// ---------- Slide 2: preview ----------
const msg = (color,ini,name,you,time,text,extra,checked,thread) => `
<div style="display:flex;gap:12px;align-items:flex-start;padding:14px 4px;border-bottom:1px solid rgba(148,163,184,.08);${thread?'margin-left:52px;':''}">
  <span class="chk ${checked?'on':'off'}" style="margin-top:3px"></span>
  <span class="av" style="background:${color}">${ini}</span>
  <div>
    <div style="display:flex;align-items:center;gap:8px"><span style="font-weight:700;color:#fff;font-size:14px">${name}${you?' <span style=\"color:#94a3b8;font-weight:400\">(you)</span>':''}</span><span style="color:#94a3b8;font-size:12px">${time}</span>${thread?'<span class="badge2" style="font-size:10px;padding:2px 8px">Thread Reply</span>':''}</div>
    <div style="color:#cbd5e1;font-size:14px;margin-top:3px">${text}</div>
    ${extra?`<div style="color:#ec4899;font-size:12px;margin-top:3px">📎 ${extra}</div>`:''}
  </div>
</div>`;
const s2 = page(head('Step 1 · Preview',
  `Scan first. <span class="a">Preview every message</span> before it goes.`,
  `Nothing is deleted until you say so. Un-check anything you want to keep — or export a CSV backup in one click.`) + `
<div class="card" style="margin-top:28px;padding:22px 26px">
  <div style="display:flex;justify-content:space-between;align-items:center">
    <div style="font-weight:700;color:#fff;font-size:17px">Messages Flagged for Deletion</div>
    <div style="display:flex;align-items:center;gap:16px;font-size:13px;color:#94a3b8">
      <span>24 items found</span><span class="btn ghost" style="padding:7px 13px;font-size:13px">Export CSV</span>
      <span style="display:inline-flex;align-items:center;gap:7px;color:#e2e8f0"><span class="chk on"></span>Select All</span>
    </div>
  </div>
  <div style="margin-top:8px">
    ${msg('#8B5CF6','SK','Sarah Kim',false,'Today · 9:41 AM','Morning standup thread — please drop your updates here 🧵','',true,false)}
    ${msg('#8B5CF6','SK','Sarah Kim',false,'Today · 9:43 AM','Yesterday: shipped the auth fix. Today: dashboard polish + review.','',true,true)}
    ${msg('#EC4899','ML','Marcus Lee',false,'Today · 10:02 AM','standup notes are in the doc, link below','Contains 1 attached file',true,false)}
    ${msg('#10B981','AR','Alex Rivera',true,'Today · 8:15 AM','reminder: standup moved to 9:30 tomorrow','',true,false)}
    ${msg('#F59E0B','PN','Priya Nair',false,'Yesterday · 2:30 PM','old standup recording + slides from last sprint','Contains 2 attached files',true,false)}
    ${msg('#06B6D4','DK','Dana Koch',false,'Yesterday · 11:57 AM','keeping this one — pinned decision on the release date','',false,false)}
    ${msg('#10B981','AR','Alex Rivera',true,'Mon · 4:20 PM','standup canceled today — async updates only, thanks all','',true,false)}
  </div>
</div>`);

// ---------- Slide 3: safety ----------
const s3 = page(head('Safety First',
  `Deletes are permanent — <span class="a">so we make you confirm.</span>`,
  `Large jobs require you to type <b style="color:#fff">DELETE</b>. Every run can be paused, resumed, or cancelled, and it only ever touches the conversation you chose.`) + `
<div style="display:flex;gap:14px;margin-top:26px">
  <span class="pill">✅ Type-to-confirm for 100+ messages</span>
  <span class="pill">⏸️ Pause · Resume · Cancel anytime</span>
  <span class="pill">🎯 Single-channel scope by default</span>
</div>
<div style="display:flex;justify-content:center;margin-top:30px">
  <div class="card" style="width:520px;padding:28px 30px;border-color:rgba(239,68,68,.35);box-shadow:0 30px 80px rgba(239,68,68,.12)">
    <div style="font-size:20px;font-weight:800;color:#f87171;display:flex;align-items:center;gap:10px">⚠️ Critical Action Verification</div>
    <div style="color:#cbd5e1;font-size:15px;line-height:1.5;margin-top:14px">You are about to delete more than 100 messages (<b style="color:#fff">128 messages</b>). To confirm this operation, type the word <b style="color:#fff">DELETE</b> below:</div>
    <div class="inp mono" style="margin-top:18px;text-align:center;letter-spacing:6px;font-size:18px;color:#fff;border-color:rgba(239,68,68,.5);padding:15px">DELETE</div>
    <div style="display:flex;justify-content:flex-end;gap:12px;margin-top:20px"><span class="btn ghost">Go Back</span><span class="btn red">Confirm Deletion</span></div>
  </div>
</div>`);

// ---------- Slide 4: progress ----------
const C=2*Math.PI*40, off=(C*(1-0.62)).toFixed(1);
const logln=(c,t)=>`<div style="color:${c};padding:2px 0">${t}</div>`;
const s4 = page(head('Step 2 · Clean',
  `Watch it work — <span class="a">live progress &amp; logs.</span>`,
  `Real-time progress ring, success/failure counts, and a full execution log. Automatically paces itself to respect Slack's rate limits.`) + `
<div class="card" style="margin-top:28px;padding:22px 26px">
  <div style="display:flex;justify-content:space-between;align-items:center;padding-bottom:18px;border-bottom:1px solid rgba(148,163,184,.12)">
    <div><div style="font-weight:700;color:#fff;font-size:16px">🟢 Deleting from #project-phoenix</div><div style="color:#94a3b8;font-size:13px;margin-top:2px">Pacing at 1,000ms between deletes · rate-limit aware · safe to leave running.</div></div>
    <span class="btn" style="border-color:rgba(239,68,68,.5);color:#f87171;background:rgba(239,68,68,.08)">Cancel</span>
  </div>
  <div style="display:grid;grid-template-columns:340px 1fr;gap:22px;margin-top:20px">
    <div style="display:flex;align-items:center;gap:22px">
      <svg width="120" height="120" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" stroke="rgba(255,255,255,.06)" stroke-width="9" fill="none"/><circle cx="50" cy="50" r="40" stroke="url(#pg)" stroke-width="9" fill="none" stroke-linecap="round" stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${off}" transform="rotate(-90 50 50)"/><defs><linearGradient id="pg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8b5cf6"/><stop offset="1" stop-color="#ec4899"/></linearGradient></defs><text x="50" y="56" text-anchor="middle" font-size="20" font-weight="800" fill="#fff" font-family="Outfit">62%</text></svg>
      <div>
        <div style="font-weight:700;color:#fff;font-size:16px;margin-bottom:12px">Deleting…</div>
        <div style="display:flex;gap:18px">
          <div><div style="font-size:11px;color:#94a3b8;letter-spacing:1px">SUCCESS</div><div style="font-size:22px;font-weight:800;color:#10b981">79</div></div>
          <div><div style="font-size:11px;color:#94a3b8;letter-spacing:1px">FAILED</div><div style="font-size:22px;font-weight:800;color:#ef4444">0</div></div>
          <div><div style="font-size:11px;color:#94a3b8;letter-spacing:1px">LEFT</div><div style="font-size:22px;font-weight:800;color:#e2e8f0">49</div></div>
        </div>
      </div>
    </div>
    <div class="card" style="padding:0;background:rgba(2,6,18,.75)">
      <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;border-bottom:1px solid rgba(148,163,184,.12);font-size:12px;letter-spacing:1px;color:#94a3b8">EXECUTION LOGS
        <span style="display:flex;gap:6px">${['CLEAR','EXPORT','RUNNING'].map(x=>`<span style="border:1px solid rgba(148,163,184,.2);border-radius:6px;padding:3px 8px;font-size:11px;color:#cbd5e1">${x}</span>`).join('')}</span>
      </div>
      <div class="mono" style="padding:12px 14px;font-size:12.5px;line-height:1.55">
        ${logln('#60a5fa','Erasechat initialized in Safe (Single-Channel) Mode.')}
        ${logln('#60a5fa','Scan complete — 128 messages matched active filters.')}
        ${logln('#34d399','✓ Deleted message ts=1721632841.221 (77/128)')}
        ${logln('#34d399','✓ Deleted message ts=1721632844.007 (78/128)')}
        ${logln('#fbbf24','⚠ Rate limit hit — backing off 12s, will auto-resume.')}
        ${logln('#34d399','✓ Deleted message ts=1721632858.910 (79/128)')}
        ${logln('#60a5fa','Progress saved · job will survive a browser restart.')}
      </div>
    </div>
  </div>
</div>`);

// ---------- Slide 5: privacy ----------
const feat=(ic,t,d)=>`<div style="display:flex;gap:16px;padding:16px 0;border-bottom:1px solid rgba(148,163,184,.1)"><div style="width:40px;height:40px;border-radius:10px;background:rgba(139,92,246,.14);display:flex;align-items:center;justify-content:center;font-size:19px;flex:0 0 auto">${ic}</div><div><div style="font-weight:700;color:#fff;font-size:16px">${t}</div><div style="color:#94a3b8;font-size:14px;margin-top:2px;line-height:1.45">${d}</div></div></div>`;
const s5 = page(head('Private by Design',
  `100% local. <span class="a">Nothing leaves your browser.</span>`,
  `Erasechat runs entirely on your machine using your existing Slack login. There are no accounts, no servers, and no tracking.`) + `
<div style="display:grid;grid-template-columns:400px 1fr;gap:40px;margin-top:30px">
  <div class="card" style="padding:26px">
    ${brand(22)}
    <div style="margin-top:18px"><span style="display:inline-flex;align-items:center;gap:8px;font-size:13px;font-weight:700;color:#34d399;background:rgba(16,185,129,.12);border:1px solid rgba(16,185,129,.3);border-radius:999px;padding:7px 14px">🟢 Slack Web Client Detected</span></div>
    <div style="margin-top:18px;background:rgba(15,23,42,.55);border:1px solid rgba(148,163,184,.14);border-radius:12px;padding:16px">
      <div style="font-size:11px;letter-spacing:1.5px;color:#8b93a7">CONNECTED TO WORKSPACE</div>
      <div style="font-size:20px;font-weight:800;color:#fff;margin-top:5px">Acme Corp</div>
      <div style="color:#94a3b8;font-size:13px;margin-top:6px">Clean messages in channels, private groups, and direct messages.</div>
    </div>
    <div class="btn grad" style="display:block;text-align:center;margin-top:18px;padding:14px">Open Clean Dashboard →</div>
  </div>
  <div>
    ${feat('🔒','All processing is local','Scanning and deleting happen in your browser tab — never on a remote server.')}
    ${feat('🚫','No data sent anywhere','No analytics, no accounts, no message content uploaded. Ever.')}
    ${feat('🔑','Uses your existing login','Works through your active Slack session — no passwords or tokens to enter.')}
    ${feat('📄','Independent &amp; transparent','Not affiliated with Slack. Deletions are permanent and always confirmed by you.')}
  </div>
</div>`);

const slides = {'01-overview':s1,'02-preview':s2,'03-safety':s3,'04-progress':s4,'05-privacy':s5};
for (const [name,html] of Object.entries(slides)) fs.writeFileSync(path.join(OUT, name+'.html'), html);
console.log('wrote', Object.keys(slides).join(', '));
