/* Ojo de pez · cámara con lente "fisheye" en tiempo real (WebGL) */
(() => {
  'use strict';

  /* ---------- Utilidades ---------- */
  const $ = (sel) => document.querySelector(sel);
  const pad = (n) => String(n).padStart(2, '0');
  const store = {
    get(k, d) { try { const v = localStorage.getItem('ojo.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('ojo.' + k, JSON.stringify(v)); } catch { /* sin almacenamiento */ } }
  };
  const stamp = () => {
    const d = new Date();
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  };
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  /* ---------- Elementos ---------- */
  const canvas = $('#stage');
  const hintEl = $('#hint'), hintMsg = $('#hintMsg'), hintBtn = $('#hintBtn');
  const toastEl = $('#toast'), flashEl = $('#flash');
  const recEl = $('#rec'), recTime = $('#recTime');
  const shutter = $('#shutter');
  const strengthEl = $('#strength'), strengthVal = $('#strengthVal');
  const mirrorBtn = $('#mirror'), flipBtn = $('#flip');
  const fileInput = $('#file'), fileLabel = $('#fileLabel');
  const closeFileBtn = $('#closeFile'), installBtn = $('#install');
  const shapeBtns = [...document.querySelectorAll('[data-shape]')];
  const modeBtns = [...document.querySelectorAll('.modes [data-mode]')];
  const resultEl = $('#result'), resultMedia = $('#resultMedia'), resultNote = $('#resultNote');
  const saveBtn = $('#save'), shareBtn = $('#share'), discardBtn = $('#discard');

  /* ---------- Estado ---------- */
  const state = {
    mode: 'photo',                       // 'photo' | 'video'
    facing: 'environment',               // 'environment' | 'user'
    strength: store.get('strength', 0.5),
    full: store.get('full', false),      // false = círculo, true = cuadro completo
    mirror: false,
    source: null,                        // { kind: 'camera'|'image'|'video', el, dirty? }
    stream: null,
    mic: null,
    recorder: null,
    fileURL: null
  };

  const camVideo = document.createElement('video');
  camVideo.playsInline = true;
  camVideo.muted = true;
  camVideo.setAttribute('playsinline', '');

  const fileVideo = document.createElement('video');
  fileVideo.playsInline = true;
  fileVideo.loop = true;
  fileVideo.setAttribute('playsinline', '');

  /* ---------- Avisos ---------- */
  let toastTimer;
  function toast(msg, ms = 2600) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
  }
  function showHint(msg, retry) { hintMsg.textContent = msg; hintBtn.hidden = !retry; hintEl.hidden = false; }
  function hideHint() { hintEl.hidden = true; }

  /* ---------- WebGL: lente ojo de pez ---------- */
  const glOpts = { alpha: false, antialias: false, preserveDrawingBuffer: true };
  const gl = canvas.getContext('webgl', glOpts) || canvas.getContext('experimental-webgl', glOpts);
  if (!gl) {
    showHint('Tu navegador no admite WebGL, necesario para el efecto de lente.', false);
    return;
  }
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); toast('Se perdió el contexto gráfico. Recarga la app.', 6000); });

  const VERT = `
attribute vec2 a;
varying vec2 v;
void main() { v = a * 0.5 + 0.5; gl_Position = vec4(a, 0.0, 1.0); }`;

  // Proyección esférica: cada píxel de salida toma su color de un punto del
  // origen más cercano al centro (asin(d) * 2/PI < d), lo que abomba el centro
  // y comprime los bordes, como una lente ojo de pez.
  const FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 v;
uniform sampler2D tex;
uniform float aspect;    // ancho/alto del lienzo
uniform float strength;  // 0..1
uniform float full;      // 1 = cuadro completo, 0 = círculo
uniform float mirror;    // 1 = espejo horizontal
uniform vec2 crop;       // porción del origen que cubre el lienzo
void main() {
  vec2 ax = vec2(aspect, 1.0);
  float norm = full > 0.5 ? length(ax) : 1.0;
  vec2 p = (v * 2.0 - 1.0) * ax / norm;
  float d = length(p);
  if (full < 0.5 && d > 1.0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  float dd = clamp(d, 0.0, 1.0);
  float k = d > 0.0001 ? asin(dd) / 1.5707963 / d : 0.63662;
  float f = pow(k, strength * 2.0);
  vec2 s = p * f * norm / ax;
  if (mirror > 0.5) s.x = -s.x;
  vec2 uv = 0.5 + 0.5 * s * crop;
  gl_FragColor = texture2D(tex, clamp(uv, 0.0, 1.0));
}`;

  function compile(type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
    return sh;
  }

  const prog = gl.createProgram();
  try {
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  } catch (err) {
    console.error(err);
    showHint('No se pudo preparar el efecto de lente en este dispositivo.', false);
    return;
  }
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const aLoc = gl.getAttribLocation(prog, 'a');
  gl.enableVertexAttribArray(aLoc);
  gl.vertexAttribPointer(aLoc, 2, gl.FLOAT, false, 0, 0);

  const U = {};
  ['tex', 'aspect', 'strength', 'full', 'mirror', 'crop'].forEach((n) => { U[n] = gl.getUniformLocation(prog, n); });

  const texture = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.uniform1i(U.tex, 0);

  const MAX_SIDE = 2560;

  function sourceSize(s) {
    return s.kind === 'image' ? [s.el.naturalWidth, s.el.naturalHeight] : [s.el.videoWidth, s.el.videoHeight];
  }

  function draw() {
    const s = state.source;
    if (!s) return;
    const [w, h] = sourceSize(s);
    if (!w || !h) return;
    if (s.kind !== 'image' && s.el.readyState < 2) return;

    let cw, ch;
    if (state.full) {
      const k = Math.min(1, MAX_SIDE / Math.max(w, h));
      cw = Math.round(w * k); ch = Math.round(h * k);
    } else {
      const side = Math.min(w, h);
      cw = ch = Math.round(side * Math.min(1, MAX_SIDE / side));
    }
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw; canvas.height = ch;
      gl.viewport(0, 0, cw, ch);
    }

    if (s.kind !== 'image' || s.dirty) {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, s.el);
      s.dirty = false;
    }

    const S = w / h;
    gl.uniform1f(U.aspect, cw / ch);
    gl.uniform1f(U.strength, state.strength);
    gl.uniform1f(U.full, state.full ? 1 : 0);
    gl.uniform1f(U.mirror, state.mirror ? 1 : 0);
    if (state.full) gl.uniform2f(U.crop, 1, 1);
    else if (S >= 1) gl.uniform2f(U.crop, 1 / S, 1);
    else gl.uniform2f(U.crop, 1, S);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  function loop() { draw(); requestAnimationFrame(loop); }

  /* ---------- Cámara ---------- */
  function stopStream() {
    if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
    camVideo.srcObject = null;
  }

  async function startCamera() {
    if (state.recorder) return;
    showHint('Activando cámara…', false);
    stopStream();
    releaseFile();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showHint('Este navegador no permite usar la cámara. Abre la app desde una dirección HTTPS.', true);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: state.facing === 'user' ? 'user' : { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 }
        }
      });
      state.stream = stream;
      camVideo.srcObject = stream;
      try { await camVideo.play(); } catch { /* se reintenta al recibir datos */ }
      state.mirror = state.facing === 'user';
      setSource({ kind: 'camera', el: camVideo });
      hideHint();
    } catch (err) {
      console.error(err);
      const msg = err && err.name === 'NotAllowedError'
        ? 'Permiso de cámara denegado. Actívalo en los ajustes del navegador y vuelve a intentarlo.'
        : err && err.name === 'NotFoundError'
          ? 'No se encontró ninguna cámara en este dispositivo.'
          : 'No se pudo abrir la cámara. Cierra otras apps que la usen y reintenta.';
      setSource(null);
      showHint(msg, true);
    }
  }

  function setSource(src) {
    state.source = src;
    if (src && src.kind === 'image' && state.mode === 'video') state.mode = 'photo';
    updateUI();
  }

  /* ---------- Archivos de la galería ---------- */
  let fileAudio; // undefined = sin crear, null = no disponible, objeto = { ctx, dest }
  function ensureFileAudio() {
    if (fileAudio !== undefined) return fileAudio;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      const ctx = new AC();
      const node = ctx.createMediaElementSource(fileVideo);
      const dest = ctx.createMediaStreamDestination();
      node.connect(dest); // solo hacia la grabación: la vista previa queda en silencio
      fileAudio = { ctx, dest };
    } catch { fileAudio = null; }
    return fileAudio;
  }

  function releaseFile() {
    fileVideo.pause();
    fileVideo.removeAttribute('src');
    fileVideo.load();
    if (state.fileURL) { URL.revokeObjectURL(state.fileURL); state.fileURL = null; }
  }

  fileInput.addEventListener('change', async () => {
    const f = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (!f) return;
    const url = URL.createObjectURL(f);

    if (f.type.startsWith('image/')) {
      const img = new Image();
      img.src = url;
      try { await img.decode(); } catch { URL.revokeObjectURL(url); toast('No se pudo abrir esa imagen.'); return; }
      stopStream(); releaseFile();
      state.fileURL = url;
      state.mirror = false;
      setSource({ kind: 'image', el: img, dirty: true });
      hideHint();
    } else if (f.type.startsWith('video/')) {
      stopStream(); releaseFile();
      state.fileURL = url;
      ensureFileAudio();
      fileVideo.src = url;
      try { await fileVideo.play(); } catch { URL.revokeObjectURL(url); state.fileURL = null; toast('No se pudo abrir ese vídeo.'); return; }
      state.mirror = false;
      setSource({ kind: 'video', el: fileVideo });
      hideHint();
    } else {
      URL.revokeObjectURL(url);
      toast('Formato no compatible. Usa una foto o un vídeo.');
    }
  });

  closeFileBtn.addEventListener('click', startCamera);

  /* ---------- Foto ---------- */
  function takePhoto() {
    if (!state.source) { toast('La cámara aún no está lista.'); return; }
    flashEl.classList.remove('on');
    void flashEl.offsetWidth;
    flashEl.classList.add('on');
    draw();
    canvas.toBlob((blob) => {
      if (!blob) { toast('No se pudo crear la foto.'); return; }
      showResult(blob, 'image');
    }, 'image/jpeg', 0.95);
  }

  /* ---------- Vídeo ---------- */
  function pickMime() {
    const list = [
      'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
      'video/mp4',
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm'
    ];
    return list.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
  }

  let recTimer, recStart;
  function startTimer() {
    recStart = Date.now();
    recTime.textContent = '00:00';
    recEl.hidden = false;
    recTimer = setInterval(() => {
      const s = Math.floor((Date.now() - recStart) / 1000);
      recTime.textContent = `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
    }, 250);
  }
  function stopTimer() { clearInterval(recTimer); recEl.hidden = true; }

  async function startRecording() {
    const s = state.source;
    if (!s || s.kind === 'image') return;
    if (!window.MediaRecorder || !canvas.captureStream) { toast('Este navegador no puede grabar vídeo.'); return; }

    const out = canvas.captureStream(30);

    // Audio: micrófono en cámara, pista original en vídeos de la galería
    try {
      if (s.kind === 'camera') {
        state.mic = await navigator.mediaDevices.getUserMedia({ audio: true });
        state.mic.getAudioTracks().forEach((t) => out.addTrack(t));
      } else if (s.kind === 'video') {
        const fa = ensureFileAudio();
        if (fa) { await fa.ctx.resume(); fa.dest.stream.getAudioTracks().forEach((t) => out.addTrack(t)); }
      }
    } catch { toast('Se grabará sin audio.'); }

    const mime = pickMime();
    const bits = { videoBitsPerSecond: 8000000 };
    let rec;
    try { rec = new MediaRecorder(out, mime ? { mimeType: mime, ...bits } : bits); }
    catch { rec = new MediaRecorder(out); }

    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onerror = () => { toast('Error durante la grabación.'); };
    rec.onstop = () => {
      stopTimer();
      if (state.mic) { state.mic.getTracks().forEach((t) => t.stop()); state.mic = null; }
      if (s.kind === 'video') { fileVideo.loop = true; fileVideo.play().catch(() => {}); }
      state.recorder = null;
      updateUI();
      const type = (rec.mimeType || mime || 'video/webm').split(';')[0];
      const blob = new Blob(chunks, { type });
      if (blob.size) showResult(blob, 'video'); else toast('La grabación quedó vacía.');
    };

    state.recorder = rec;
    if (s.kind === 'video') {
      fileVideo.loop = false;
      fileVideo.currentTime = 0;
      fileVideo.addEventListener('ended', stopRecording, { once: true });
      try { await fileVideo.play(); } catch { /* ya reproduciendo */ }
    }
    rec.start(500);
    startTimer();
    updateUI();
  }

  function stopRecording() {
    const rec = state.recorder;
    if (rec && rec.state !== 'inactive') rec.stop();
  }

  /* ---------- Resultado: guardar y compartir ---------- */
  const result = { blob: null, url: null, name: '' };

  const canShareFiles = (() => {
    try { return !!(navigator.canShare && navigator.canShare({ files: [new File([''], 'x.jpg', { type: 'image/jpeg' })] })); }
    catch { return false; }
  })();

  function showResult(blob, kind) {
    closeResult();
    const ext = kind === 'image' ? 'jpg' : (blob.type.includes('mp4') ? 'mp4' : 'webm');
    result.blob = blob;
    result.name = `ojo-de-pez-${stamp()}.${ext}`;
    result.url = URL.createObjectURL(blob);

    let el;
    if (kind === 'image') {
      el = new Image();
      el.alt = 'Foto con efecto ojo de pez';
      el.src = result.url;
    } else {
      el = document.createElement('video');
      el.src = result.url;
      el.controls = true;
      el.autoplay = true;
      el.loop = true;
      el.muted = true;
      el.playsInline = true;
      el.setAttribute('playsinline', '');
    }
    resultMedia.replaceChildren(el);
    shareBtn.hidden = !canShareFiles;
    resultNote.textContent = isIOS
      ? `En iPhone y iPad: pulsa «Compartir» y elige «Guardar ${kind === 'image' ? 'imagen' : 'vídeo'}» para enviarlo a Fotos.`
      : 'Se guarda en la carpeta de descargas de tu dispositivo.';
    resultEl.hidden = false;
    saveBtn.focus();
  }

  function closeResult() {
    resultEl.hidden = true;
    resultMedia.replaceChildren();
    if (result.url) URL.revokeObjectURL(result.url);
    result.blob = null; result.url = null;
  }

  saveBtn.addEventListener('click', () => {
    if (!result.url) return;
    const a = document.createElement('a');
    a.href = result.url;
    a.download = result.name;
    document.body.append(a);
    a.click();
    a.remove();
    toast('Guardado.');
  });

  shareBtn.addEventListener('click', async () => {
    if (!result.blob) return;
    const file = new File([result.blob], result.name, { type: result.blob.type });
    try { await navigator.share({ files: [file], title: 'Ojo de pez' }); }
    catch (err) { if (err && err.name !== 'AbortError') toast('No se pudo compartir.'); }
  });

  discardBtn.addEventListener('click', closeResult);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !resultEl.hidden) closeResult(); });

  /* ---------- Controles ---------- */
  function updateUI() {
    const kind = state.source ? state.source.kind : null;
    const rec = !!state.recorder;
    const pct = Math.round(state.strength * 100);

    document.body.dataset.mode = state.mode;
    document.body.classList.toggle('recording', rec);

    strengthEl.value = pct;
    strengthVal.textContent = pct + '%';

    shapeBtns.forEach((b) => {
      b.setAttribute('aria-pressed', String((b.dataset.shape === 'full') === state.full));
      b.disabled = rec;
    });
    mirrorBtn.setAttribute('aria-pressed', String(state.mirror));

    modeBtns.forEach((b) => {
      b.setAttribute('aria-selected', String(b.dataset.mode === state.mode));
      b.disabled = rec || (b.dataset.mode === 'video' && kind === 'image');
    });

    flipBtn.hidden = kind === 'image' || kind === 'video';
    flipBtn.disabled = rec;
    closeFileBtn.hidden = !(kind === 'image' || kind === 'video') || rec;
    fileInput.disabled = rec;
    fileLabel.classList.toggle('disabled', rec);

    shutter.setAttribute('aria-label', state.mode === 'photo' ? 'Tomar foto' : (rec ? 'Detener grabación' : 'Grabar vídeo'));
  }

  strengthEl.addEventListener('input', () => {
    state.strength = Number(strengthEl.value) / 100;
    strengthVal.textContent = strengthEl.value + '%';
    store.set('strength', state.strength);
  });

  shapeBtns.forEach((b) => b.addEventListener('click', () => {
    state.full = b.dataset.shape === 'full';
    store.set('full', state.full);
    updateUI();
  }));

  mirrorBtn.addEventListener('click', () => { state.mirror = !state.mirror; updateUI(); });

  modeBtns.forEach((b) => b.addEventListener('click', () => {
    if (b.disabled) return;
    state.mode = b.dataset.mode;
    updateUI();
  }));

  shutter.addEventListener('click', () => {
    if (state.mode === 'photo') takePhoto();
    else if (state.recorder) stopRecording();
    else startRecording();
  });

  flipBtn.addEventListener('click', () => {
    state.facing = state.facing === 'user' ? 'environment' : 'user';
    startCamera();
  });

  hintBtn.addEventListener('click', startCamera);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || state.recorder) return;
    if (state.source && state.source.kind === 'camera') {
      const track = state.stream && state.stream.getVideoTracks()[0];
      if (!track || track.readyState === 'ended') startCamera();
    }
  });

  /* ---------- Instalación y service worker ---------- */
  let installEvent = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installEvent = e;
    installBtn.hidden = false;
  });
  installBtn.addEventListener('click', async () => {
    if (!installEvent) return;
    installEvent.prompt();
    try { await installEvent.userChoice; } catch { /* sin respuesta */ }
    installEvent = null;
    installBtn.hidden = true;
  });
  window.addEventListener('appinstalled', () => { installBtn.hidden = true; });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
  }

  /* ---------- Inicio ---------- */
  updateUI();
  requestAnimationFrame(loop);
  startCamera();
})();
