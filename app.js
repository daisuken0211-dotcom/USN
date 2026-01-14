// 半側空間無視・物体無視 体験ツール
// - 空間（画面左側）エフェクト：曇り/ぼかし/微小ズレ/ノイズ
// - 物体（検出物体の左半分）エフェクト：消失/曇り/粗視化/ぼかし
// ※ 教育・研修用。診断目的ではありません。

const el = (id) => document.getElementById(id);

const video = el("video");
const canvas = el("canvas");
const ctx = canvas.getContext("2d", { willReadFrequently: false });

const btnStart = el("btnStart");
const btnStop = el("btnStop");
const statusEl = el("status");

// controls
const thr = el("thr");
const thrVal = el("thrVal");
const detectInterval = el("detectInterval");
const detectIntervalVal = el("detectIntervalVal");
const showMidline = el("showMidline");
const showBoxes = el("showBoxes");
const mirror = el("mirror");

const enableSpace = el("enableSpace");
const spaceProb = el("spaceProb");
const spaceProbVal = el("spaceProbVal");
const spaceIntensity = el("spaceIntensity");

const enableObject = el("enableObject");
const objProb = el("objProb");
const objProbVal = el("objProbVal");
const objRefresh = el("objRefresh");
const objRefreshVal = el("objRefreshVal");
const classFilter = el("classFilter");

function bindRange(input, label, fmt = (v)=>v){
  const update = () => label.textContent = fmt(input.value);
  input.addEventListener("input", update);
  update();
}
bindRange(thr, thrVal, (v)=>Number(v).toFixed(2));
bindRange(detectInterval, detectIntervalVal);
bindRange(spaceProb, spaceProbVal);
bindRange(spaceIntensity, spaceIntensityVal);
bindRange(objProb, objProbVal);
bindRange(objRefresh, objRefreshVal);

let stream = null;
let model = null;
let running = false;

let lastDetectAt = 0;
let detections = []; // latest detections
let lastObjEffectAt = 0;
let objEffectState = new Map(); // key -> {mode, until}

const off = document.createElement("canvas");
const offCtx = off.getContext("2d");

function setStatus(msg){ statusEl.textContent = msg; }

function parseClassFilter(){
  const raw = (classFilter.value || "").trim();
  if(!raw) return null;
  return new Set(raw.split(/[,\n]/).map(s=>s.trim()).filter(Boolean));
}

function clamp(v, min, max){ return Math.max(min, Math.min(max, v)); }

function randInt(a,b){ return Math.floor(Math.random()*(b-a+1))+a; }
function chance(p01){ return Math.random() < p01; }

// --- Effects ---
// 1) Fog overlay
function applyFog(targetCtx, x,y,w,h, intensity01){
  targetCtx.save();
  targetCtx.globalAlpha = clamp(intensity01, 0, 1) * 0.75;
  targetCtx.fillStyle = "#9aa3c7";
  targetCtx.fillRect(x,y,w,h);
  targetCtx.restore();
}

// 2) Pixelate region by scaling down and back up
function applyPixelate(targetCtx, srcCanvas, x,y,w,h, strength01){
  const s = clamp(strength01, 0, 1);
  const scale = clamp(1 - s*0.92, 0.08, 1); // smaller = more pixelated
  const tw = Math.max(2, Math.floor(w * scale));
  const th = Math.max(2, Math.floor(h * scale));

  // temp canvas
  const tmp = applyPixelate._tmp || (applyPixelate._tmp = document.createElement("canvas"));
  const tctx = tmp.getContext("2d");
  tmp.width = tw; tmp.height = th;

  // draw region small
  tctx.imageSmoothingEnabled = false;
  tctx.clearRect(0,0,tw,th);
  tctx.drawImage(srcCanvas, x,y,w,h, 0,0,tw,th);

  // draw back large
  targetCtx.save();
  targetCtx.imageSmoothingEnabled = false;
  targetCtx.drawImage(tmp, 0,0,tw,th, x,y,w,h);
  targetCtx.restore();
}

// 3) Blur region (ctx.filter)
function applyBlur(targetCtx, srcCanvas, x,y,w,h, strength01){
  const s = clamp(strength01, 0, 1);
  const px = 2 + s * 14; // 2..16px
  targetCtx.save();
  targetCtx.filter = `blur(${px}px)`;
  targetCtx.drawImage(srcCanvas, x,y,w,h, x,y,w,h);
  targetCtx.restore();
}

// 4) Erase region (simulate disappearance)
function applyErase(targetCtx, x,y,w,h, strength01){
  targetCtx.save();
  // erase partially depending on strength
  const alpha = clamp(strength01, 0, 1);
  targetCtx.globalCompositeOperation = "destination-out";
  targetCtx.globalAlpha = 0.35 + alpha*0.65;
  targetCtx.fillStyle = "rgba(0,0,0,1)";
  // randomized speckle erasure feels more like "missing"
  const n = 20 + Math.floor(alpha*80);
  for(let i=0;i<n;i++){
    const rw = randInt(Math.max(4, Math.floor(w*0.03)), Math.max(10, Math.floor(w*0.18)));
    const rh = randInt(Math.max(4, Math.floor(h*0.03)), Math.max(10, Math.floor(h*0.18)));
    const rx = x + randInt(0, Math.max(0, w-rw));
    const ry = y + randInt(0, Math.max(0, h-rh));
    targetCtx.fillRect(rx, ry, rw, rh);
  }
  targetCtx.restore();
}

// 5) Small shift + noise (space distortion feel)
function applyShiftNoise(targetCtx, srcCanvas, x,y,w,h, intensity01){
  const s = clamp(intensity01, 0, 1);
  const dx = Math.round((Math.random()*2-1) * (2 + s*10));
  const dy = Math.round((Math.random()*2-1) * (1 + s*6));
  targetCtx.save();
  targetCtx.globalAlpha = 0.9;
  targetCtx.drawImage(srcCanvas, x,y,w,h, x+dx,y+dy,w,h);
  // noise overlay
  targetCtx.globalAlpha = 0.12 + s*0.20;
  targetCtx.fillStyle = "#000";
  for(let i=0;i<50;i++){
    const nx = x + randInt(0, w);
    const ny = y + randInt(0, h);
    targetCtx.fillRect(nx, ny, 1, 1);
  }
  targetCtx.restore();
}

function drawMidline(){
  const w = canvas.width, h = canvas.height;
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,.55)";
  ctx.setLineDash([8,8]);
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(w/2, 0);
  ctx.lineTo(w/2, h);
  ctx.stroke();
  ctx.restore();
}

function drawBoxes(){
  ctx.save();
  ctx.lineWidth = 2;
  ctx.font = "12px system-ui";
  for(const d of detections){
    const [x,y,w,h] = d.bbox;
    ctx.strokeStyle = "rgba(0,255,255,.7)";
    ctx.strokeRect(x,y,w,h);
    ctx.fillStyle = "rgba(0,255,255,.85)";
    ctx.fillText(`${d.class} ${(d.score*100).toFixed(0)}%`, x+4, y+14);
  }
  ctx.restore();
}

function chooseObjMode(){
  // modes tuned for "何か分からない/欠ける/曇る" 体験
  const modes = ["erase", "fog", "pixel", "blur"];
  return modes[randInt(0, modes.length-1)];
}

function keyForDet(d){
  // stable-ish key: class + rounded bbox
  const [x,y,w,h] = d.bbox;
  const k = `${d.class}:${Math.round(x/10)}:${Math.round(y/10)}:${Math.round(w/10)}:${Math.round(h/10)}`;
  return k;
}

async function ensureModel(){
  if(model) return model;
  setStatus("AIモデル読込中…（初回のみ）");
  // warmup tf
  await tf.ready();
  model = await cocoSsd.load();
  setStatus("モデル読込完了");
  return model;
}

async function startCamera(){
  if(running) return;
  try{
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
      audio: false
    });
    video.srcObject = stream;
    await video.play();

    // set canvas size based on video
    const vw = video.videoWidth || 1280;
    const vh = video.videoHeight || 720;
    canvas.width = vw;
    canvas.height = vh;
    off.width = vw;
    off.height = vh;

    await ensureModel();

    running = true;
    btnStart.disabled = true;
    btnStop.disabled = false;
    setStatus("実行中");
    requestAnimationFrame(loop);
  }catch(err){
    console.error(err);
    setStatus("カメラ開始に失敗（権限/HTTPS/ブラウザ設定を確認）");
  }
}

function stopCamera(){
  running = false;
  btnStart.disabled = false;
  btnStop.disabled = true;

  if(stream){
    for(const t of stream.getTracks()) t.stop();
    stream = null;
  }
  video.srcObject = null;
  detections = [];
  objEffectState.clear();
  setStatus("停止");
  ctx.clearRect(0,0,canvas.width,canvas.height);
}

btnStart.addEventListener("click", startCamera);
btnStop.addEventListener("click", stopCamera);

// Main render loop
async function loop(ts){
  if(!running) return;

  const vw = canvas.width, vh = canvas.height;

  // draw current video frame to offscreen (optionally mirrored)
  offCtx.save();
  offCtx.clearRect(0,0,vw,vh);
  if(mirror.checked){
    offCtx.translate(vw, 0);
    offCtx.scale(-1, 1);
  }
  offCtx.drawImage(video, 0,0, vw, vh);
  offCtx.restore();

  // run detection at interval
  const di = Number(detectInterval.value);
  if(ts - lastDetectAt >= di){
    lastDetectAt = ts;
    try{
      const m = model;
      const preds = await m.detect(off);
      const t = Number(thr.value);
      const filter = parseClassFilter();
      detections = preds
        .filter(p => p.score >= t)
        .filter(p => !filter || filter.has(p.class))
        .slice(0, 12); // cap for performance
    }catch(e){
      console.warn("detect error", e);
    }
  }

  // base draw
  ctx.clearRect(0,0,vw,vh);
  ctx.drawImage(off, 0,0, vw, vh);

  // space effect (left half of screen)
  if(enableSpace.checked){
    const prob = Number(spaceProb.value) / 100.0;
    if(chance(prob)){
      const intensity = Number(spaceIntensity.value) / 100.0;
      const x = 0, y = 0, w = Math.floor(vw/2), h = vh;
      // random pick
      const pick = randInt(0, 2);
      if(pick === 0){
        applyFog(ctx, x,y,w,h, intensity);
      }else if(pick === 1){
        applyBlur(ctx, off, x,y,w,h, intensity);
        applyFog(ctx, x,y,w,h, intensity*0.45);
      }else{
        applyShiftNoise(ctx, off, x,y,w,h, intensity);
      }
    }
  }

  // object effect state refresh
  const refresh = Number(objRefresh.value);
  if(ts - lastObjEffectAt >= refresh){
    lastObjEffectAt = ts;
    if(enableObject.checked){
      const p = Number(objProb.value)/100.0;
      // update mode per detection
      for(const d of detections){
        const k = keyForDet(d);
        if(chance(p)){
          objEffectState.set(k, { mode: chooseObjMode(), until: ts + refresh*1.2 });
        }else{
          objEffectState.delete(k);
        }
      }
      // cleanup old
      for(const [k,v] of objEffectState.entries()){
        if(v.until < ts) objEffectState.delete(k);
      }
    }else{
      objEffectState.clear();
    }
  }

  // apply object effect on left half of each bbox
  if(enableObject.checked){
    const intensity = 0.75; // fixed baseline; controlled by prob/refresh; can add slider later
    for(const d of detections){
      const k = keyForDet(d);
      const state = objEffectState.get(k);
      if(!state) continue;

      let [x,y,w,h] = d.bbox;
      x = clamp(x, 0, vw-1);
      y = clamp(y, 0, vh-1);
      w = clamp(w, 1, vw-x);
      h = clamp(h, 1, vh-y);

      const halfW = Math.floor(w/2);
      if(halfW <= 2) continue;

      // clip to left half of the object bbox
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, halfW, h);
      ctx.clip();

      if(state.mode === "erase"){
        applyErase(ctx, x, y, halfW, h, intensity);
      }else if(state.mode === "fog"){
        applyFog(ctx, x, y, halfW, h, intensity);
      }else if(state.mode === "pixel"){
        applyPixelate(ctx, canvas, x, y, halfW, h, intensity); // pixelate current content
        applyFog(ctx, x, y, halfW, h, intensity*0.25);
      }else if(state.mode === "blur"){
        applyBlur(ctx, canvas, x, y, halfW, h, intensity);
        applyFog(ctx, x, y, halfW, h, intensity*0.20);
      }
      ctx.restore();
    }
  }

  // overlays
  if(showMidline.checked) drawMidline();
  if(showBoxes.checked) drawBoxes();

  requestAnimationFrame(loop);
}

// usability: prevent page zoom scroll during touch when interacting with canvas
canvas.addEventListener("touchmove", (e)=>e.preventDefault(), { passive: false });
