// main.js - カメラ取得、背景差分で単純物体検出、WebGL に動画を渡す
(async function(){
  const video = document.getElementById('video');
  const canvas = document.getElementById('glcanvas');
  const gl = canvas.getContext('webgl');
  if(!gl){ alert('WebGL が必要です'); return; }

  // UI
  const enableObject = document.getElementById('enableObject');
  const detectionMode = document.getElementById('detectionMode');
  const strengthEl = document.getElementById('strength');
  const resetBgBtn = document.getElementById('resetBg');

  // shaders load
  function createShader(gl, type, src){
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if(!gl.getShaderParameter(s, gl.COMPILE_STATUS)){
      console.error(gl.getShaderInfoLog(s)); return null;
    }
    return s;
  }
  function createProgram(gl, vsSrc, fsSrc){
    const vs = createShader(gl, gl.VERTEX_SHADER, vsSrc);
    const fs = createShader(gl, gl.FRAGMENT_SHADER, fsSrc);
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    if(!gl.getProgramParameter(p, gl.LINK_STATUS)){
      console.error(gl.getProgramInfoLog(p)); return null;
    }
    return p;
  }

  // fetch shaders from inline <script> is not used; we embed by fetching files via fetch()
  const vsResp = await fetch('shader.vert'); const vsSrc = await vsResp.text();
  const fsResp = await fetch('shader.frag'); const fsSrc = await fsResp.text();
  const program = createProgram(gl, vsSrc, fsSrc);

  // quad
  const pos = new Float32Array([
    -1,-1,  1,-1,  -1,1,
    -1,1,   1,-1,  1,1
  ]);
  const posBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
  gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
  const a_position = gl.getAttribLocation(program, 'a_position');

  const texcoords = new Float32Array([
    0,1, 1,1, 0,0,
    0,0, 1,1, 1,0
  ]);
  const tcBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, tcBuf);
  gl.bufferData(gl.ARRAY_BUFFER, texcoords, gl.STATIC_DRAW);
  const a_texcoord = gl.getAttribLocation(program, 'a_texcoord');

  // texture from video
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  // uniforms
  const u_texture = gl.getUniformLocation(program, 'u_texture');
  const u_time = gl.getUniformLocation(program, 'u_time');
  const u_strength = gl.getUniformLocation(program, 'u_strength');
  const u_resolution = gl.getUniformLocation(program, 'u_resolution');
  const u_centerX = gl.getUniformLocation(program, 'u_centerX');
  const u_objCount = gl.getUniformLocation(program, 'u_objCount');
  const u_objs = gl.getUniformLocation(program, 'u_objs');

  // offscreen canvas for detection
  const off = document.createElement('canvas');
  const offCtx = off.getContext('2d');

  // background model for simple detection
  let bgData = null;
  let bgReset = true;
  resetBgBtn.addEventListener('click', ()=>{ bgReset = true; });

  // size helpers
  function resizeToVideo(){
    const w = video.videoWidth, h = video.videoHeight;
    if(!w || !h) return;
    canvas.width = w; canvas.height = h;
    off.width = w; off.height = h;
    gl.viewport(0,0,canvas.width, canvas.height);
  }

  // get camera
  try{
    const stream = await navigator.mediaDevices.getUserMedia({video: {facingMode: "environment"}, audio:false});
    video.srcObject = stream;
    await video.play();
  }catch(e){
    alert('カメラにアクセスできません: ' + e.message);
    return;
  }

  // detection helper: compute bounding box of motion (simple)
  function detectObjectSimple(){
    const w = off.width, h = off.height;
    offCtx.drawImage(video, 0, 0, w, h);
    const frame = offCtx.getImageData(0,0,w,h);
    const data = frame.data;
    if(!bgData || bgReset){
      bgData = new Float32Array(w*h*3);
      for(let i=0;i<w*h;i++){
        bgData[i*3+0] = data[i*4+0];
        bgData[i*3+1] = data[i*4+1];
        bgData[i*3+2] = data[i*4+2];
      }
      bgReset = false;
      return null;
    }
    // running average update
    const alpha = 0.02;
    let minX=w, minY=h, maxX=0, maxY=0;
    let any=false;
    for(let y=0;y<h;y++){
      for(let x=0;x<w;x++){
        const i = (y*w + x);
        const r = data[i*4+0], g = data[i*4+1], b = data[i*4+2];
        // update bg
        const bi = i*3;
        bgData[bi+0] = bgData[bi+0] * (1-alpha) + r * alpha;
        bgData[bi+1] = bgData[bi+1] * (1-alpha) + g * alpha;
        bgData[bi+2] = bgData[bi+2] * (1-alpha) + b * alpha;
        // diff
        const dr = Math.abs(r - bgData[bi+0]);
        const dg = Math.abs(g - bgData[bi+1]);
        const db = Math.abs(b - bgData[bi+2]);
        const diff = (dr + dg + db) / 3;
        if(diff > 30){ // threshold
          any = true;
          if(x < minX) minX = x;
          if(y < minY) minY = y;
          if(x > maxX) maxX = x;
          if(y > maxY) maxY = y;
        }
      }
    }
    if(!any) return null;
    // pad bbox a bit
    minX = Math.max(0, minX - 8);
    minY = Math.max(0, minY - 8);
    maxX = Math.min(w-1, maxX + 8);
    maxY = Math.min(h-1, maxY + 8);
    const bw = maxX - minX;
    const bh = maxY - minY;
    if(bw*bh < 1000) return null; // small => ignore
    return {x:minX/w, y:minY/h, w:bw/w, h:bh/h};
  }

  // TODO: ML detection path (TensorFlow.js) can be plugged here later.

  // prepare attributes
  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
  gl.enableVertexAttribArray(a_position);
  gl.vertexAttribPointer(a_position, 2, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, tcBuf);
  gl.enableVertexAttribArray(a_texcoord);
  gl.vertexAttribPointer(a_texcoord, 2, gl.FLOAT, false, 0, 0);

  const start = performance.now();

  let objs = []; // detected objects (array of {x,y,w,h} normalized)

  function render(){
    if(video.readyState >= 2){
      resizeToVideo();
      // update texture from video
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      try{
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
      }catch(e){
        // sometimes cross-origin issues; ignore in local
      }
    }

    // detection
    objs = [];
    if(enableObject.checked){
      if(detectionMode.value === 'simple'){
        const d = detectObjectSimple();
        if(d) objs.push(d);
      }else{
        // placeholder for ML method; if not implemented, fallback to simple
        const d = detectObjectSimple(); if(d) objs.push(d);
      }
    }

    // set uniforms
    gl.useProgram(program);
    gl.uniform1i(u_texture, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);

    const t = (performance.now() - start) / 1000;
    gl.uniform1f(u_time, t);
    gl.uniform1f(u_strength, parseFloat(strengthEl.value));
    gl.uniform2f(u_resolution, canvas.width, canvas.height);
    // center line in normalized coords (we use 0.5)
    gl.uniform1f(u_centerX, 0.5);
    // pass objects (up to 8)
    const maxObjs = 8;
    const flat = new Float32Array(maxObjs*4);
    for(let i=0;i<maxObjs;i++){
      if(i < objs.length){
        flat[i*4+0] = objs[i].x;
        flat[i*4+1] = objs[i].y;
        flat[i*4+2] = objs[i].w;
        flat[i*4+3] = objs[i].h;
      }else{
        flat[i*4+0] = flat[i*4+1] = flat[i*4+2] = flat[i*4+3] = 0.0;
      }
    }
    gl.uniform1i(u_objCount, objs.length);
    gl.uniform4fv(u_objs, flat);

    // draw
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    requestAnimationFrame(render);
  }

  requestAnimationFrame(render);
})();
