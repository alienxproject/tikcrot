'use strict';

// ─── GUARD ────────────────────────────────────────────────────────────────────
if (typeof videos === 'undefined' || !videos.length) {
  document.getElementById('feed').innerHTML =
    '<div style="color:#fff;text-align:center;padding-top:40vh;font-size:16px">Gagal memuat video.<br>Cek file data/videos.js</div>';
  throw new Error('videos.js kosong atau tidak ditemukan');
}

// ─── LAYOUT FIX ───────────────────────────────────────────────────────────────
// navbar.offsetHeight adalah ukuran real — tidak terpengaruh env() yang 0 di Chrome
function fixLayout() {
  var h = document.getElementById('navbar').offsetHeight || 60;
  var bot = h + 'px';
  document.getElementById('feed').style.bottom = bot;
  document.querySelectorAll('.page').forEach(function(p){ p.style.bottom = bot; });
  document.getElementById('swipeHint').style.bottom = (h + 150) + 'px';
  document.getElementById('toast').style.bottom     = (h + 16)  + 'px';
}
// RAF: jalan setelah browser selesai paint pertama
requestAnimationFrame(function(){ fixLayout(); requestAnimationFrame(fixLayout); });
window.addEventListener('load', function(){ requestAnimationFrame(fixLayout); });
window.addEventListener('resize', fixLayout);
if (window.visualViewport) window.visualViewport.addEventListener('resize', fixLayout);

// ─── UTILS ────────────────────────────────────────────────────────────────────
function shuffle(a) {
  var arr = a.slice();
  for (var i = arr.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

var toastTmr;
function showToast(msg) {
  var el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTmr);
  toastTmr = setTimeout(function(){ el.classList.remove('show'); }, 2000);
}

// ─── CTA ──────────────────────────────────────────────────────────────────────
var CTA_URL = (function(){
  if (typeof ctaUrl !== 'undefined' && ctaUrl) return ctaUrl;
  var f = videos.find(function(v){ return v.cta; });
  return f ? f.cta : '';
})();
var CTA_SWIPES = 3;

// ─── STATE ────────────────────────────────────────────────────────────────────
var vlist       = shuffle(videos);          // semua video, acak tiap refresh
var cur         = 0;                        // index aktif
var locked      = false;                    // cegah double-swipe
var interacted  = false;                    // sudah ada interaksi user?
var swipeCnt    = 0;
var ctaFired    = false;
var leftHome    = false;
var wasPlaying  = false;                    // untuk resume saat balik ke home

var savedSet    = new Set(JSON.parse(localStorage.getItem('tiktod_saves') || '[]'));
function persistSaved(){ localStorage.setItem('tiktod_saves', JSON.stringify([...savedSet])); }

// userPaused[i] = true → jangan auto-play video ini
var userPaused  = vlist.map(function(){ return false; });

var feed   = document.getElementById('feed');
var slides = [];

// ─── THUMBNAIL SYSTEM ────────────────────────────────────────────────────────
// 2 cara saja, prioritas berurutan:
//   1. Background snap — hidden video element, seek ke detik ke-1, snap ke canvas
//      Mulai otomatis setelah halaman load, serial satu per satu (hemat bandwidth)
//   2. Field thumb di videos.js — fallback kalau snap kena CORS block
//
// CORS note: canvas.drawImage akan throw SecurityError kalau CDN tidak kirim
// header Access-Control-Allow-Origin. Kalau ini terjadi, fallback ke thumb manual.

var thumbCache  = {};   // { videoId: dataURL }
var snapQueue   = [];   // antrian { id, src }
var snapRunning = false;

// Panggil ini untuk update semua img[data-tid] di grid yang sudah ter-render
function applyThumbToGrid(videoId, dataUrl) {
  document.querySelectorAll('img[data-tid="' + videoId + '"]').forEach(function(img){
    img.src = dataUrl;
    img.style.display = 'block';
    var ph = img.parentNode && img.parentNode.querySelector('.grid-ph');
    if (ph) ph.style.display = 'none';
  });
}

// Snap 1 video: buat hidden video, seek ke 10% durasi, drawImage ke canvas
// generateThumb(src, callback) — callback(dataUrl) atau callback(null) kalau gagal
function generateThumb(src, callback) {
  var hv = document.createElement('video');
  hv.muted     = true;
  hv.preload   = 'metadata';
  hv.setAttribute('playsinline', '');

  // crossOrigin HARUS di-set SEBELUM src — ini yang unlock canvas drawImage
  // Kalau CDN support CORS (kirim Access-Control-Allow-Origin), ini berhasil
  // Kalau tidak support, onerror akan terpanggil → kita retry tanpa crossOrigin
  hv.crossOrigin = 'anonymous';

  var settled = false;
  function done(result) {
    if (settled) return; settled = true;
    clearTimeout(tmo);
    hv.pause(); hv.removeAttribute('src'); hv.load();
    callback(result);
  }

  var tmo = setTimeout(function(){ done(null); }, 7000);

  hv.addEventListener('loadedmetadata', function(){
    // Seek ke 10% durasi — dapat frame yang lebih menarik dari frame 0
    hv.currentTime = Math.max(0.5, (hv.duration || 10) * 0.1);
  }, { once: true });

  hv.addEventListener('seeked', function(){
    try {
      var cv = document.createElement('canvas');
      cv.width = 180; cv.height = 320;
      var ctx = cv.getContext('2d');
      ctx.drawImage(hv, 0, 0, 180, 320);

      // Deteksi blank/hitam frame: sample beberapa pixel
      var px = ctx.getImageData(90, 160, 1, 1).data; // pixel tengah
      var isBlank = (px[0] < 5 && px[1] < 5 && px[2] < 5); // hampir hitam
      if (isBlank) { done(null); return; }

      var d = cv.toDataURL('image/jpeg', 0.7);
      done((d && d.length > 1500) ? d : null);
    } catch(e) {
      // SecurityError: tainted canvas — CDN tidak support CORS
      done(null);
    }
  }, { once: true });

  hv.addEventListener('error', function(){
    if (settled) return;
    // Error dengan crossOrigin → coba ulang TANPA crossOrigin
    // Beberapa CDN reject request yang punya Origin header
    settled = false;
    clearTimeout(tmo);
    tmo = setTimeout(function(){ done(null); }, 7000);

    var hv2 = document.createElement('video');
    hv2.muted   = true;
    hv2.preload = 'metadata';
    hv2.setAttribute('playsinline','');
    // Tidak set crossOrigin — video mungkin bisa load, tapi canvas mungkin tainted

    hv2.addEventListener('loadedmetadata', function(){
      hv2.currentTime = Math.max(0.5, (hv2.duration || 10) * 0.1);
    }, { once: true });

    hv2.addEventListener('seeked', function(){
      try {
        var cv = document.createElement('canvas');
        cv.width = 180; cv.height = 320;
        var ctx = cv.getContext('2d');
        ctx.drawImage(hv2, 0, 0, 180, 320);
        var px = ctx.getImageData(90, 160, 1, 1).data;
        if (px[0] < 5 && px[1] < 5 && px[2] < 5) { done(null); return; }
        var d = cv.toDataURL('image/jpeg', 0.7);
        done((d && d.length > 1500) ? d : null);
      } catch(e) { done(null); } // CORS block — canvas tainted, fallback ke placeholder
    }, { once: true });

    hv2.addEventListener('error', function(){ done(null); }, { once: true });
    hv2.src = src;
  }, { once: true });

  hv.src = src;
}

// Jalankan queue satu per satu — tidak spam CDN, hemat bandwidth low-speed
function runQueue() {
  if (snapRunning || snapQueue.length === 0) return;
  snapRunning = true;
  var item = snapQueue.shift();
  if (thumbCache[item.id]) { snapRunning = false; runQueue(); return; }

  generateThumb(item.src, function(dataUrl){
    if (dataUrl) {
      thumbCache[item.id] = dataUrl;
      applyThumbToGrid(item.id, dataUrl);
    }
    snapRunning = false;
    setTimeout(runQueue, 100); // 100ms delay antar video
  });
}

// Tambah semua video ke queue dan mulai
function startThumbQueue() {
  vlist.forEach(function(v){
    if (!thumbCache[v.id] && v.src) snapQueue.push({ id: v.id, src: v.src });
  });
  runQueue();
}

// Snap passif saat video playing di feed — langsung dari element yang sudah ada
// Ini juga pakai generateThumb tapi via canvas langsung (video sudah loaded)
function snapThumbFromPlaying(vidEl, videoId) {
  if (thumbCache[videoId]) return;
  if (vidEl.readyState < 2 || vidEl.currentTime < 0.1) return;
  try {
    var cv = document.createElement('canvas');
    cv.width = 180; cv.height = 320;
    var ctx = cv.getContext('2d');
    ctx.drawImage(vidEl, 0, 0, 180, 320);
    var px = ctx.getImageData(90, 160, 1, 1).data;
    if (px[0] < 5 && px[1] < 5 && px[2] < 5) return; // blank frame
    var d = cv.toDataURL('image/jpeg', 0.7);
    if (d && d.length > 1500) {
      thumbCache[videoId] = d;
      applyThumbToGrid(videoId, d);
    }
  } catch(e) {}
}

// ─── BUILD FEED DOM ───────────────────────────────────────────────────────────
var ICON_SAVE_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" width="22" height="22"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>';
var ICON_SAVE_ON  = '<svg viewBox="0 0 24 24" fill="#FFD700" stroke="#FFD700" stroke-width="2" width="22" height="22"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>';

vlist.forEach(function(v, i) {
  var slide = document.createElement('div');
  slide.className = 'slide';

  var vid = document.createElement('video');
  vid.setAttribute('playsinline','');
  vid.setAttribute('webkit-playsinline','');
  vid.muted   = true;
  vid.preload = 'none';
  vid.loop    = false;
  if (v.thumb) vid.poster = v.thumb;
  if (i === 0) { vid.src = v.src; vid.preload = 'metadata'; }
  else           vid.dataset.src = v.src;

  var info = document.createElement('div'); info.className = 'info';
  var h3 = document.createElement('h3'); h3.textContent = v.title || '';
  var sp = document.createElement('span'); sp.textContent = v.views || '';
  info.appendChild(h3); info.appendChild(sp);

  var pw = document.createElement('div'); pw.className = 'prog-wrap';
  var pf = document.createElement('div'); pf.className = 'prog-fill';
  pw.appendChild(pf);

  var pi = document.createElement('div'); pi.className = 'play-icon';
  var sp2 = document.createElement('div'); sp2.className = 'spinner';

  var sa = document.createElement('div'); sa.className = 'side-actions';

  var saveBtn = document.createElement('div');
  saveBtn.className = 'act-btn' + (savedSet.has(v.id) ? ' saved' : '');
  saveBtn.innerHTML = '<div class="act-icon">'+(savedSet.has(v.id)?ICON_SAVE_ON:ICON_SAVE_OFF)+'</div>'
    +'<span class="act-label">'+(savedSet.has(v.id)?'Saved':'Save')+'</span>';

  var dlBtn = document.createElement('div');
  dlBtn.className = 'act-btn';
  dlBtn.innerHTML = '<div class="act-icon"><svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" width="22" height="22">'
    +'<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>'
    +'<polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></div>'
    +'<span class="act-label">Download</span>';

  sa.appendChild(saveBtn); sa.appendChild(dlBtn);
  slide.appendChild(vid); slide.appendChild(info);
  slide.appendChild(pw); slide.appendChild(pi);
  slide.appendChild(sp2); slide.appendChild(sa);
  feed.appendChild(slide);
  slides.push(slide);

  // ── EVENTS ──
  vid.addEventListener('timeupdate', function(){
    if (vid.duration) pf.style.width = (vid.currentTime / vid.duration * 100) + '%';
  });

  vid.addEventListener('waiting',  function(){ if (i===cur) sp2.classList.add('show'); });
  vid.addEventListener('canplay',  function(){ sp2.classList.remove('show'); });

  vid.addEventListener('playing', function(){
    sp2.classList.remove('show');
    if (!userPaused[i]) pi.classList.remove('show');
    // Snap passif saat video playing
    snapThumbFromPlaying(vid, v.id);
  });

  vid.addEventListener('ended', function(){
    if (i !== cur) return;
    locked = false;
    goTo((cur + 1) % vlist.length, false, false);
  });

  // Tap → play/pause
  slide.addEventListener('click', function(e){
    if (locked) return;
    if (e.target.closest('.side-actions') || e.target.closest('.prog-wrap')) return;
    e.stopPropagation();
    interacted = true;
    vid.muted = false;
    if (vid.paused) {
      userPaused[i] = false;
      pi.classList.remove('show');
      vid.play().catch(function(){ vid.muted = true; vid.play().catch(function(){}); });
    } else {
      userPaused[i] = true;
      vid.pause();
      pi.textContent = '▶'; pi.classList.add('show');
    }
  });

  // Save
  saveBtn.addEventListener('click', function(e){
    e.stopPropagation();
    var icon  = saveBtn.querySelector('.act-icon');
    var label = saveBtn.querySelector('.act-label');
    if (savedSet.has(v.id)) {
      savedSet.delete(v.id);
      saveBtn.classList.remove('saved');
      icon.innerHTML = ICON_SAVE_OFF; label.textContent = 'Save';
      showToast('Dihapus dari Saved');
    } else {
      savedSet.add(v.id);
      saveBtn.classList.add('saved');
      icon.innerHTML = ICON_SAVE_ON; label.textContent = 'Saved';
      showToast('Tersimpan 🔖');
    }
    persistSaved();
    if (document.getElementById('pageLikes').classList.contains('active')) buildGrid('gridLikes', vlist.filter(function(x){ return savedSet.has(x.id); }), true);
  });

  // Download
  dlBtn.addEventListener('click', function(e){
    e.stopPropagation();
    var url = v.src || vid.src;
    if (!url) { showToast('URL tidak tersedia'); return; }
    var a = document.createElement('a');
    a.href = url; a.download = (v.title||'video')+'.mp4'; a.target = '_blank';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    showToast('Mengunduh... ⬇️');
  });

  // Seek
  pw.addEventListener('click', function(e){
    e.stopPropagation();
    if (!vid.duration) return;
    vid.currentTime = ((e.clientX - pw.getBoundingClientRect().left) / pw.offsetWidth) * vid.duration;
  });
});

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function getVid(i){ return slides[i].querySelector('video'); }

function ensureSrc(i){
  if (i < 0 || i >= slides.length) return;
  var v = getVid(i);
  if (!v.src && v.dataset.src) v.src = v.dataset.src;
}

// ─── PLAY ─────────────────────────────────────────────────────────────────────
function playVid(i){
  var v  = getVid(i);
  var sp = slides[i].querySelector('.spinner');
  var pi = slides[i].querySelector('.play-icon');
  if (userPaused[i]) return;

  pi.classList.remove('show');
  v.volume = 1;
  v.muted  = !interacted;

  if (vlist[i] && (vlist[i].finished)) {
    v.currentTime = 0;
    vlist[i].finished = false;
    slides[i].querySelector('.prog-fill').style.width = '0%';
  }

  if (!v.src && v.dataset.src) { v.src = v.dataset.src; }

  if (v.readyState === 0) {
    sp.classList.add('show');
    v.load();
  }

  v.play().catch(function(){
    // Autoplay blocked → coba muted
    v.muted = true;
    v.play().catch(function(){});
  });
}

// ─── NAVIGATE ─────────────────────────────────────────────────────────────────
function goTo(next, force, isSwipe){
  if (locked && !force) return;
  if (next === cur && !force) return;
  locked = true;

  userPaused[cur] = false;
  slides[cur].querySelector('.play-icon').classList.remove('show');

  // Pause semua, hide semua
  slides.forEach(function(s, i){
    if (i !== next) {
      var v = s.querySelector('video');
      v.pause();
      s.querySelector('.spinner').classList.remove('show');
      s.classList.remove('active');
    }
  });

  cur = next;
  slides[cur].classList.add('active');

  // Preload current + 1
  ensureSrc(cur);
  ensureSrc((cur + 1) % vlist.length);

  // Unload video yang jauh (hemat memory untuk low-end)
  var len = slides.length;
  slides.forEach(function(s, i){
    var dist = Math.min(Math.abs(i-cur), len - Math.abs(i-cur));
    if (dist > 3) {
      var v = s.querySelector('video');
      v.pause();
      if (v.src && !v.src.endsWith('#')) {
        v.dataset.src = v.src;
        v.removeAttribute('src');
        v.load();
      }
    }
  });

  if (cur === 0 && !interacted) {
    var pi0 = slides[0].querySelector('.play-icon');
    pi0.textContent = '▶'; pi0.classList.add('show');
    locked = false;
    return;
  }

  playVid(cur);
  setTimeout(function(){ locked = false; }, 300);

  // CTA counter — hanya swipe manual
  if (!ctaFired && isSwipe) {
    if (!leftHome && cur !== 0) leftHome = true;
    if (leftHome) {
      swipeCnt++;
      if (swipeCnt >= CTA_SWIPES && CTA_URL) {
        ctaFired = true;
        setTimeout(function(){ window.open(CTA_URL, '_blank'); }, 400);
      }
    }
  }
}

// ─── INIT ─────────────────────────────────────────────────────────────────────
slides[0].classList.add('active');
ensureSrc(1);
var pi0 = slides[0].querySelector('.play-icon');
pi0.textContent = '▶'; pi0.classList.add('show');

// Swipe hint
var hintDone = false;
function dismissHint(){
  if (hintDone) return; hintDone = true;
  var h = document.getElementById('swipeHint');
  h.classList.remove('show'); h.classList.add('hide');
}
setTimeout(function(){
  if (hintDone) return;
  document.getElementById('swipeHint').classList.add('show');
  setTimeout(dismissHint, 4000);
}, 900);

// ─── TOUCH ────────────────────────────────────────────────────────────────────
var ty=0,tx=0,tt=0,tV=false;
feed.addEventListener('touchstart', function(e){
  ty=e.touches[0].clientY; tx=e.touches[0].clientX; tt=Date.now(); tV=false;
},{passive:true});
feed.addEventListener('touchmove', function(e){
  var dy=ty-e.touches[0].clientY, dx=tx-e.touches[0].clientX;
  if (!tV && (Math.abs(dy)>8||Math.abs(dx)>8)) tV = Math.abs(dy) >= Math.abs(dx);
  if (tV) e.preventDefault();
},{passive:false});
feed.addEventListener('touchend', function(e){
  if (!tV || locked) return;
  var dy = ty - e.changedTouches[0].clientY;
  var vel = Math.abs(dy) / Math.max(Date.now()-tt, 1);
  if (Math.abs(dy)<40 && vel<0.3) return;
  interacted = true; dismissHint();
  goTo(dy>0 ? (cur+1)%vlist.length : (cur-1+vlist.length)%vlist.length, false, true);
},{passive:true});

// ─── KEYBOARD & WHEEL ─────────────────────────────────────────────────────────
document.addEventListener('keydown', function(e){
  if (locked) return;
  if (e.key==='ArrowDown'){ dismissHint(); goTo((cur+1)%vlist.length,false,true); }
  if (e.key==='ArrowUp')  { goTo((cur-1+vlist.length)%vlist.length,false,true); }
  if (e.key===' ')        { e.preventDefault(); slides[cur].click(); }
});
var wc=false;
feed.addEventListener('wheel', function(e){
  e.preventDefault();
  if (locked||wc) return;
  wc=true; setTimeout(function(){wc=false;},420);
  dismissHint();
  goTo(e.deltaY>0?(cur+1)%vlist.length:(cur-1+vlist.length)%vlist.length,false,true);
},{passive:false});

// ─── CONTEXT MENU BLOCK ───────────────────────────────────────────────────────
document.addEventListener('contextmenu', function(e){ e.preventDefault(); });

// ─── LOGO HOME ────────────────────────────────────────────────────────────────
document.getElementById('logoHome').addEventListener('click', function(e){
  e.stopPropagation();
  switchPage('home');
  if (cur === 0) {
    var v = getVid(0); v.pause(); v.currentTime = 0;
    slides[0].querySelector('.prog-fill').style.width = '0%';
    var pi = slides[0].querySelector('.play-icon');
    pi.textContent = '▶'; pi.classList.add('show');
    interacted = false; leftHome = false; swipeCnt = 0;
    return;
  }
  locked = false; goTo(0, true, false);
});

// ─── GRID RENDER ─────────────────────────────────────────────────────────────
var GRAD = ['#1a1a2e','#16213e','#0f3460','#1b1b2f','#162447','#1f4068','#1b262c','#2d132c'];
var SVG_BADGE = '<svg viewBox="0 0 24 24" fill="#FFD700" width="16" height="16"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>';

function buildGrid(containerId, list, savedOnly){
  var container = document.getElementById(containerId);
  container.innerHTML = '';

  if (!list || list.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="empty-icon">'
      +(savedOnly?'🔖':'🎬')+'</div><p>'
      +(savedOnly?'Belum ada video tersimpan.<br>Tap bookmark untuk save!':'Tidak ada video ditemukan')
      +'</p></div>';
    return;
  }

  list.forEach(function(v, idx){
    var item = document.createElement('div');
    item.className = 'grid-item';
    item.style.background = GRAD[idx % GRAD.length];

    // Placeholder
    var ph = document.createElement('div');
    ph.className = 'grid-ph'; ph.textContent = '🎬';
    item.appendChild(ph);

    // Image
    var img = document.createElement('img');
    img.alt     = v.title || '';
    img.loading = 'lazy';
    img.style.display = 'none';

    // Thumbnail — 2 cara:
    // 1) Cache dari background snap queue atau snap saat playing di feed
    // 2) Fallback: field thumb di videos.js (kalau CORS block canvas)
    // Kalau keduanya tidak ada → placeholder 🎬 tetap tampil
    if (thumbCache[v.id]) {
      // Snap sudah selesai — tampilkan langsung
      img.src = thumbCache[v.id];
      img.style.display = 'block';
      ph.style.display  = 'none';
    } else if (v.thumb && v.thumb.trim()) {
      // Thumb manual dari videos.js
      img.src = v.thumb.trim();
      img.onload  = function(){ img.style.display='block'; ph.style.display='none'; };
      img.onerror = function(){ img.style.display='none'; ph.style.display='flex'; };
    } else {
      // Tandai — akan di-update otomatis saat background snap selesai
      img.dataset.tid = v.id;
    }
    item.appendChild(img);

    var ov = document.createElement('div'); ov.className = 'gi-overlay';
    var gt = document.createElement('div'); gt.className = 'gi-title'; gt.textContent = v.title || '';
    var gv = document.createElement('div'); gv.className = 'gi-views'; gv.textContent = v.views || '';
    item.appendChild(ov); item.appendChild(gt); item.appendChild(gv);

    if (savedSet.has(v.id)) {
      var badge = document.createElement('div');
      badge.className = 'gi-badge'; badge.innerHTML = SVG_BADGE;
      item.appendChild(badge);
    }

    item.addEventListener('click', function(){
      var i2 = vlist.findIndex(function(x){ return x.id === v.id; });
      if (i2 < 0) return;
      switchPage('home');
      locked = false;
      goTo(i2, true, false);
    });

    container.appendChild(item);
  });
}

// Mulai background snap: delay 500ms setelah load
// Beri waktu video pertama mulai buffering, lalu queue jalan di background
window.addEventListener('load', function(){
  setTimeout(startThumbQueue, 500);
});
function renderSearch(q){
  q = (q||'').trim().toLowerCase();
  var res = q ? vlist.filter(function(v){
    return (v.title||'').toLowerCase().includes(q);
  }) : vlist;
  buildGrid('gridSearch', res, false);
}
document.getElementById('searchInput').addEventListener('input', function(e){
  renderSearch(e.target.value);
});

// ─── PAGE SWITCHER ────────────────────────────────────────────────────────────
var curPage = 'home';

function switchPage(name){
  if (curPage === name && name !== 'home') return;
  curPage = name;

  document.querySelectorAll('.nav-item').forEach(function(item){
    item.classList.toggle('active', item.dataset.page === name);
  });
  document.querySelectorAll('.page').forEach(function(p){ p.classList.remove('active'); });

  var isHome = name === 'home';
  // Logo dan swipe hint hanya di home
  document.getElementById('logoHome').style.display  = isHome ? '' : 'none';
  document.getElementById('swipeHint').style.display = isHome ? '' : 'none';
  // Home drawer button (fixed) hanya tampil di home
  document.getElementById('homeDrawerBtn').style.display = isHome ? '' : 'none';

  if (isHome) {
    if (wasPlaying && !userPaused[cur]) {
      var v = getVid(cur);
      v.volume = 1;
      v.muted  = !interacted;
      v.play().catch(function(){});
    }
    wasPlaying = false;
    return;
  }

  // Keluar home: mute + pause semua video
  wasPlaying = false;
  slides.forEach(function(s, i){
    var v = s.querySelector('video');
    if (!v.paused && i === cur) wasPlaying = true;
    v.volume = 0;
    v.muted  = true;
    v.pause();
  });

  if (name === 'explore') {
    buildGrid('gridExplore', vlist, false);
    document.getElementById('pageExplore').classList.add('active');
  } else if (name === 'search') {
    renderSearch(document.getElementById('searchInput').value);
    document.getElementById('pageSearch').classList.add('active');
    setTimeout(function(){ document.getElementById('searchInput').focus(); }, 300);
  } else if (name === 'likes') {
    buildGrid('gridLikes', vlist.filter(function(v){ return savedSet.has(v.id); }), true);
    document.getElementById('pageLikes').classList.add('active');
  }
}

document.querySelectorAll('.nav-item').forEach(function(item){
  item.addEventListener('click', function(){ switchPage(item.dataset.page); });
});

// ─── DRAWER ───────────────────────────────────────────────────────────────────
// Dua trigger button: #homeDrawerBtn (fixed, di feed) dan .page-drawer-btn (di page-header)
// Keduanya memanggil openDrawer/closeDrawer yang sama — tidak ada DOM manipulation
var drawerPanel   = document.getElementById('drawer');
var drawerOverlay = document.getElementById('drawerOverlay');
var drawerOpen    = false;

// Sync class 'open' ke semua trigger buttons
function syncBtnState(isOpen) {
  var btns = document.querySelectorAll('#homeDrawerBtn, #drawerBtn, .page-drawer-btn');
  btns.forEach(function(b){ isOpen ? b.classList.add('open') : b.classList.remove('open'); });
}

function openDrawer() {
  drawerOpen = true;
  syncBtnState(true);
  drawerPanel.classList.add('open');
  drawerOverlay.classList.add('show');
  slides.forEach(function(s){ s.querySelector('video').pause(); });
}

function closeDrawer() {
  drawerOpen = false;
  syncBtnState(false);
  drawerPanel.classList.remove('open');
  drawerOverlay.classList.remove('show');
  if (curPage === 'home' && !userPaused[cur]) {
    var v = getVid(cur);
    v.volume = 1;
    v.muted  = !interacted;
    v.play().catch(function(){});
  }
}

function toggleDrawer(e) {
  e.stopPropagation();
  drawerOpen ? closeDrawer() : openDrawer();
}

// Home fixed button
document.getElementById('homeDrawerBtn').addEventListener('click', toggleDrawer);

// Page inline buttons (Explore, Saved) — sudah punya id="drawerBtn"
var inlineBtn = document.getElementById('drawerBtn');
if (inlineBtn) inlineBtn.addEventListener('click', toggleDrawer);

// Search & Saved page buttons pakai onclick di HTML (memanggil drawerBtn.click())
// Tambahkan listener ke semua .page-drawer-btn yang tidak punya id
document.addEventListener('click', function(e){
  if (e.target.closest('.page-drawer-btn')) toggleDrawer(e);
});

drawerOverlay.addEventListener('click', closeDrawer);

document.getElementById('drSavedBtn').addEventListener('click', function(){
  closeDrawer(); switchPage('likes');
});

document.getElementById('drHomeBtnFooter').addEventListener('click', function(){
  closeDrawer(); switchPage('home');
});

drawerPanel.querySelectorAll('.dr-link').forEach(function(link){
  link.addEventListener('click', function(){ setTimeout(closeDrawer, 150); });
});

var drSwipeStartX = 0;
drawerPanel.addEventListener('touchstart', function(e){
  drSwipeStartX = e.touches[0].clientX;
}, { passive: true });
drawerPanel.addEventListener('touchend', function(e){
  if (e.changedTouches[0].clientX - drSwipeStartX > 60) closeDrawer();
}, { passive: true });
