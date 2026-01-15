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
  const btnFS = el("btnFS");
  const btnExitVR = el("btnExitVR");
  
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
  const spaceIntensityVal = el("spaceIntensityVal");   // ★ 修正① 追加
  
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
  function applyFog(targetCtx, x,y,w,h, intensity01){
    targetCtx.save();
    targetCtx.globalAlpha = clamp(intensity01, 0, 1) * 0.75;
    targetCtx.fillStyle = "#9aa3c7";
    targetCtx.fillRect(x,y,w,h);
    targetCtx.restore();
  }
  
  function applyPixelate(targetCtx, srcCanvas, x,y,w,h, strength01){
    const s = clamp(strength01, 0, 1);
    const scale = clamp(1 - s*0.92, 0.08, 1);
    const tw = Math.max(2, Math.floor(w * scale));
    const th = Math.max(2, Math.floor(h * scale));
    
    const tmp = applyPixelate._tmp || (applyPixelate._tmp = document.createElement("canvas"));
    const tctx = tmp.getContext("2d");
    tmp.width = tw; tmp.height = th;
    
    tctx.imageSmoothingEnabled = false;
    tctx.clearRect(0,0,tw,th);
    tctx.drawImage(srcCanvas, x,y,w,h, 0,0,tw,th);
    
    targetCtx.save();
    targetCtx.imageSmoothingEnabled = false;
    targetCtx.drawImage(tmp, 0,0,tw,th, x,y,w,h);
    targetCtx.restore();
  }
  
  function applyBlur(targetCtx, srcCanvas, x,y,w,h, strength01){
    const s = clamp(strength01, 0, 1);
    const px = 2 + s * 14;
    targetCtx.save();
    targetCtx.filter = `blur(${px}px)`;
    targetCtx.drawImage(srcCanvas, x,y,w,h, x,y,w,h);
    targetCtx.restore();
  }
  
  function applyErase(targetCtx, x,y,w,h, strength01){
    targetCtx.save();
    const alpha = clamp(strength01, 0, 1);
    targetCtx.globalCompositeOperation = "destination-out";
    targetCtx.globalAlpha = 0.35 + alpha*0.65;
    targetCtx.fillStyle = "rgba(0,0,0,1)";
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
  
  function applyShiftNoise(targetCtx, srcCanvas, x,y,w,h, intensity01){
    const s = clamp(intensity01, 0, 1);
    const dx = Math.round((Math.random()*2-1) * (2 + s*10));
    const dy = Math.round((Math.random()*2-1) * (1 + s*6));
    targetCtx.save();
    targetCtx.globalAlpha = 0.9;
    targetCtx.drawImage(srcCanvas, x,y,w,h, x+dx,y+dy,w,h);
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
    const modes = ["erase", "fog", "pixel", "blur"];
    return modes[randInt(0, modes.length-1)];
  }
  
  function keyForDet(d){
    const [x,y,w,h] = d.bbox;
    return `${d.class}:${Math.round(x/10)}:${Math.round(y/10)}:${Math.round(w/10)}:${Math.round(h/10)}`;
  }
  
  async function ensureModel(){
    if(model) return model;
    setStatus("AIモデル読込中…（初回のみ）");
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
    
    async function loop(ts){
      if(!running) return;
      
      const vw = canvas.width, vh = canvas.height;
      
      offCtx.save();
      offCtx.clearRect(0,0,vw,vh);
      offCtx.drawImage(video, 0,0, vw, vh);
      offCtx.restore();
      
      const di = Number(detectInterval.value);
      if(ts - lastDetectAt >= di){
        lastDetectAt = ts;
        try{
          const preds = await model.detect(off);
          const t = Number(thr.value);
          const filter = parseClassFilter();
          detections = preds.filter(p => p.score >= t).filter(p => !filter || filter.has(p.class)).slice(0, 12);
        }catch(e){}
      }
      
      ctx.clearRect(0,0,vw,vh);
      ctx.drawImage(off, 0,0, vw, vh);
      
      // ===== 空間無視（A型：近空間と遠空間が揺れる egocentric neglect） =====
      if(enableSpace.checked){
        const prob = Number(spaceProb.value) / 100.0;
        if(chance(prob)){
          const intensity = Number(spaceIntensity.value) / 100.0;
          
// 左側無視領域の幅を時間で揺らす（1/4〜1/2画面）
const time = performance.now() * 0.0006;
const neglectRatio = 0.25 + (Math.sin(time) + 1) * 0.125;
const w = Math.floor(vw * neglectRatio);
          
          const x = 0, y = 0, h = vh;
          
          // 近空間〜遠空間がズレる感じを作る
          applyFog(ctx, x, y, w, h, intensity * 0.85);
          applyBlur(ctx, off, x, y, w, h, intensity * 0.75);
          applyShiftNoise(ctx, off, x, y, w, h, intensity * 0.60);
          
          // ときどき強い欠落（近いものが消えたり、遠いものが消えたりする感じ）
          if(chance(0.35)){
            applyPixelate(ctx, off, x, y, w, h, intensity * 0.90);
          }
          if(chance(0.20)){
            applyErase(ctx, x, y, w, h, intensity * 0.80);
          }
        }
      }

      
      // ===== 物体（検出物体の左半分）エフェクト =====
      if(enableObject.checked){
        for(const d of detections){
          const [x,y,w,h] = d.bbox;
          
          // 物体の左半分だけ
          const hw = Math.floor(w / 2);
          const s = Number(spaceIntensity.value) / 100.0;
          
          // 物体の左側を壊す
          applyPixelate(ctx, off, x, y, hw, h, s * 0.9);
          applyFog(ctx, x, y, hw, h, s * 0.6);
          
          // たまに欠落
          if(chance(0.25)){
            applyErase(ctx, x, y, hw, h, s * 0.8);
          }
        }
      }
      
      if(showBoxes.checked) drawBoxes();
      
      requestAnimationFrame(loop);
    }
    
    canvas.addEventListener("touchmove", e=>e.preventDefault(), {passive:false});
      // ===== 3本指タッチでメニュー表示/非表示 =====
      canvas.addEventListener("touchstart", (e) => {
        if (e.touches && e.touches.length === 3) {
          document.body.classList.toggle("showMenu");
        }
      }, { passive: true });
        
// ===== ダブルタップで VRモード切替 =====
let _lastTap = 0;
canvas.addEventListener("touchend", () => {
  const now = Date.now();
  if (now - _lastTap < 350) {
    if (document.body.classList.contains("vrmode")) {
      exitVR();
    } else {
      enterVR();
    }
  }
  _lastTap = now;
});
        
        // ===== UI 初期化 =====
        btnFS.addEventListener("click", enterVR);
        mirror.checked = true;
        showBoxes.checked = true;

function enterVR(){
  document.body.classList.add("vrmode");

  // 画面を横向きにロック（対応ブラウザのみ）
  if(screen.orientation && screen.orientation.lock){
    screen.orientation.lock("landscape").catch(()=>{});
  }

  // フルスクリーンにする
  if(!document.fullscreenElement){
    document.documentElement.requestFullscreen?.();
  }
}

function exitVR(){
  document.body.classList.remove("vrmode");

  // 向きロック解除
  if(screen.orientation && screen.orientation.unlock){
    screen.orientation.unlock();
  }

  // フルスクリーン解除
  if(document.fullscreenElement){
    document.exitFullscreen?.();
  }
}

btnExitVR.addEventListener("click", exitVR);
