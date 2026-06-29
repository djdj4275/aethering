// Aethering — UI 오버레이 (순수 DOM, Three.js 미사용)
// HUD(체력/경험치/골드) · 대화창 · 퀘스트 추적 · 플로팅 데미지 · 배너 · 토스트.
// main.js 에서 `import { UI } from './ui.js'` 로 불러 쓴다.
// 모든 메서드는 init 전/후 어느 때 호출해도 안전하도록 가드한다.

// ---------- 내부 상태 ----------
let inited = false;          // init 이 이미 끝났는지 (멱등)
const el = {};               // 생성한 주요 DOM 노드 보관
let dmgLayer = null;         // 플로팅 데미지 컨테이너
let dmgCount = 0;            // 현재 떠 있는 데미지 노드 수 (성능 캡)
const DMG_CAP = 40;          // 동시 데미지 노드 상한
let bannerTimer = null;      // 배너 자동 숨김 타이머
let toastTimer = null;       // 토스트 자동 숨김 타이머
let charKeyHandler = null;   // 캐릭터 선택 모달의 키보드 리스너
let levelKeyHandler = null;  // 레벨 업 모달의 키보드 리스너
let bossRewardKeyHandler = null; // 보스 보상 모달의 키보드 리스너
let slotPickKeyHandler = null;   // 슬롯 선택 모달의 키보드 리스너
let actSlots = null;         // 액티브 스킬 HUD 슬롯 노드 캐시 (4개)

// 작은 헬퍼 — 요소 생성 + 속성 지정
function mk(tag, cls, parent) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (parent) parent.appendChild(n);
  return n;
}

// ---------- 자체 포함 CSS (style.css 에 의존하지 않음) ----------
const CSS = `
:root{
  --ui-font: system-ui,"Segoe UI","Apple SD Gothic Neo","Malgun Gothic",sans-serif;
}
#ui-root, #ui-root *{ box-sizing:border-box; }
.ui-overlay{
  position:fixed; pointer-events:none; z-index:20;
  font-family:var(--ui-font); color:#eaf2ff;
  text-shadow:0 1px 2px #000;
}
.ui-hidden{ display:none !important; }

/* ----- HP / XP / 골드 (좌하단) ----- */
#ui-vitals{
  left:16px; bottom:16px; width:260px;
  background:rgba(10,14,30,.55); border:1px solid rgba(120,180,255,.18);
  border-radius:12px; padding:10px 12px;
  backdrop-filter:blur(4px);
}
#ui-vitals .ui-row{ display:flex; align-items:center; gap:8px; margin-bottom:6px; }
#ui-vitals .ui-row:last-child{ margin-bottom:0; }
.ui-lvl{
  flex:0 0 auto; min-width:40px; text-align:center;
  font-weight:700; font-size:13px; color:#0e1430;
  background:linear-gradient(180deg,#ffe08a,#f5b73c);
  border-radius:6px; padding:3px 6px; box-shadow:0 1px 3px rgba(0,0,0,.4);
}
.ui-bar{
  position:relative; flex:1 1 auto; height:16px;
  background:rgba(0,0,0,.45); border-radius:8px; overflow:hidden;
  border:1px solid rgba(255,255,255,.08);
}
.ui-bar-fill{
  position:absolute; inset:0; width:100%;
  transform-origin:left center; transition:width .25s ease, background .25s ease;
  border-radius:8px;
}
#ui-hp-fill{ background:linear-gradient(180deg,#7dff8a,#39c75a); }
#ui-xp-fill{ background:linear-gradient(180deg,#9fd4ff,#3a86ff); height:10px; border-radius:6px; }
#ui-xp-bar{ height:10px; }
.ui-bar-label{
  position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
  font-size:11px; font-variant-numeric:tabular-nums; font-weight:600; letter-spacing:.3px;
}
.ui-gold{
  display:flex; align-items:center; gap:6px; font-size:13px; font-weight:600;
  color:#ffe08a;
}
.ui-gold .ui-coin{
  display:inline-block; width:14px; height:14px; border-radius:50%;
  background:radial-gradient(circle at 35% 30%,#fff4c2,#e0a526);
  box-shadow:0 0 4px rgba(245,183,60,.7);
}

/* ----- 퀘스트 추적 (우상단) ----- */
#ui-quests{
  right:16px; top:16px; width:248px;
  background:rgba(10,14,30,.5); border:1px solid rgba(120,180,255,.18);
  border-radius:12px; padding:10px 12px; backdrop-filter:blur(4px);
}
#ui-quests .ui-q-head{
  font-size:12px; letter-spacing:1px; color:#9fe0ff; font-weight:700;
  margin-bottom:8px; text-transform:uppercase; opacity:.9;
}
.ui-quest{ margin-bottom:9px; }
.ui-quest:last-child{ margin-bottom:0; }
.ui-quest .ui-q-title{
  display:flex; justify-content:space-between; gap:8px;
  font-size:13px; font-weight:600;
}
.ui-quest .ui-q-prog{ color:#9fe0ff; font-variant-numeric:tabular-nums; }
.ui-quest .ui-q-desc{ font-size:11px; color:rgba(234,242,255,.65); margin-top:1px; }
.ui-quest.ui-q-done .ui-q-title{ color:#7dff8a; }
.ui-quest.ui-q-done .ui-q-prog::after{ content:" ✓"; }

/* ----- 상호작용 프롬프트 (중앙 하단) ----- */
#ui-prompt{
  left:50%; bottom:96px; transform:translateX(-50%);
  background:rgba(10,14,30,.6); border:1px solid rgba(159,224,255,.3);
  border-radius:24px; padding:8px 18px; font-size:14px;
  display:flex; align-items:center; gap:8px;
}
#ui-prompt .ui-key{
  display:inline-flex; align-items:center; justify-content:center;
  min-width:22px; height:22px; padding:0 6px;
  background:#9fe0ff; color:#0e1430; font-weight:700; font-size:12px;
  border-radius:5px; box-shadow:0 2px 0 rgba(0,0,0,.35);
}

/* ----- 대화창 (중앙) ----- */
#ui-dialogue{
  left:50%; bottom:64px; transform:translateX(-50%);
  width:min(620px,92vw);
  background:rgba(8,12,26,.92); border:1px solid rgba(120,180,255,.3);
  border-radius:14px; padding:16px 20px; pointer-events:auto;
  box-shadow:0 8px 40px rgba(0,0,0,.5);
}
#ui-dialogue .ui-d-name{
  font-size:14px; font-weight:700; color:#9fe0ff; margin-bottom:8px;
  letter-spacing:.5px;
}
#ui-dialogue .ui-d-lines{ font-size:15px; line-height:1.6; margin-bottom:14px; }
#ui-dialogue .ui-d-opts{ display:flex; flex-direction:column; gap:8px; }
.ui-d-opt{
  pointer-events:auto; cursor:pointer; text-align:left;
  font-family:var(--ui-font); font-size:14px; color:#eaf2ff;
  background:rgba(58,134,255,.18); border:1px solid rgba(120,180,255,.35);
  border-radius:8px; padding:9px 12px; transition:background .15s,border-color .15s;
}
.ui-d-opt:hover{ background:rgba(58,134,255,.35); border-color:#9fe0ff; }

/* ----- 플로팅 데미지 ----- */
#ui-dmg{ inset:0; }
.ui-dmg-num{
  position:absolute; font-family:var(--ui-font); font-weight:800;
  font-size:20px; line-height:1; will-change:transform,opacity;
  text-shadow:0 2px 4px #000, 0 0 2px #000;
  animation:ui-dmg-rise .9s ease-out forwards;
}
.ui-dmg-hit{ color:#ffffff; }
.ui-dmg-crit{ color:#ffae3c; font-size:30px; }
.ui-dmg-heal{ color:#7dff8a; }
.ui-dmg-enemy{ color:#ff5a5a; }
@keyframes ui-dmg-rise{
  0%{ transform:translate(-50%,0) scale(.8); opacity:0; }
  15%{ transform:translate(-50%,-8px) scale(1.1); opacity:1; }
  100%{ transform:translate(-50%,-54px) scale(1); opacity:0; }
}

/* ----- 배너 (대형 중앙 메시지) ----- */
#ui-banner{
  left:50%; top:34%; transform:translate(-50%,-50%);
  font-size:54px; font-weight:900; letter-spacing:4px; text-align:center;
  color:#fff; text-shadow:0 0 18px rgba(159,224,255,.8),0 4px 12px #000;
  animation:ui-banner-in .35s ease-out;
}
@keyframes ui-banner-in{
  0%{ transform:translate(-50%,-50%) scale(.6); opacity:0; }
  100%{ transform:translate(-50%,-50%) scale(1); opacity:1; }
}

/* ----- 토스트 (작은 알림) ----- */
#ui-toast{
  left:50%; top:18%; transform:translateX(-50%);
  background:rgba(10,14,30,.85); border:1px solid rgba(159,224,255,.35);
  border-radius:10px; padding:10px 18px; font-size:14px;
  animation:ui-toast-in .25s ease-out;
}
@keyframes ui-toast-in{
  0%{ transform:translate(-50%,-12px); opacity:0; }
  100%{ transform:translateX(-50%); opacity:1; }
}

/* ----- 캐릭터 선택 모달 (전체화면) ----- */
#ui-charsel{
  inset:0; pointer-events:auto; z-index:60;
  background:rgba(4,7,16,.82); backdrop-filter:blur(6px);
  display:flex; flex-direction:column; align-items:center; justify-content:center;
}
#ui-charsel .ui-cs-title{
  font-size:34px; font-weight:900; letter-spacing:4px; color:#fff;
  text-shadow:0 0 18px rgba(159,224,255,.7),0 4px 12px #000; margin-bottom:6px;
}
#ui-charsel .ui-cs-sub{
  font-size:13px; color:#9fe0ff; opacity:.85; margin-bottom:26px; letter-spacing:.5px;
}
#ui-charsel .ui-cs-cards{ display:flex; gap:18px; flex-wrap:wrap; justify-content:center; }
.ui-cs-card{
  pointer-events:auto; cursor:pointer; width:220px; text-align:left;
  background:rgba(10,14,30,.7); border:1px solid rgba(120,180,255,.25);
  border-radius:14px; padding:18px 18px 20px; position:relative;
  transition:transform .15s, border-color .15s, box-shadow .15s, background .15s;
}
.ui-cs-card:hover{
  transform:translateY(-6px); background:rgba(16,22,46,.85);
  border-color:#9fe0ff; box-shadow:0 10px 30px rgba(0,0,0,.55),0 0 0 1px rgba(159,224,255,.4);
}
.ui-cs-card .ui-cs-idx{
  position:absolute; top:12px; right:12px;
  width:22px; height:22px; line-height:22px; text-align:center;
  font-size:12px; font-weight:700; color:#0e1430; border-radius:6px;
  background:#9fe0ff; box-shadow:0 2px 0 rgba(0,0,0,.35);
}
.ui-cs-card .ui-cs-name{ font-size:22px; font-weight:800; color:#eaf2ff; margin-bottom:6px; }
.ui-cs-card .ui-cs-role{
  display:inline-block; font-size:11px; font-weight:700; letter-spacing:.5px;
  color:#0e1430; background:linear-gradient(180deg,#ffe08a,#f5b73c);
  border-radius:5px; padding:2px 8px; margin-bottom:10px;
}
.ui-cs-card .ui-cs-stats{
  font-size:12px; color:#9fe0ff; font-variant-numeric:tabular-nums; margin-bottom:8px;
}
.ui-cs-card .ui-cs-desc{ font-size:12px; color:rgba(234,242,255,.7); line-height:1.5; }

/* ----- 층 표시 (상단 중앙, 퀘스트와 구분) ----- */
#ui-floor{
  left:50%; top:14px; transform:translateX(-50%);
  background:rgba(10,14,30,.6); border:1px solid rgba(120,180,255,.22);
  border-radius:10px; padding:6px 16px; font-size:14px; font-weight:700;
  letter-spacing:1px; color:#9fe0ff; backdrop-filter:blur(4px);
}

/* ----- 보스 체력바 (상단 중앙) ----- */
#ui-boss{
  left:50%; top:54px; transform:translateX(-50%); width:min(560px,86vw);
  background:rgba(8,4,8,.8); border:1px solid rgba(255,93,108,.5);
  border-radius:10px; padding:8px 12px 10px; backdrop-filter:blur(4px);
  box-shadow:0 6px 28px rgba(120,0,0,.45);
}
#ui-boss .ui-boss-name{
  font-size:14px; font-weight:800; letter-spacing:2px; text-align:center;
  color:#ff9aa3; text-shadow:0 0 10px rgba(255,93,108,.6),0 2px 4px #000; margin-bottom:6px;
}
#ui-boss .ui-boss-bar{
  position:relative; height:16px; border-radius:8px; overflow:hidden;
  background:rgba(0,0,0,.6); border:1px solid rgba(255,93,108,.4);
}
#ui-boss .ui-boss-fill{
  position:absolute; inset:0; width:100%; transform-origin:left center;
  transition:width .2s ease; border-radius:8px;
  background:linear-gradient(180deg,#ff5d6c,#7a0f1c);
  box-shadow:0 0 12px rgba(255,93,108,.6);
}

/* ----- 층 클리어 오버레이 ----- */
#ui-floorclear{
  inset:0; pointer-events:auto; z-index:55;
  display:flex; flex-direction:column; align-items:center; justify-content:center;
  background:radial-gradient(circle at center,rgba(20,16,4,.6),rgba(4,5,10,.85));
}
#ui-floorclear .ui-fc-title{
  font-size:48px; font-weight:900; letter-spacing:5px; text-align:center;
  color:#ffd23f; text-shadow:0 0 24px rgba(255,210,63,.7),0 4px 14px #000;
  animation:ui-banner-in .4s ease-out; margin-bottom:24px;
}
#ui-floorclear .ui-fc-btn{
  pointer-events:auto; cursor:pointer; font-family:var(--ui-font);
  font-size:17px; font-weight:800; letter-spacing:1px; color:#0e1430;
  background:linear-gradient(180deg,#ffe08a,#f5b73c);
  border:none; border-radius:10px; padding:12px 28px;
  box-shadow:0 6px 18px rgba(245,183,60,.4),0 2px 0 rgba(0,0,0,.35);
  transition:transform .12s, box-shadow .12s;
}
#ui-floorclear .ui-fc-btn:hover{
  transform:translateY(-3px); box-shadow:0 10px 26px rgba(245,183,60,.55),0 2px 0 rgba(0,0,0,.35);
}

/* ----- 레벨 업 스킬 선택 모달 (중앙) ----- */
#ui-levelup{
  inset:0; pointer-events:auto; z-index:62;
  background:rgba(4,7,16,.78); backdrop-filter:blur(6px);
  display:flex; flex-direction:column; align-items:center; justify-content:center;
}
#ui-levelup .ui-lu-title{
  font-size:38px; font-weight:900; letter-spacing:4px; color:#ffd23f;
  text-shadow:0 0 22px rgba(255,210,63,.75),0 4px 14px #000;
  animation:ui-banner-in .35s ease-out; margin-bottom:6px;
}
#ui-levelup .ui-lu-sub{
  font-size:13px; color:#9fe0ff; opacity:.85; margin-bottom:26px; letter-spacing:.5px;
}
#ui-levelup .ui-lu-cards{ display:flex; gap:22px; flex-wrap:wrap; justify-content:center; perspective:1200px; }
.ui-lu-card{
  pointer-events:auto; cursor:pointer; width:236px; min-height:220px; text-align:center;
  background:
    radial-gradient(120% 80% at 50% -10%, rgba(255,210,63,.16), rgba(255,210,63,0) 60%),
    linear-gradient(180deg, rgba(30,24,46,.92), rgba(12,12,24,.94));
  border-radius:18px; padding:54px 18px 22px; position:relative; isolation:isolate;
  box-shadow:0 14px 34px rgba(0,0,0,.55), inset 0 1px 0 rgba(255,255,255,.08);
  opacity:0; transform:translateY(26px) scale(.94);
  animation:ui-lu-pop .42s cubic-bezier(.2,.9,.3,1.3) forwards;
  transition:transform .18s ease, box-shadow .18s ease, filter .18s ease;
}
/* 그라디언트 네온 테두리(회전 글로우) */
.ui-lu-card::before{
  content:""; position:absolute; inset:0; border-radius:18px; padding:1.6px; z-index:-1;
  background:conic-gradient(from 0deg, #ffd23f, #ff8a3a, #ff5fae, #8a6bff, #5fd0ff, #ffd23f);
  -webkit-mask:linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite:xor; mask-composite:exclude;
  opacity:.6; animation:ui-lu-hue 8s linear infinite;
}
/* 호버 시 위로 떠오르며 광택 스윕 */
.ui-lu-card::after{
  content:""; position:absolute; inset:0; border-radius:18px; z-index:2; pointer-events:none;
  background:linear-gradient(115deg, transparent 30%, rgba(255,255,255,.28) 48%, transparent 62%);
  transform:translateX(-120%); transition:transform .55s ease;
}
.ui-lu-card:nth-child(2){ animation-delay:.07s; }
.ui-lu-card:nth-child(3){ animation-delay:.14s; }
.ui-lu-card:hover{
  transform:translateY(-12px) scale(1.04); filter:saturate(1.15);
  box-shadow:0 22px 48px rgba(0,0,0,.6), 0 0 28px rgba(255,180,80,.5);
}
.ui-lu-card:hover::before{ opacity:1; animation-duration:2.5s; }
.ui-lu-card:hover::after{ transform:translateX(120%); }
/* 상단 아이콘(보석) */
.ui-lu-card .ui-lu-icon{
  position:absolute; top:14px; left:50%; transform:translateX(-50%);
  font-size:30px; filter:drop-shadow(0 0 12px rgba(255,200,90,.85));
  animation:ui-lu-float 2.6s ease-in-out infinite;
}
.ui-lu-card .ui-lu-idx{
  position:absolute; top:12px; right:12px;
  width:24px; height:24px; line-height:24px; text-align:center;
  font-size:12px; font-weight:800; color:#0e1430; border-radius:7px;
  background:linear-gradient(180deg,#ffe08a,#f5b73c); box-shadow:0 2px 0 rgba(0,0,0,.4),0 0 10px rgba(255,210,63,.5);
}
.ui-lu-card .ui-lu-name{
  font-size:22px; font-weight:900; margin-bottom:10px; letter-spacing:.5px;
  background:linear-gradient(180deg,#fff3c4,#ffce5a); -webkit-background-clip:text; background-clip:text; color:transparent;
  text-shadow:0 0 18px rgba(255,200,90,.35);
}
.ui-lu-card .ui-lu-desc{ font-size:13.5px; color:rgba(234,242,255,.82); line-height:1.6; }
@keyframes ui-lu-pop{ to{ opacity:1; transform:translateY(0) scale(1); } }
@keyframes ui-lu-hue{ to{ filter:hue-rotate(360deg); } }
@keyframes ui-lu-float{ 0%,100%{ transform:translateX(-50%) translateY(0); } 50%{ transform:translateX(-50%) translateY(-5px); } }

/* ----- 보스 보상 스킬 모달 (중앙) ----- */
#ui-bossreward{
  inset:0; pointer-events:auto; z-index:63;
  background:rgba(4,7,16,.8); backdrop-filter:blur(6px);
  display:flex; flex-direction:column; align-items:center; justify-content:center;
}
#ui-bossreward .ui-br-title{
  font-size:36px; font-weight:900; letter-spacing:3px; color:#ff9aa3;
  text-shadow:0 0 22px rgba(255,123,255,.6),0 4px 14px #000;
  animation:ui-banner-in .35s ease-out; margin-bottom:6px;
}
#ui-bossreward .ui-br-sub{
  font-size:13px; color:#9fe0ff; opacity:.85; margin-bottom:26px; letter-spacing:.5px;
}
#ui-bossreward .ui-br-cards{ display:flex; gap:18px; flex-wrap:wrap; justify-content:center; }
.ui-br-card{
  pointer-events:auto; cursor:pointer; width:220px; text-align:left;
  background:rgba(12,10,22,.7); border:1px solid rgba(120,180,255,.25);
  border-radius:14px; padding:20px 18px 22px; position:relative;
  transition:transform .15s, border-color .15s, box-shadow .15s, background .15s;
}
.ui-br-card:hover{
  transform:translateY(-6px); background:rgba(22,18,40,.85);
  box-shadow:0 10px 30px rgba(0,0,0,.55);
}
.ui-br-card .ui-br-idx{
  position:absolute; top:12px; right:12px;
  width:22px; height:22px; line-height:22px; text-align:center;
  font-size:12px; font-weight:700; color:#0e1430; border-radius:6px;
  background:#9fe0ff; box-shadow:0 2px 0 rgba(0,0,0,.35);
}
.ui-br-card .ui-br-name{ font-size:22px; font-weight:800; margin-bottom:6px; }
.ui-br-card .ui-br-tier{
  display:inline-block; font-size:11px; font-weight:700; letter-spacing:.5px;
  color:#0e1430; border-radius:5px; padding:2px 8px; margin-bottom:10px;
}
.ui-br-card .ui-br-desc{ font-size:13px; color:rgba(234,242,255,.78); line-height:1.55; margin-bottom:8px; }
.ui-br-card .ui-br-cd{ font-size:12px; color:#9fe0ff; font-variant-numeric:tabular-nums; }
/* 등급별 색 */
.ui-br-silver{ border-color:#c3ccd6; }
.ui-br-silver .ui-br-name{ color:#c3ccd6; }
.ui-br-silver .ui-br-tier{ background:linear-gradient(180deg,#e6edf5,#c3ccd6); }
.ui-br-silver:hover{ border-color:#e6edf5; box-shadow:0 10px 30px rgba(0,0,0,.55),0 0 0 1px rgba(195,204,214,.5); }
.ui-br-gold{ border-color:#ffcc44; }
.ui-br-gold .ui-br-name{ color:#ffcc44; }
.ui-br-gold .ui-br-tier{ background:linear-gradient(180deg,#ffe08a,#ffcc44); }
.ui-br-gold:hover{ border-color:#ffe08a; box-shadow:0 10px 30px rgba(0,0,0,.55),0 0 0 1px rgba(255,204,68,.5),0 0 22px rgba(255,204,68,.35); }
.ui-br-prism{
  border-color:#c07bff;
  background:linear-gradient(160deg,rgba(40,20,60,.75),rgba(12,10,22,.7));
  box-shadow:0 0 18px rgba(192,123,255,.3);
}
.ui-br-prism .ui-br-name{
  color:#c07bff;
  text-shadow:0 0 10px rgba(192,123,255,.6);
}
.ui-br-prism .ui-br-tier{ background:linear-gradient(180deg,#e0b8ff,#c07bff); }
.ui-br-prism:hover{
  border-color:#e0b8ff;
  box-shadow:0 10px 30px rgba(0,0,0,.55),0 0 0 1px rgba(192,123,255,.6),0 0 30px rgba(192,123,255,.55);
}

/* ----- 슬롯 선택 모달 (중앙) ----- */
#ui-slotpick{
  inset:0; pointer-events:auto; z-index:64;
  background:rgba(4,7,16,.8); backdrop-filter:blur(6px);
  display:flex; flex-direction:column; align-items:center; justify-content:center;
}
#ui-slotpick .ui-sp-title{
  font-size:28px; font-weight:900; letter-spacing:2px; color:#9fe0ff;
  text-shadow:0 0 18px rgba(159,224,255,.6),0 4px 12px #000;
  animation:ui-banner-in .35s ease-out; margin-bottom:6px; text-align:center;
}
#ui-slotpick .ui-sp-sub{
  font-size:13px; color:#9fe0ff; opacity:.85; margin-bottom:26px; letter-spacing:.5px;
}
#ui-slotpick .ui-sp-row{ display:flex; gap:16px; flex-wrap:wrap; justify-content:center; }
.ui-sp-btn{
  pointer-events:auto; cursor:pointer; width:150px; text-align:center;
  background:rgba(10,14,30,.7); border:1px solid rgba(120,180,255,.3);
  border-radius:12px; padding:18px 14px; font-family:var(--ui-font);
  transition:transform .15s, border-color .15s, box-shadow .15s, background .15s;
}
.ui-sp-btn:hover{
  transform:translateY(-5px); background:rgba(16,22,46,.85);
  border-color:#9fe0ff; box-shadow:0 10px 26px rgba(0,0,0,.55),0 0 0 1px rgba(159,224,255,.4);
}
.ui-sp-btn .ui-sp-key{
  display:inline-flex; align-items:center; justify-content:center;
  width:34px; height:34px; margin-bottom:10px;
  background:#9fe0ff; color:#0e1430; font-weight:800; font-size:18px;
  border-radius:8px; box-shadow:0 2px 0 rgba(0,0,0,.35);
}
.ui-sp-btn .ui-sp-cur{ font-size:14px; font-weight:700; color:#eaf2ff; }
.ui-sp-btn .ui-sp-empty{ color:rgba(234,242,255,.45); }

/* ----- 액티브 스킬 HUD 바 (하단 중앙) ----- */
#ui-actives{
  left:50%; bottom:132px; transform:translateX(-50%);
  z-index:30; display:flex; gap:10px; pointer-events:none;
}
.ui-act-slot{
  position:relative; width:62px; height:62px; overflow:hidden;
  background:rgba(10,14,30,.6); border:1px solid rgba(120,180,255,.28);
  border-radius:10px; backdrop-filter:blur(4px);
  display:flex; flex-direction:column; align-items:center; justify-content:center;
}
.ui-act-slot.ui-act-empty{ border-color:rgba(120,180,255,.14); background:rgba(10,14,30,.4); }
.ui-act-slot .ui-act-key{
  position:absolute; top:3px; left:5px; font-size:11px; font-weight:800;
  color:#9fe0ff; text-shadow:0 1px 2px #000;
}
.ui-act-slot .ui-act-name{
  font-size:10px; font-weight:600; line-height:1.15; text-align:center;
  color:#eaf2ff; padding:0 3px; margin-top:6px;
  max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
}
.ui-act-slot.ui-act-empty .ui-act-name{ color:rgba(234,242,255,.35); }
.ui-act-slot .ui-act-cd{
  position:absolute; left:0; top:0; width:100%; height:0%;
  background:rgba(2,4,10,.66); pointer-events:none;
  transition:height .08s linear;
}
`;

// ---------- 공개 API ----------
export const UI = {
  // 모든 오버레이 DOM 과 <style> 을 1회 생성. 다시 불러도 안전.
  init() {
    if (inited) return;
    if (typeof document === "undefined") return;

    // CSS 주입
    const style = document.createElement("style");
    style.setAttribute("data-ui", "aethering");
    style.textContent = CSS;
    (document.head || document.body).appendChild(style);

    // 루트
    const root = mk("div", "", document.body);
    root.id = "ui-root";
    el.root = root;

    // --- 활력(HP/XP/골드) 패널 ---
    const vit = mk("div", "ui-overlay", root); vit.id = "ui-vitals";
    const hpRow = mk("div", "ui-row", vit);
    el.lvl = mk("div", "ui-lvl", hpRow); el.lvl.textContent = "Lv 1";
    const hpBar = mk("div", "ui-bar", hpRow);
    el.hpFill = mk("div", "ui-bar-fill", hpBar); el.hpFill.id = "ui-hp-fill";
    el.hpLabel = mk("div", "ui-bar-label", hpBar); el.hpLabel.textContent = "100/100";

    const xpRow = mk("div", "ui-row", vit);
    const xpBar = mk("div", "ui-bar", xpRow); xpBar.id = "ui-xp-bar";
    el.xpFill = mk("div", "ui-bar-fill", xpBar); el.xpFill.id = "ui-xp-fill";
    el.xpLabel = mk("div", "ui-bar-label", xpBar); el.xpLabel.textContent = "0/100";

    const goldRow = mk("div", "ui-row", vit);
    const gold = mk("div", "ui-gold", goldRow);
    mk("span", "ui-coin", gold);
    el.gold = mk("span", "", gold); el.gold.textContent = "0";

    // --- 퀘스트 추적 ---
    const q = mk("div", "ui-overlay ui-hidden", root); q.id = "ui-quests";
    const qh = mk("div", "ui-q-head", q); qh.textContent = "퀘스트";
    el.questList = mk("div", "", q);
    el.quests = q;

    // --- 상호작용 프롬프트 ---
    const prompt = mk("div", "ui-overlay ui-hidden", root); prompt.id = "ui-prompt";
    el.promptKey = mk("span", "ui-key", prompt); el.promptKey.textContent = "E";
    el.promptText = mk("span", "", prompt); el.promptText.textContent = "대화";
    el.prompt = prompt;

    // --- 대화창 ---
    const dlg = mk("div", "ui-overlay ui-hidden", root); dlg.id = "ui-dialogue";
    el.dName = mk("div", "ui-d-name", dlg);
    el.dLines = mk("div", "ui-d-lines", dlg);
    el.dOpts = mk("div", "ui-d-opts", dlg);
    el.dialogue = dlg;

    // --- 플로팅 데미지 레이어 ---
    dmgLayer = mk("div", "ui-overlay", root); dmgLayer.id = "ui-dmg";
    el.dmg = dmgLayer;

    // --- 배너 ---
    const banner = mk("div", "ui-overlay ui-hidden", root); banner.id = "ui-banner";
    el.banner = banner;

    // --- 토스트 ---
    const toast = mk("div", "ui-overlay ui-hidden", root); toast.id = "ui-toast";
    el.toast = toast;

    // --- 층 표시 (상단 중앙) ---
    const floor = mk("div", "ui-overlay ui-hidden", root); floor.id = "ui-floor";
    el.floor = floor;

    // --- 보스 체력바 (상단 중앙) ---
    const boss = mk("div", "ui-overlay ui-hidden", root); boss.id = "ui-boss";
    el.bossName = mk("div", "ui-boss-name", boss);
    const bossBar = mk("div", "ui-boss-bar", boss);
    el.bossFill = mk("div", "ui-boss-fill", bossBar);
    el.boss = boss;

    // --- 액티브 스킬 HUD 바 (하단 중앙) ---
    const actives = mk("div", "ui-overlay ui-hidden", root); actives.id = "ui-actives";
    el.actives = actives;

    inited = true;
  },

  // 체력바 — 비율에 따라 초록→빨강. "cur/max" 표시.
  setHP(cur, max) {
    if (!el.hpFill) return;
    max = Math.max(1, max || 0);
    cur = Math.max(0, Math.min(cur || 0, max));
    const r = cur / max;
    el.hpFill.style.width = (r * 100).toFixed(1) + "%";
    // hue: 0(빨강)~120(초록)
    const hue = Math.round(120 * r);
    el.hpFill.style.background = `linear-gradient(180deg,hsl(${hue} 85% 62%),hsl(${hue} 80% 46%))`;
    el.hpLabel.textContent = `${Math.round(cur)}/${Math.round(max)}`;
  },

  // 경험치바 + 레벨.
  setXP(cur, max, level) {
    if (!el.xpFill) return;
    max = Math.max(1, max || 0);
    cur = Math.max(0, Math.min(cur || 0, max));
    el.xpFill.style.width = ((cur / max) * 100).toFixed(1) + "%";
    el.xpLabel.textContent = `${Math.round(cur)}/${Math.round(max)}`;
    if (level != null) el.lvl.textContent = "Lv " + level;
  },

  // 골드 카운터.
  setGold(n) {
    if (!el.gold) return;
    el.gold.textContent = String(Math.round(n || 0));
  },

  // 퀘스트 추적 렌더. list 비면 패널 숨김.
  setQuests(list) {
    if (!el.questList) return;
    list = Array.isArray(list) ? list : [];
    if (list.length === 0) {
      el.quests.classList.add("ui-hidden");
      el.questList.innerHTML = "";
      return;
    }
    el.quests.classList.remove("ui-hidden");
    el.questList.innerHTML = "";
    for (const it of list) {
      const row = mk("div", "ui-quest" + (it && it.done ? " ui-q-done" : ""), el.questList);
      const t = mk("div", "ui-q-title", row);
      const name = mk("span", "", t); name.textContent = (it && it.title) || "퀘스트";
      const prog = mk("span", "ui-q-prog", t);
      const cnt = it && it.count != null ? it.count : 0;
      const cur = it && it.progress != null ? it.progress : 0;
      prog.textContent = `${cur}/${cnt}`;
      if (it && it.desc) {
        const d = mk("div", "ui-q-desc", row); d.textContent = it.desc;
      }
    }
  },

  // 상호작용 프롬프트 표시 — text 예: "대화", "줍기".
  showPrompt(text) {
    if (!el.prompt) return;
    el.promptText.textContent = text || "상호작용";
    el.prompt.classList.remove("ui-hidden");
  },
  hidePrompt() {
    if (!el.prompt) return;
    el.prompt.classList.add("ui-hidden");
  },

  // 대화창. name=화자, lines=문장 배열, options=[{label}], onChoose(i).
  // options 비면 "닫기" 버튼이 onChoose(-1) 호출.
  showDialogue(name, lines, options, onChoose) {
    if (!el.dialogue) return;
    el.dName.textContent = name || "";
    const arr = Array.isArray(lines) ? lines : (lines != null ? [String(lines)] : []);
    el.dLines.innerHTML = arr.map((s) => String(s)).join("<br>");

    el.dOpts.innerHTML = "";
    const cb = typeof onChoose === "function" ? onChoose : function () {};
    const opts = Array.isArray(options) ? options : [];
    if (opts.length === 0) {
      const b = mk("button", "ui-d-opt", el.dOpts);
      b.textContent = "닫기";
      b.addEventListener("click", () => { UI.hideDialogue(); cb(-1); });
    } else {
      opts.forEach((o, i) => {
        const b = mk("button", "ui-d-opt", el.dOpts);
        b.textContent = (o && o.label) || ("선택 " + (i + 1));
        b.addEventListener("click", () => cb(i));
      });
    }
    el.dialogue.classList.remove("ui-hidden");
  },
  hideDialogue() {
    if (!el.dialogue) return;
    el.dialogue.classList.add("ui-hidden");
  },

  // 화면 픽셀좌표(x,y)에 떠오르는 데미지 숫자. 0.9s 후 자동 제거.
  // type: 'hit' | 'crit' | 'heal' | 'enemy'
  floatDamage(x, y, amount, type) {
    if (!dmgLayer) return;
    if (dmgCount >= DMG_CAP) return;            // 성능 캡
    const t = type || "hit";
    const n = mk("div", "ui-dmg-num ui-dmg-" + t, dmgLayer);
    n.style.left = (x || 0) + "px";
    n.style.top = (y || 0) + "px";
    const val = Math.round(Math.abs(amount || 0));
    n.textContent = (t === "heal" ? "+" : "") + val + (t === "crit" ? "!" : "");
    dmgCount++;
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return; cleaned = true;
      dmgCount = Math.max(0, dmgCount - 1);
      if (n.remove) n.remove();
    };
    n.addEventListener("animationend", cleanup);
    // animationend 가 안 와도 회수 보장
    setTimeout(cleanup, 1200);
  },

  // 대형 중앙 배너 — ms 후 자동 숨김.
  banner(text, ms) {
    if (!el.banner) return;
    el.banner.textContent = text || "";
    el.banner.classList.remove("ui-hidden");
    if (bannerTimer) clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => {
      if (el.banner) el.banner.classList.add("ui-hidden");
      bannerTimer = null;
    }, ms || 1500);
  },

  // 작은 일시 알림.
  toast(msg) {
    if (!el.toast) return;
    el.toast.textContent = msg || "";
    el.toast.classList.remove("ui-hidden");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      if (el.toast) el.toast.classList.add("ui-hidden");
      toastTimer = null;
    }, 2600);
  },

  // 캐릭터 선택 모달. options=[{key,name,role,hp,dmg,speed,desc}], onPick(key).
  // 카드 클릭 또는 1·2·3 숫자키로 선택 → onPick 호출 후 자동 닫힘.
  showCharSelect(options, onPick) {
    if (!el.root || typeof document === "undefined") return;
    const opts = Array.isArray(options) ? options : [];
    const pick = typeof onPick === "function" ? onPick : function () {};

    // 기존 모달 정리 (재호출 안전)
    UI.hideCharSelect();

    const modal = mk("div", "ui-overlay", el.root); modal.id = "ui-charsel";
    const title = mk("div", "ui-cs-title", modal); title.textContent = "캐릭터 선택";
    const sub = mk("div", "ui-cs-sub", modal);
    sub.textContent = "카드를 클릭하거나 1·2·3 키로 선택";
    const cards = mk("div", "ui-cs-cards", modal);

    const choose = (o) => {
      if (!o) return;
      UI.hideCharSelect();
      pick(o.key);
    };

    opts.forEach((o, i) => {
      o = o || {};
      const card = mk("div", "ui-cs-card", cards);
      const idx = mk("div", "ui-cs-idx", card); idx.textContent = String(i + 1);
      const name = mk("div", "ui-cs-name", card); name.textContent = o.name || ("선택 " + (i + 1));
      if (o.role) { const r = mk("div", "ui-cs-role", card); r.textContent = o.role; }
      const stats = mk("div", "ui-cs-stats", card);
      stats.textContent = `체력 ${o.hp != null ? o.hp : "-"} · 공격 ${o.dmg != null ? o.dmg : "-"} · 속도 ${o.speed != null ? o.speed : "-"}`;
      const desc = mk("div", "ui-cs-desc", card); desc.textContent = o.desc || "";
      card.addEventListener("click", () => choose(o));
    });

    // 숫자키 1/2/3 선택
    charKeyHandler = (e) => {
      const k = e && (e.key || e.keyCode);
      let i = -1;
      if (k === "1" || k === 49) i = 0;
      else if (k === "2" || k === 50) i = 1;
      else if (k === "3" || k === 51) i = 2;
      if (i >= 0 && i < opts.length) choose(opts[i]);
    };
    if (typeof window !== "undefined" && window.addEventListener) {
      window.addEventListener("keydown", charKeyHandler);
    }

    el.charsel = modal;
  },

  // 캐릭터 선택 모달 닫기 + 키 리스너 제거.
  hideCharSelect() {
    if (charKeyHandler && typeof window !== "undefined" && window.removeEventListener) {
      window.removeEventListener("keydown", charKeyHandler);
    }
    charKeyHandler = null;
    if (el.charsel) {
      if (el.charsel.remove) el.charsel.remove();
      el.charsel = null;
    }
  },

  // 현재 층 표시 — "N층 · 지역명". 플레이 중 항상 노출.
  setFloor(n, region) {
    if (!el.floor) return;
    const f = Math.max(1, Math.round(n || 1));
    el.floor.textContent = region ? `${f}층 · ${region}` : `${f}층`;
    el.floor.classList.remove("ui-hidden");
  },

  // 보스 체력바 표시. name=보스명, hpRatio=0..1.
  setBoss(name, hpRatio) {
    if (!el.boss) return;
    el.bossName.textContent = name || "보스";
    const r = Math.max(0, Math.min(hpRatio != null ? hpRatio : 1, 1));
    el.bossFill.style.width = (r * 100).toFixed(1) + "%";
    el.boss.classList.remove("ui-hidden");
  },
  hideBoss() {
    if (!el.boss) return;
    el.boss.classList.add("ui-hidden");
  },

  // 층 클리어 축하 오버레이. "다음 층으로 ▶" 버튼이 onNext() 호출 후 닫힘.
  // onNext 미제공 시 즉시 자동 진행(오버레이만 표시 후 닫힘).
  floorClear(n, onNext) {
    if (!el.root || typeof document === "undefined") return;
    const f = Math.max(1, Math.round(n || 1));
    const next = typeof onNext === "function" ? onNext : null;

    // 기존 오버레이 정리
    if (el.floorclear) {
      if (el.floorclear.remove) el.floorclear.remove();
      el.floorclear = null;
    }

    const overlay = mk("div", "ui-overlay", el.root); overlay.id = "ui-floorclear";
    const title = mk("div", "ui-fc-title", overlay);
    title.textContent = `${f}층 클리어!`;
    const btn = mk("button", "ui-fc-btn", overlay);
    btn.textContent = "다음 층으로 ▶";

    const proceed = () => {
      if (el.floorclear) {
        if (el.floorclear.remove) el.floorclear.remove();
        el.floorclear = null;
      }
      if (next) next();
    };
    btn.addEventListener("click", proceed);
    el.floorclear = overlay;

    // onNext 미제공 시 잠깐 보여준 뒤 자동 닫힘
    if (!next) {
      setTimeout(() => {
        if (el.floorclear === overlay) {
          if (overlay.remove) overlay.remove();
          el.floorclear = null;
        }
      }, 1800);
    }
  },

  // 레벨 업 스킬 선택 모달. choices=[{name,desc}] (최대 3), onPick(i).
  // 카드 클릭 또는 1·2·3 숫자키로 선택 → onPick 호출 후 자동 닫힘.
  showLevelUp(choices, onPick, onSkip) {
    if (!el.root || typeof document === "undefined") return;
    const opts = (Array.isArray(choices) ? choices : []).slice(0, 3);
    const pick = typeof onPick === "function" ? onPick : function () {};
    const skip = typeof onSkip === "function" ? onSkip : null;

    // 기존 모달 정리 (재호출 안전)
    UI.hideLevelUp();

    const modal = mk("div", "ui-overlay", el.root); modal.id = "ui-levelup";
    const title = mk("div", "ui-lu-title", modal); title.textContent = "레벨 업!";
    const sub = mk("div", "ui-lu-sub", modal);
    sub.textContent = skip ? "스킬을 선택하세요 (1·2·3 / 클릭 · 건너뛰기 0)" : "스킬을 선택하세요 (1·2·3 또는 클릭)";
    const cards = mk("div", "ui-lu-cards", modal);

    // 보스 처치 직후 연타로 인한 즉시 오선택 방지: 개봉 후 잠깐(450ms)은 선택을 무시한다.
    const openedAt = Date.now();
    const ARM_MS = 450;
    const armed = () => Date.now() - openedAt >= ARM_MS;
    const choose = (i) => {
      if (!armed()) return;
      if (i < 0 || i >= opts.length) return;
      UI.hideLevelUp();
      pick(i);
    };
    const doSkip = () => { if (!skip || !armed()) return; UI.hideLevelUp(); skip(); };

    opts.forEach((c, i) => {
      c = c || {};
      const card = mk("div", "ui-lu-card", cards);
      const icon = mk("div", "ui-lu-icon", card); icon.textContent = ["💎", "🔮", "⚜️", "✨"][i % 4];
      const idx = mk("div", "ui-lu-idx", card); idx.textContent = String(i + 1);
      const name = mk("div", "ui-lu-name", card); name.textContent = c.name || ("스킬 " + (i + 1));
      const desc = mk("div", "ui-lu-desc", card); desc.textContent = c.desc || "";
      card.addEventListener("click", () => choose(i));
    });

    if (skip) {
      const skBtn = mk("button", "ui-fc-btn", modal);
      skBtn.textContent = "건너뛰기 (체력+공격 보너스)";
      skBtn.style.marginTop = "14px";
      skBtn.addEventListener("click", doSkip);
    }

    // 숫자키 1/2/3 선택, 0/Esc 건너뛰기
    levelKeyHandler = (e) => {
      const k = e && (e.key || e.keyCode);
      let i = -1;
      if (k === "1" || k === 49) i = 0;
      else if (k === "2" || k === 50) i = 1;
      else if (k === "3" || k === 51) i = 2;
      else if (skip && (k === "0" || k === 48 || k === "Escape" || k === 27)) { doSkip(); return; }
      if (i >= 0 && i < opts.length) choose(i);
    };
    if (typeof window !== "undefined" && window.addEventListener) {
      window.addEventListener("keydown", levelKeyHandler);
    }

    el.levelup = modal;
  },

  // 레벨 업 모달 닫기 + 키 리스너 제거.
  hideLevelUp() {
    if (levelKeyHandler && typeof window !== "undefined" && window.removeEventListener) {
      window.removeEventListener("keydown", levelKeyHandler);
    }
    levelKeyHandler = null;
    if (el.levelup) {
      if (el.levelup.remove) el.levelup.remove();
      el.levelup = null;
    }
  },

  // 보스 처치 보상 스킬 모달. choices=[{name,tier,desc,cd}] (최대 3), onPick(i).
  // tier ∈ 'silver'|'gold'|'prism'. 카드 클릭 또는 1·2·3 키 → onPick 후 자동 닫힘.
  showBossReward(choices, onPick, onSkip) {
    if (!el.root || typeof document === "undefined") return;
    const opts = (Array.isArray(choices) ? choices : []).slice(0, 3);
    const pick = typeof onPick === "function" ? onPick : function () {};
    const skip = typeof onSkip === "function" ? onSkip : null;
    const TIER = { silver: "실버", gold: "골드", prism: "프리즘" };

    // 기존 모달 정리 (재호출 안전)
    UI.hideBossReward();

    const modal = mk("div", "ui-overlay", el.root); modal.id = "ui-bossreward";
    const title = mk("div", "ui-br-title", modal); title.textContent = "보스 처치! 스킬 획득";
    const sub = mk("div", "ui-br-sub", modal);
    sub.textContent = skip ? "1·2·3 / 클릭 · 건너뛰기 0" : "1·2·3 또는 클릭";
    const cards = mk("div", "ui-br-cards", modal);

    // 보스 처치 직후 연타로 인한 즉시 오선택 방지: 개봉 후 잠깐(450ms)은 선택을 무시한다.
    const openedAt = Date.now();
    const ARM_MS = 450;
    const armed = () => Date.now() - openedAt >= ARM_MS;
    const choose = (i) => {
      if (!armed()) return;
      if (i < 0 || i >= opts.length) return;
      UI.hideBossReward();
      pick(i);
    };
    const doSkip = () => { if (!skip || !armed()) return; UI.hideBossReward(); skip(); };

    opts.forEach((c, i) => {
      c = c || {};
      const tier = c.tier === "gold" || c.tier === "prism" ? c.tier : "silver";
      const card = mk("div", "ui-br-card ui-br-" + tier, cards);
      const idx = mk("div", "ui-br-idx", card); idx.textContent = String(i + 1);
      const name = mk("div", "ui-br-name", card); name.textContent = c.name || ("스킬 " + (i + 1));
      const tl = mk("div", "ui-br-tier", card); tl.textContent = TIER[tier];
      const desc = mk("div", "ui-br-desc", card); desc.textContent = c.desc || "";
      const cd = mk("div", "ui-br-cd", card);
      cd.textContent = `쿨다운 ${c.cd != null ? c.cd : "-"}초`;
      card.addEventListener("click", () => choose(i));
    });

    if (skip) {
      const skBtn = mk("button", "ui-fc-btn", modal);
      skBtn.textContent = "건너뛰기 (획득 안 함)";
      skBtn.style.marginTop = "14px";
      skBtn.addEventListener("click", doSkip);
    }

    // 숫자키 1/2/3 선택, 0/Esc 건너뛰기
    bossRewardKeyHandler = (e) => {
      const k = e && (e.key || e.keyCode);
      let i = -1;
      if (k === "1" || k === 49) i = 0;
      else if (k === "2" || k === 50) i = 1;
      else if (k === "3" || k === 51) i = 2;
      else if (skip && (k === "0" || k === 48 || k === "Escape" || k === 27)) { doSkip(); return; }
      if (i >= 0 && i < opts.length) choose(i);
    };
    if (typeof window !== "undefined" && window.addEventListener) {
      window.addEventListener("keydown", bossRewardKeyHandler);
    }

    el.bossreward = modal;
  },

  // 보스 보상 모달 닫기 + 키 리스너 제거.
  hideBossReward() {
    if (bossRewardKeyHandler && typeof window !== "undefined" && window.removeEventListener) {
      window.removeEventListener("keydown", bossRewardKeyHandler);
    }
    bossRewardKeyHandler = null;
    if (el.bossreward) {
      if (el.bossreward.remove) el.bossreward.remove();
      el.bossreward = null;
    }
  },

  // 스킬 장착 슬롯 선택 모달. slots=[{key,name}] (4개, key='Q'/'W'/'E'/'R'),
  // skillName=장착할 스킬 이름. 버튼 클릭 또는 Q/W/E/R 키 → onPick(i) 후 자동 닫힘.
  showSlotPicker(slots, skillName, onPick) {
    if (!el.root || typeof document === "undefined") return;
    const arr = (Array.isArray(slots) ? slots : []).slice(0, 4);
    const pick = typeof onPick === "function" ? onPick : function () {};

    // 기존 모달 정리 (재호출 안전)
    UI.hideSlotPicker();

    const modal = mk("div", "ui-overlay", el.root); modal.id = "ui-slotpick";
    const title = mk("div", "ui-sp-title", modal);
    title.textContent = `'${skillName || "스킬"}' 장착 — 교체할 슬롯 선택`;
    const sub = mk("div", "ui-sp-sub", modal);
    sub.textContent = "버튼을 클릭하거나 Q·W·E·R 키로 선택";
    const row = mk("div", "ui-sp-row", modal);

    const choose = (i) => {
      if (i < 0 || i >= arr.length) return;
      UI.hideSlotPicker();
      pick(i);
    };

    arr.forEach((s, i) => {
      s = s || {};
      const key = (s.key || ["Q", "W", "E", "R"][i] || "?").toString().toUpperCase();
      const btn = mk("button", "ui-sp-btn", row);
      const kEl = mk("div", "ui-sp-key", btn); kEl.textContent = key;
      const nm = s.name || "비어있음";
      const cur = mk("div", "ui-sp-cur" + (nm === "비어있음" ? " ui-sp-empty" : ""), btn);
      cur.textContent = nm;
      btn.addEventListener("click", () => choose(i));
    });

    // Q/W/E/R 키 선택 — 모달의 슬롯 key 와 매칭
    slotPickKeyHandler = (e) => {
      let k = e && (e.key || e.keyCode);
      if (typeof k === "number") k = String.fromCharCode(k);
      k = (k || "").toString().toUpperCase();
      let i = -1;
      for (let j = 0; j < arr.length; j++) {
        const sk = ((arr[j] && arr[j].key) || ["Q", "W", "E", "R"][j] || "").toString().toUpperCase();
        if (sk === k) { i = j; break; }
      }
      if (i >= 0) choose(i);
    };
    if (typeof window !== "undefined" && window.addEventListener) {
      window.addEventListener("keydown", slotPickKeyHandler);
    }

    el.slotpick = modal;
  },

  // 슬롯 선택 모달 닫기 + 키 리스너 제거.
  hideSlotPicker() {
    if (slotPickKeyHandler && typeof window !== "undefined" && window.removeEventListener) {
      window.removeEventListener("keydown", slotPickKeyHandler);
    }
    slotPickKeyHandler = null;
    if (el.slotpick) {
      if (el.slotpick.remove) el.slotpick.remove();
      el.slotpick = null;
    }
  },

  // 장착된 액티브 스킬 HUD 바 갱신. slots=[{key,name,cdRatio}] (4개).
  // cdRatio 0..1 (1=완전 쿨다운, 0=사용 가능). 매 프레임 호출해도 저렴하도록
  // 슬롯 DOM 은 1회 생성 후 재사용한다.
  setActives(slots) {
    if (!el.actives) return;
    const arr = Array.isArray(slots) ? slots : [];

    // 슬롯 DOM 최초 1회 생성 (4개 고정)
    if (!actSlots) {
      actSlots = [];
      const keys = ["Q", "W", "E", "R"];
      for (let i = 0; i < 4; i++) {
        const slot = mk("div", "ui-act-slot", el.actives);
        const kEl = mk("div", "ui-act-key", slot); kEl.textContent = keys[i];
        const nm = mk("div", "ui-act-name", slot);
        const cd = mk("div", "ui-act-cd", slot);
        actSlots.push({ slot: slot, key: kEl, name: nm, cd: cd });
      }
    }

    for (let i = 0; i < 4; i++) {
      const s = arr[i] || {};
      const ref = actSlots[i];
      const key = (s.key || ["Q", "W", "E", "R"][i]).toString().toUpperCase();
      const name = s.name != null ? String(s.name) : "";
      const empty = name === "";
      if (ref.key.textContent !== key) ref.key.textContent = key;
      if (ref.name.textContent !== name) ref.name.textContent = name;
      if (ref.slot.classList) ref.slot.classList.toggle("ui-act-empty", empty);
      let r = typeof s.cdRatio === "number" ? s.cdRatio : 0;
      r = Math.max(0, Math.min(r, 1));
      ref.cd.style.height = (r * 100).toFixed(1) + "%";
    }

    el.actives.classList.remove("ui-hidden");
  },
};
