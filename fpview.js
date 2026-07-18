/* =====================================================================
   FPVIEW — OutRun-style first-person cockpit cam for HEAT   (Phase 1)
   ---------------------------------------------------------------------
   A self-contained drop-in. Loads AFTER js/game.js:

       <script src="js/fpview.js"></script>

   Nothing in game.js changes. The module runs a cheap watcher loop and,
   whenever the (active) human car is visually moving along the track —
   card movement, boost, adrenaline, slipstream, knock-backs, spin-outs —
   it fades a canvas over #trackwrap and renders the run from the
   driver's seat: true flat-plane projection of the traced centreline,
   rumble strips, corner boards with live speed limits, chequered
   start/finish gantry, tunnels, and every other car as a billboard
   sprite you overtake (or get mugged by) in real time. When the car
   settles it lingers a beat, then fades back to the board.

   It reads the same animation state stepCar() writes (p._v.total /
   p._v.off), so what you see in the windshield is exactly what the
   top-down cars are doing — including lane drift and blocking.

   Controls / API:
       tap or click the view ....... dismiss for the current move
       V key ....................... toggle the cam on/off for the race
       FPCAM.enabled = false ....... disable from console / other code
   ===================================================================== */
(function(){
"use strict";

/* bail out quietly if the game script didn't load */
if(typeof G === "undefined" || typeof PT !== "function"){ return; }

const FP = window.FPCAM = {
  enabled : true,       // master switch (V key toggles)
  active  : false,      // currently shown
  snooze  : false,      // tap-to-skip for the current move
  linger  : 0,          // hide deadline after the car settles
  cam     : { total:0, off:0, head:null, roll:0, spd:0, bob:0 },
  lastT   : 0
};

/* ---------- tuning ---------- */
const VIEW_SPACES = 16;     // how far ahead we draw, in Spaces
const STEP        = 0.22;   // centreline sampling step, in Spaces
const NEAR        = 3.0;    // near clip, world px
const ROAD_HW     = 19;     // road half-width, world px (spots sit at ±9)
const KERB_W      = 4.5;    // rumble strip width, world px
const CAR_W       = 15;     // opponent sprite width, world px
const CAM_H       = 10;     // camera height above the road plane, world px
const LINGER_MS   = 850;    // how long to hold the view after settling

const REDUCED = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ---------- theme (read once from the stylesheet, with fallbacks) ---------- */
function cssVar(n, fb){
  const v = getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  return v || fb;
}
const THEME = {
  purple : cssVar("--purple",      "#8a5cf6"),
  glow   : cssVar("--purple-glow", "#a985ff"),
  deep   : cssVar("--purple-deep", "#4b2fa8"),
  cream  : cssVar("--cream",       "#f0e7d3"),
  dim    : cssVar("--cream-dim",   "#b9ae95"),
  grass  : cssVar("--grass",       "#2c3a24"),
};

/* ---------- DOM: canvas overlay inside #trackwrap ---------- */
const wrap = document.getElementById("trackwrap");
if(!wrap) return;

const style = document.createElement("style");
style.textContent = `
  #fpcam{position:absolute; inset:0; z-index:40; opacity:0; pointer-events:none;
         transition:opacity .32s ease; background:#0d0a13}
  #fpcam.on{opacity:1; pointer-events:auto}
  #fpchip{position:absolute; top:8px; right:10px; z-index:41; opacity:0; pointer-events:none;
          transition:opacity .32s ease; font:700 9px/1.2 var(--mono, monospace);
          letter-spacing:1.6px; text-transform:uppercase; color:${THEME.dim};
          background:rgba(13,10,19,.55); border:1px solid ${THEME.deep};
          border-radius:8px; padding:4px 8px}
  #fpcam.on ~ #fpchip{opacity:1}
`;
document.head.appendChild(style);

const cv = document.createElement("canvas");
cv.id = "fpcam";
wrap.appendChild(cv);
const chip = document.createElement("div");
chip.id = "fpchip";
chip.textContent = "● cockpit cam — tap to skip · V toggles";
wrap.appendChild(chip);
const ctx = cv.getContext("2d");

let W=0, H=0, DPR=1;
function fit(){
  const r = wrap.getBoundingClientRect();
  DPR = Math.min(2, window.devicePixelRatio||1);
  W = Math.max(2, r.width); H = Math.max(2, r.height);
  cv.width = Math.round(W*DPR); cv.height = Math.round(H*DPR);
  cv.style.width = W+"px"; cv.style.height = H+"px";
}
fit();
if(window.ResizeObserver) new ResizeObserver(fit).observe(wrap);
else addEventListener("resize", fit);

cv.addEventListener("pointerdown", ()=>{ FP.snooze = true; hide(); });
addEventListener("keydown", e=>{
  if(e.key==="v" || e.key==="V"){
    FP.enabled = !FP.enabled;
    if(!FP.enabled) hide();
    if(typeof toast === "function") toast(FP.enabled ? "Cockpit cam ON" : "Cockpit cam OFF");
  }
});

function show(){ if(FP.active) return; FP.active = true; cv.classList.add("on"); }
function hide(){ if(!FP.active) return; FP.active = false; cv.classList.remove("on"); }

/* ---------- geometry helpers ---------- */
/* centreline pose at a fractional total (position + tangent + normal) */
function lerpPose(totF){
  const i = Math.floor(totF), f = totF - i;
  const a = PT(phys(i)), b = PT(phys(i+1));
  if(!a || !b) return null;
  return {
    x : a.x + (b.x-a.x)*f,  y : a.y + (b.y-a.y)*f,
    tx: a.tx + (b.tx-a.tx)*f, ty: a.ty + (b.ty-a.ty)*f,
    nx: a.nx + (b.nx-a.nx)*f, ny: a.ny + (b.ny-a.ny)*f
  };
}
const shortTurn = (from, to) => { let d=(to-from)%(2*Math.PI);
  if(d> Math.PI) d-=2*Math.PI; if(d<-Math.PI) d+=2*Math.PI; return d; };

/* project a world point into the current camera frame.
   Returns null when behind the near plane. */
function makeProjector(cam){
  const fx = Math.cos(cam.head), fy = Math.sin(cam.head);   // forward (y-down board)
  const rx = -fy, ry = fx;                                   // screen-right
  const FOCAL = H * 1.05;
  const horizon = H * 0.40 + cam.bob;
  return {
    horizon,
    proj(px, py){
      const dx = px - cam.x, dy = py - cam.y;
      const zf = dx*fx + dy*fy;
      if(zf < NEAR) return null;
      const lat = dx*rx + dy*ry;
      const s = FOCAL / zf;
      return { x: W/2 + lat*s, y: horizon + CAM_H*s, s, z: zf };
    }
  };
}

/* corner-line totals ahead of the camera (uses the game's own lap-aware list) */
function cornersAhead(fromTot, span){
  const out = [];
  try{
    for(const c of cornerTotals()){
      if(c > fromTot && c <= fromTot + span) out.push(c);
    }
  }catch(_){}
  return out;
}
/* start/finish (or lap) line totals ahead */
function flagsAhead(fromTot, span){
  const out = [], RD = (typeof raceDist==="function") ? raceDist() : 1e9;
  if(typeof LAYOUT === "undefined") return out;
  if(LAYOUT === "loop"){
    for(let k=Math.ceil(fromTot/S)*S; k<=fromTot+span; k+=S) if(k>fromTot && k<=RD) out.push(k);
  }else if(LAYOUT === "leadin"){
    for(let k=LAP_START; k<=fromTot+span; k+=LAP_LEN) if(k>fromTot && k<=RD) out.push(k);
  }else{ if(S>fromTot && S<=fromTot+span) out.push(S); }
  return out;
}

/* ---------- sprites ---------- */
/* rear-view open-wheeler, drawn 1 unit wide at (0,0)=rear-axle centre */
function drawRival(g, x, y, w, color, glow){
  const h = w*0.72;
  g.save(); g.translate(x, y);
  // shadow
  g.fillStyle = "rgba(0,0,0,.4)";
  g.beginPath(); g.ellipse(0, 0, w*0.62, w*0.10, 0, 0, 7); g.fill();
  // tyres
  g.fillStyle = "#141117";
  rr(g, -w*0.60, -h*0.62, w*0.24, h*0.62, w*0.06);
  rr(g,  w*0.36, -h*0.62, w*0.24, h*0.62, w*0.06);
  g.fillStyle = "#2e2a33";
  rr(g, -w*0.56, -h*0.56, w*0.16, h*0.16, w*0.04);
  rr(g,  w*0.40, -h*0.56, w*0.16, h*0.16, w*0.04);
  // body
  g.fillStyle = color;
  g.beginPath();
  g.moveTo(-w*0.34, 0); g.lineTo(-w*0.28, -h*0.52); g.lineTo(w*0.28, -h*0.52);
  g.lineTo(w*0.34, 0); g.closePath(); g.fill();
  // rear wing
  g.fillStyle = shade(color, -25);
  rr(g, -w*0.42, -h*0.78, w*0.84, h*0.14, w*0.03);
  g.fillStyle = "#1a1620";
  rr(g, -w*0.05, -h*0.70, w*0.10, h*0.20, w*0.02);
  // helmet
  g.fillStyle = "#e8e2d2";
  g.beginPath(); g.arc(0, -h*0.56, w*0.11, 0, 7); g.fill();
  // exhaust glow when moving fast
  if(glow > 0.02){
    g.fillStyle = `rgba(255,140,60,${Math.min(.75, glow)})`;
    g.beginPath(); g.ellipse(-w*0.16, -h*0.06, w*0.05, w*0.03, 0, 0, 7); g.fill();
    g.beginPath(); g.ellipse( w*0.16, -h*0.06, w*0.05, w*0.03, 0, 0, 7); g.fill();
  }
  g.restore();
}
function rr(g, x, y, w, h, r){
  g.beginPath();
  g.moveTo(x+r, y); g.arcTo(x+w, y, x+w, y+h, r); g.arcTo(x+w, y+h, x, y+h, r);
  g.arcTo(x, y+h, x, y, r); g.arcTo(x, y, x+w, y, r); g.closePath(); g.fill();
}
function shade(hex, amt){
  const m = /^#?([0-9a-f]{6})$/i.exec(hex||""); if(!m) return hex;
  const n = parseInt(m[1],16);
  const c = v => Math.max(0, Math.min(255, v+amt));
  return "#"+((c(n>>16)<<16)|(c((n>>8)&255)<<8)|c(n&255)).toString(16).padStart(6,"0");
}

/* your own nose cone / hood, drawn over the bottom of the frame */
function drawHood(g, p, steer){
  const w = Math.min(W*0.42, 340), h = w*0.62;
  const cx = W/2 + steer*W*0.02, by = H + h*0.06;
  const color = (p && p.color) || THEME.purple;
  const num = ((p && p.name) || "").match(/\d+/);
  g.save(); g.translate(cx, by); g.rotate(steer*0.02);
  // suspension arms
  g.strokeStyle = "#9aa0a8"; g.lineWidth = Math.max(3, w*0.02); g.lineCap="round";
  g.beginPath(); g.moveTo(-w*0.42,-h*0.52); g.lineTo(-w*0.85,-h*0.70); g.stroke();
  g.beginPath(); g.moveTo(-w*0.42,-h*0.40); g.lineTo(-w*0.85,-h*0.52); g.stroke();
  g.beginPath(); g.moveTo( w*0.42,-h*0.52); g.lineTo( w*0.85,-h*0.70); g.stroke();
  g.beginPath(); g.moveTo( w*0.42,-h*0.40); g.lineTo( w*0.85,-h*0.52); g.stroke();
  // front tyres, edge of frame
  g.fillStyle = "#131017";
  rr(g, -w*1.06, -h*0.95, w*0.26, h*0.95, w*0.05);
  rr(g,  w*0.80, -h*0.95, w*0.26, h*0.95, w*0.05);
  // nose
  g.fillStyle = color;
  g.beginPath();
  g.moveTo(-w*0.50, 0); g.quadraticCurveTo(-w*0.46, -h*0.85, -w*0.16, -h);
  g.lineTo(w*0.16, -h); g.quadraticCurveTo(w*0.46, -h*0.85, w*0.50, 0);
  g.closePath(); g.fill();
  g.strokeStyle = shade(color,-40); g.lineWidth = 2; g.stroke();
  // centre stripe
  g.fillStyle = "#efe9dd";
  g.beginPath();
  g.moveTo(-w*0.075, 0); g.lineTo(-w*0.06, -h); g.lineTo(w*0.06, -h); g.lineTo(w*0.075, 0);
  g.closePath(); g.fill();
  // roundel
  if(num){
    g.fillStyle="#efe9dd"; g.beginPath(); g.arc(0,-h*0.30, w*0.13, 0, 7); g.fill();
    g.fillStyle="#151218";
    g.font = `800 ${Math.round(w*0.15)}px var(--mono, monospace)`;
    g.textAlign="center"; g.textBaseline="middle";
    g.fillText(num[0], 0, -h*0.29);
  }
  g.restore();
}

/* ---------- one rendered frame ---------- */
function render(dt){
  const p = curHuman(); if(!p || !p._v) return;
  const v = p._v, cam = FP.cam;

  /* camera chases the car's visual state (a hair behind for depth feel) */
  cam.total = v.total; cam.off += (v.off - cam.off)*Math.min(1, dt*8);
  const here = lerpPose(cam.total); if(!here) return;
  const look = lerpPose(cam.total + 1.4) || here;         // look slightly ahead
  const targHead = Math.atan2(look.ty + here.ty, look.tx + here.tx);
  if(cam.head == null) cam.head = targHead;
  else cam.head += shortTurn(cam.head, targHead)*Math.min(1, dt*6);

  /* live "speed" (spaces/sec of the visual car) drives the FX */
  const spd = Math.max(0, (v.total - (cam._pt==null?v.total:cam._pt)) / Math.max(dt, 1e-4));
  cam._pt = v.total;
  cam.spd += (spd - cam.spd)*Math.min(1, dt*5);
  cam.bob = Math.sin(performance.now()/90) * Math.min(3, cam.spd*0.5);

  const spin = v.spin || 0;                               // knock-back / spin-out
  cam.roll += ((spin>0 ? Math.sin(spin/57)*0.35 : 0) - cam.roll)*Math.min(1, dt*6);

  cam.x = here.x - here.tx*2 + here.nx*cam.off*0.85;      // slightly behind the axle
  cam.y = here.y - here.ty*2 + here.ny*cam.off*0.85;

  const P = makeProjector(cam);

  ctx.setTransform(DPR,0,0,DPR,0,0);
  ctx.clearRect(0,0,W,H);
  ctx.save();
  if(cam.roll){ ctx.translate(W/2,H/2); ctx.rotate(cam.roll); ctx.translate(-W/2,-H/2); }

  /* ----- sky ----- */
  const sky = ctx.createLinearGradient(0,0,0,P.horizon);
  sky.addColorStop(0, "#171128"); sky.addColorStop(.72, "#33254e"); sky.addColorStop(1, "#5a3f7e");
  ctx.fillStyle = sky; ctx.fillRect(0,0,W,P.horizon+1);
  // low sun
  const sunX = W/2 - cam.head*140 % W;
  const sun = ctx.createRadialGradient(sunX, P.horizon-8, 2, sunX, P.horizon-8, 70);
  sun.addColorStop(0,"rgba(240,231,211,.9)"); sun.addColorStop(1,"rgba(240,231,211,0)");
  ctx.fillStyle = sun; ctx.beginPath(); ctx.arc(sunX, P.horizon-8, 70, 0, 7); ctx.fill();
  // parallax hills
  ctx.fillStyle = "#241c38";
  ctx.beginPath(); ctx.moveTo(0, P.horizon);
  for(let x=0; x<=W; x+=12){
    const t = (x*0.013 - cam.head*2.2);
    ctx.lineTo(x, P.horizon - 10 - Math.abs(Math.sin(t)*14 + Math.sin(t*2.7)*6));
  }
  ctx.lineTo(W, P.horizon); ctx.closePath(); ctx.fill();

  /* ----- ground ----- */
  const gnd = ctx.createLinearGradient(0,P.horizon,0,H);
  gnd.addColorStop(0, shade(THEME.grass, -18)); gnd.addColorStop(1, THEME.grass);
  ctx.fillStyle = gnd; ctx.fillRect(0, P.horizon, W, H-P.horizon);

  /* ----- sample the road ahead ----- */
  const rows = [];
  for(let d=0.30; d<=VIEW_SPACES; d+=STEP){
    const q = lerpPose(cam.total + d); if(!q) break;
    const L  = P.proj(q.x - q.nx*ROAD_HW,            q.y - q.ny*ROAD_HW);
    const R  = P.proj(q.x + q.nx*ROAD_HW,            q.y + q.ny*ROAD_HW);
    const Lk = P.proj(q.x - q.nx*(ROAD_HW+KERB_W),   q.y - q.ny*(ROAD_HW+KERB_W));
    const Rk = P.proj(q.x + q.nx*(ROAD_HW+KERB_W),   q.y + q.ny*(ROAD_HW+KERB_W));
    rows.push({ d, sp: cam.total + d, L, R, Lk, Rk });
  }

  /* far → near */
  for(let i=rows.length-2; i>=0; i--){
    const a = rows[i], b = rows[i+1];
    if(!a.L || !a.R || !b.L || !b.R) continue;
    const spIdx = Math.floor(a.sp);
    const stripe = Math.floor(a.sp*2) % 2 === 0;
    // grass banding for motion feel
    ctx.fillStyle = stripe ? "rgba(255,255,255,.03)" : "rgba(0,0,0,.05)";
    ctx.fillRect(0, Math.min(a.L.y,a.R.y), W, Math.max(1, Math.abs(b.L.y-a.L.y)+1));
    // kerbs
    if(a.Lk && b.Lk){ ctx.fillStyle = stripe ? "#c8322c" : "#efe6d4"; quad(ctx, a.Lk, a.L, b.L, b.Lk); }
    if(a.Rk && b.Rk){ ctx.fillStyle = stripe ? "#c8322c" : "#efe6d4"; quad(ctx, a.R, a.Rk, b.Rk, b.R); }
    // asphalt (alternate shade per Space so movement reads)
    ctx.fillStyle = (spIdx % 2 === 0) ? "#3b3542" : "#37313d";
    quad(ctx, a.L, a.R, b.R, b.L);
    // centre dashes
    if((a.sp % 1) < 0.42){
      const cwA = (a.R.x - a.L.x)*0.012, cwB = (b.R.x - b.L.x)*0.012;
      ctx.fillStyle = "rgba(240,231,211,.5)";
      quad(ctx, {x:(a.L.x+a.R.x)/2-cwA, y:a.L.y*0+((a.L.y+a.R.y)/2)},
                 {x:(a.L.x+a.R.x)/2+cwA, y:(a.L.y+a.R.y)/2},
                 {x:(b.L.x+b.R.x)/2+cwB, y:(b.L.y+b.R.y)/2},
                 {x:(b.L.x+b.R.x)/2-cwB, y:(b.L.y+b.R.y)/2});
    }
  }

  /* ----- billboards: corner lines + boards, chequered flag ----- */
  const bills = [];
  for(const c of cornersAhead(cam.total, VIEW_SPACES)){
    const idx = (typeof cornerIdxOf === "function") ? cornerIdxOf(c) : -1;
    const lim = (idx>=0 && typeof limitOfCorner==="function") ? limitOfCorner(idx) : "?";
    bills.push({ tot:c, kind:"corner", lim });
  }
  for(const f of flagsAhead(cam.total, VIEW_SPACES)) bills.push({ tot:f, kind:"flag" });
  bills.sort((a,b)=>b.tot-a.tot);                    // far first

  for(const b of bills){
    const q = lerpPose(b.tot); if(!q) continue;
    const L = P.proj(q.x - q.nx*ROAD_HW, q.y - q.ny*ROAD_HW);
    const R = P.proj(q.x + q.nx*ROAD_HW, q.y + q.ny*ROAD_HW);
    if(!L || !R) continue;
    if(b.kind === "corner"){
      // painted line across the road
      ctx.strokeStyle = "rgba(255,209,102,.85)"; ctx.lineWidth = Math.max(1.5, L.s*1.4);
      ctx.beginPath(); ctx.moveTo(L.x, L.y); ctx.lineTo(R.x, R.y); ctx.stroke();
      // roadside speed board
      const B = P.proj(q.x + q.nx*(ROAD_HW+10), q.y + q.ny*(ROAD_HW+10));
      if(B){
        const s = B.s, bw = 14*s, bh = 14*s, ph = 22*s;
        ctx.strokeStyle="#8b8577"; ctx.lineWidth=Math.max(1, 1.6*s);
        ctx.beginPath(); ctx.moveTo(B.x, B.y); ctx.lineTo(B.x, B.y-ph); ctx.stroke();
        ctx.fillStyle="#efe6d4"; rr(ctx, B.x-bw/2, B.y-ph-bh, bw, bh, 2.5*s);
        ctx.strokeStyle="#c8322c"; ctx.lineWidth=Math.max(1,2*s);
        ctx.strokeRect(B.x-bw/2+1.5*s, B.y-ph-bh+1.5*s, bw-3*s, bh-3*s);
        ctx.fillStyle="#151218"; ctx.font=`800 ${Math.max(6, 9*s)}px var(--mono, monospace)`;
        ctx.textAlign="center"; ctx.textBaseline="middle";
        ctx.fillText(String(b.lim), B.x, B.y-ph-bh/2);
      }
    }else{
      // chequered band + gantry
      const n=8;
      for(let k=0;k<n;k++){
        ctx.fillStyle = k%2 ? "#efe6d4" : "#151218";
        const x0=L.x+(R.x-L.x)*k/n, x1=L.x+(R.x-L.x)*(k+1)/n;
        const y0=L.y+(R.y-L.y)*k/n, y1=L.y+(R.y-L.y)*(k+1)/n;
        quad(ctx, {x:x0,y:y0-L.s*1.5},{x:x1,y:y1-L.s*1.5},{x:x1,y:y1+L.s*1.5},{x:x0,y:y0+L.s*1.5});
      }
      const gh = 34*L.s;
      ctx.strokeStyle="#8b8577"; ctx.lineWidth=Math.max(1,2*L.s);
      ctx.beginPath(); ctx.moveTo(L.x,L.y); ctx.lineTo(L.x,L.y-gh);
      ctx.lineTo(R.x,R.y-gh); ctx.lineTo(R.x,R.y); ctx.stroke();
      ctx.fillStyle=THEME.deep; rr(ctx, L.x, L.y-gh, (R.x-L.x), 8*L.s, 2*L.s);
      ctx.fillStyle=THEME.cream; ctx.font=`800 ${Math.max(6,6.5*L.s)}px var(--mono, monospace)`;
      ctx.textAlign="center"; ctx.textBaseline="middle";
      ctx.fillText("HEAT", (L.x+R.x)/2, L.y-gh+4*L.s);
    }
  }

  /* ----- opponents (billboard sprites, far → near) ----- */
  const others = (G.players||[])
    .filter(o => o !== p && !(o.finished && o._v && o._v.blend >= 1))
    .map(o => {
      const oT = o._v ? o._v.total : o.total;
      const oO = o._v ? o._v.off   : spotOffOf(o.spot);
      const pos = carPose(oT, oO);
      const pr = P.proj(pos.x, pos.y);
      return pr ? { o, pr } : null;
    })
    .filter(Boolean)
    .sort((a,b) => b.pr.z - a.pr.z);
  for(const {o, pr} of others){
    const w = CAR_W * pr.s;
    if(w < 1.2 || w > W) continue;
    let glow = 0;
    if(o._v){
      glow = Math.min(.7, Math.abs(o._v.total - (o._v._fp==null ? o._v.total : o._v._fp)) / Math.max(dt,1e-4) * 0.12);
      o._v._fp = o._v.total;
    }
    drawRival(ctx, pr.x, pr.y, w, o.color || "#888", glow);
  }

  /* ----- tunnel dressing ----- */
  if(typeof inTunnelSpace === "function" && inTunnelSpace(phys(Math.floor(cam.total)))){
    ctx.fillStyle = "rgba(8,6,12,.55)"; ctx.fillRect(0,0,W,P.horizon);
    ctx.fillStyle = "rgba(8,6,12,.30)"; ctx.fillRect(0,P.horizon,W,H-P.horizon);
    for(let k=1;k<6;k++){                 // strip lights rushing overhead
      const t = ((cam.total*2 + k*1.2) % 6)/6;
      const y = P.horizon*(0.15 + 0.6*t*t);
      ctx.fillStyle = `rgba(255,224,150,${.5*(1-t)})`;
      ctx.fillRect(W*0.3, y, W*0.4, Math.max(1, 3*t));
    }
  }

  /* ----- speed streaks ----- */
  const streak = Math.min(1, cam.spd/9);
  if(streak > .15){
    ctx.strokeStyle = `rgba(240,231,211,${streak*.20})`;
    for(let k=0;k<8;k++){
      const y = P.horizon + (H-P.horizon)*(0.12 + 0.8*((k*0.137 + cam.total*0.7) % 1));
      const l = 30 + 90*streak;
      ctx.lineWidth = 1 + streak;
      ctx.beginPath(); ctx.moveTo(W*0.06, y); ctx.lineTo(W*0.06+l, y+2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(W*0.94, y); ctx.lineTo(W*0.94-l, y+2); ctx.stroke();
    }
  }

  /* ----- hood + spin flash ----- */
  drawHood(ctx, p, shortTurn(cam.head, targHead)*8);
  if(spin > 40){
    ctx.fillStyle = `rgba(200,50,44,${Math.min(.30, spin/900)})`;
    ctx.fillRect(0,0,W,H);
  }
  ctx.restore();

  /* ----- minimap (top-left, from the traced board points) ----- */
  drawMinimap(p);
}

function quad(g, a, b, c, d){
  g.beginPath(); g.moveTo(a.x,a.y); g.lineTo(b.x,b.y); g.lineTo(c.x,c.y); g.lineTo(d.x,d.y);
  g.closePath(); g.fill();
}

function drawMinimap(me){
  const Pw = TRACK && TRACK.spacePts; if(!Pw || !Pw.length) return;
  const mw = Math.min(150, W*0.30), mh = mw * (TRACK.imgH/TRACK.imgW);
  const mx = 10, my = 10, sc = mw / TRACK.imgW;
  ctx.save();
  ctx.globalAlpha = .92;
  ctx.fillStyle = "rgba(13,10,19,.66)";
  rr(ctx, mx-6, my-6, mw+12, mh+12, 8);
  ctx.strokeStyle = THEME.deep; ctx.lineWidth = 1.5;
  ctx.strokeRect(mx-6, my-6, mw+12, mh+12);
  ctx.beginPath();
  Pw.forEach((q,i)=> i ? ctx.lineTo(mx+q[0]*sc, my+q[1]*sc) : ctx.moveTo(mx+q[0]*sc, my+q[1]*sc));
  if(typeof LAYOUT==="undefined" || LAYOUT!=="open") ctx.closePath();
  ctx.strokeStyle = "#57506a"; ctx.lineWidth = 3; ctx.lineJoin="round"; ctx.stroke();
  for(const o of (G.players||[])){
    if(!o._v && o.total==null) continue;
    const pos = carPose(o._v ? o._v.total : o.total, 0); if(!pos) continue;
    ctx.beginPath(); ctx.arc(mx+pos.x*sc, my+pos.y*sc, o===me?4:2.6, 0, 7);
    ctx.fillStyle = o.color || "#999"; ctx.fill();
    if(o===me){ ctx.strokeStyle = THEME.glow; ctx.lineWidth=1.6; ctx.stroke(); }
  }
  ctx.restore();
}

/* ---------- watcher loop ---------- */
function tick(now){
  requestAnimationFrame(tick);
  const dt = Math.min(.06, Math.max(0, (now - FP.lastT)/1000)); FP.lastT = now;

  let p = null;
  try{ p = (G.players && G.players.length) ? curHuman() : null; }catch(_){ }
  const replayOn = (typeof REPLAY !== "undefined") && REPLAY.active;

  const moving = p && p._v && !p.isBot &&
                 (Math.abs(p._v.total - p.total) > 0.02 || (p._v.spin||0) > 1);

  if(moving && FP.enabled && !FP.snooze && !replayOn && !REDUCED && !p.finished){
    show(); FP.linger = now + LINGER_MS;
  }else if(FP.active && now > FP.linger){
    hide();
  }
  if(!moving) FP.snooze = false;              // re-arm once the move completes

  if(FP.active && p && p._v) render(dt || 1/60);
}
requestAnimationFrame(tick);

})();
