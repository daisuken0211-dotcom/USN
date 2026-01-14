// 半側空間無視・物体無視 体験ツール
// - 物体（検出物体の左半分）を最優先
// - 空間（画面左側）は後から控えめに重ねる

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
const spaceIntensityVal = el("spaceIntensityVal"); // ← バグ修正

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
let detections = [];
let lastObjEffectAt = 0;
let objEffectState = new Map();

const off = document.createElement("canvas");
const offCtx = off.getContext("2d");

function setStatus(msg){ statusEl.textContent = msg; }
function clamp(v,min,max){ return Math.max(min, Math.min(max,v)); }
function randInt(a,b){ return Math.floor(Math.random()*(b-a+1))+a; }
function chance(p){ return Math.random()<p; }

function applyFog(ctx,x,y,w,h,s){
  ctx.save();
  ctx.globalAlpha = s*0.7;
  ctx.fillStyle="#9aa3c7";
  ctx.fillRect(x,y,w,h);
  ctx.restore();
}
function applyBlur(ctx,src,x,y,w,h,s){
  ctx.save();
  ctx.filter=`blur(${2+s*14}px)`;
  ctx.drawImage(src,x,y,w,h,x,y,w,h);
  ctx.restore();
}
function applyPixelate(ctx,src,x,y,w,h,s){
  const sc = clamp(1-s*0.9,0.08,1);
  const tw=Math.max(2,Math.floor(w*sc)), th=Math.max(2,Math.floor(h*sc));
  const tmp=applyPixelate._tmp||(applyPixelate._tmp=document.createElement("canvas"));
  const tctx=tmp.getContext("2d");
  tmp.width=tw; tmp.height=th;
  tctx.imageSmoothingEnabled=false;
  tctx.drawImage(src,x,y,w,h,0,0,tw,th);
  ctx.imageSmoothingEnabled=false;
  ctx.drawImage(tmp,0,0,tw,th,x,y,w,h);
}
function applyErase(ctx,x,y,w,h,s){
  ctx.save();
  ctx.globalCompositeOperation="destination-out";
  ctx.globalAlpha=0.3+s*0.6;
  for(let i=0;i<30+s*60;i++){
    ctx.fillRect(x+Math.random()*w,y+Math.random()*h,4+Math.random()*12,4+Math.random()*12);
  }
  ctx.restore();
}
function keyForDet(d){
  const [x,y,w,h]=d.bbox;
  return `${d.class}:${Math.round(x/10)}:${Math.round(y/10)}:${Math.round(w/10)}:${Math.round(h/10)}`;
}
function chooseObjMode(){
  return ["erase","fog","pixel","blur"][randInt(0,3)];
}

async function ensureModel(){
  if(model) return model;
  await tf.ready();
  model = await cocoSsd.load();
  return model;
}

async function startCamera(){
  stream = await navigator.mediaDevices.getUserMedia({video:{facingMode:"environment"}});
  video.srcObject=stream; await video.play();
  canvas.width=off.width=video.videoWidth;
  canvas.height=off.height=video.videoHeight;
  await ensureModel();
  running=true; requestAnimationFrame(loop);
}
btnStart.onclick=startCamera;
btnStop.onclick=()=>{ running=false; stream.getTracks().forEach(t=>t.stop()); };

async function loop(ts){
  if(!running) return;
  offCtx.save();
  offCtx.clearRect(0,0,off.width,off.height);
  if(mirror.checked){ offCtx.translate(off.width,0); offCtx.scale(-1,1); }
  offCtx.drawImage(video,0,0);
  offCtx.restore();

  if(ts-lastDetectAt>detectInterval.value){
    lastDetectAt=ts;
    detections=(await model.detect(off)).filter(p=>p.score>=thr.value).slice(0,10);
  }

  ctx.drawImage(off,0,0);

  // --- ① 物体を先に ---
  if(enableObject.checked){
    const s=0.75;
    for(const d of detections){
      const [x,y,w,h]=d.bbox;
      const hw=Math.floor(w/2);
      ctx.save(); ctx.beginPath(); ctx.rect(x,y,hw,h); ctx.clip();
      const mode=objEffectState.get(keyForDet(d))?.mode || chooseObjMode();
      if(mode==="erase") applyErase(ctx,x,y,hw,h,s);
      if(mode==="fog") applyFog(ctx,x,y,hw,h,s);
      if(mode==="pixel") applyPixelate(ctx,off,x,y,hw,h,s);
      if(mode==="blur") applyBlur(ctx,off,x,y,hw,h,s);
      ctx.restore();
    }
  }

  // --- ② 空間を後から ---
  if(enableSpace.checked && chance(spaceProb.value/100)){
    const s=spaceIntensity.value/100;
    const w=Math.floor(canvas.width/2);
    applyBlur(ctx,off,0,0,w,canvas.height,s);
    applyFog(ctx,0,0,w,canvas.height,s*0.6);
  }

  requestAnimationFrame(loop);
}
