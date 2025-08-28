(function () {
  'use strict';

  // ====== 設定 ======
  const SPACE_CODE = 'timer_space';
  const MODE_FIELD = 'Timer_Mode';           // 'Stopwatch' or 'Countdown'
  const COUNTDOWN_SEC_FIELD = 'Countdown_Sec';
  const STATUS_FIELD = 'Timer_Status';       // 'ready' | 'running' | 'paused'
  const ELAPSED_MS_FIELD = 'Elapsed_ms';     // 累積ミリ秒
  const STARTED_AT_FIELD = 'Started_At';     // DateTime（running基準点）
  const LAP_LOG_FIELD = 'Lap_Log';

  // レコード別ローカルキー
  const lsKey = (recordId) => `kintone_timer_${kintone.app.getId()}_${recordId || 'create'}`;

  // ====== ユーティリティ ======
  const pad = (n, z = 2) => String(n).padStart(z, '0');
  const nowIso = () => new Date().toISOString();

  function formatMs(ms) {
    if (ms < 0) ms = 0;
    const totalMs = Math.floor(ms);
    const totalSec = Math.floor(totalMs / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const cs = Math.floor((totalMs % 1000) / 10); // 2桁
    return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(cs)}`;
  }

  function getSpaceElement(event, isMobile) {
    return isMobile
      ? kintone.mobile.app.record.getSpaceElement(SPACE_CODE)
      : kintone.app.record.getSpaceElement(SPACE_CODE);
  }

  async function updateRecord(recordId, patch) {
    const app = kintone.app.getId();
    return kintone.api(kintone.api.url('/k/v1/record', true), 'PUT', {
      app,
      id: recordId,
      record: patch
    });
  }

  function loadLocal(recordId) {
    try {
      const raw = localStorage.getItem(lsKey(recordId));
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  }
  function saveLocal(recordId, obj) {
    localStorage.setItem(lsKey(recordId), JSON.stringify(obj || {}));
  }

  // ====== ランタイム状態（レコードごと）を保持する簡易レジストリ ======
  const runtime = {
    // recordId(string) -> state
    map: new Map(),
    get(recordId) { return this.map.get(recordId); },
    set(recordId, state) { this.map.set(recordId, state); },
    ensure(recordId) {
      if (!this.map.has(recordId)) this.map.set(recordId, {});
      return this.map.get(recordId);
    }
  };

  // ====== UI 作成 ======
  function renderUI({ container, event, isMobile }) {
    const record = event.record;
    const recordId = record.$id ? record.$id.value : 'create';
    const state = runtime.ensure(recordId);

    // 初期化（UI参照や計測用パラメータ）
    Object.assign(state, {
      rafId: null,
      running: false,
      displayEl: null,
      modeSelEl: null,
      cdInputEl: null,
      startBtn: null,
      pauseBtn: null,
      stopBtn: null,      // ★ 追加
      resetBtn: null,
      lapBtn: null,
      lastPerfStart: 0,
      baseElapsedMs: 0
    });

    // スタイル
    const style = document.createElement('style');
    style.textContent = `
      .ktimer-wrap { display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
      .ktimer-time { font: 600 28px/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
      .ktimer-ctrls { display:flex; gap:8px; flex-wrap:wrap; }
      .ktimer-ctrls button { padding:8px 12px; border-radius:8px; border:1px solid #ccc; cursor:pointer; }
      .ktimer-ctrls button.primary { border-color:#4f46e5; background:#4f46e5; color:#fff; }
      .ktimer-ctrls button.warn { border-color:#ef4444; background:#ef4444; color:#fff; }
      .ktimer-ctrls button.stop { border-color:#111827; background:#111827; color:#fff; }
      .ktimer-field { display:flex; align-items:center; gap:6px; }
      .ktimer-sub { opacity:.7; font-size:12px; }
      .ktimer-row { display:flex; gap:16px; align-items:center; flex-wrap:wrap; }
      .ktimer-col { display:flex; gap:8px; align-items:center; }
      .ktimer-input { width:120px; padding:6px 8px; border:1px solid #ccc; border-radius:8px; }
      @media (max-width: 480px){
        .ktimer-time { font-size: 24px; }
        .ktimer-input { width: 100px; }
      }
    `;
    container.appendChild(style);

    const wrap = document.createElement('div');
    wrap.className = 'ktimer-wrap';

    const timeEl = document.createElement('div');
    timeEl.className = 'ktimer-time';
    timeEl.textContent = '00:00:00.00';
    state.displayEl = timeEl;

    // モード/カウントダウン
    const modeCol = document.createElement('div'); modeCol.className = 'ktimer-col';
    const modeLabel = document.createElement('span'); modeLabel.textContent = 'モード:';
    const modeSel = document.createElement('select'); modeSel.className = 'ktimer-input';
    ['Stopwatch', 'Countdown'].forEach(v => {
      const opt = document.createElement('option'); opt.value = opt.textContent = v;
      modeSel.appendChild(opt);
    });
    modeCol.appendChild(modeLabel); modeCol.appendChild(modeSel);
    state.modeSelEl = modeSel;

    const cdCol = document.createElement('div'); cdCol.className = 'ktimer-col';
    const cdLabel = document.createElement('span'); cdLabel.textContent = 'カウントダウン秒:';
    const cdInput = document.createElement('input'); cdInput.type = 'number'; cdInput.min = '0'; cdInput.step = '1';
    cdInput.placeholder = '例: 300 (5分)';
    cdInput.className = 'ktimer-input';
    cdCol.appendChild(cdLabel); cdCol.appendChild(cdInput);
    state.cdInputEl = cdInput;

    // コントロール（★ 停止ボタン追加）
    const ctrls = document.createElement('div'); ctrls.className = 'ktimer-ctrls';
    const startBtn = document.createElement('button'); startBtn.className = 'primary'; startBtn.textContent = '開始 / 再開';
    const pauseBtn = document.createElement('button'); pauseBtn.textContent = '一時停止';
    const stopBtn = document.createElement('button'); stopBtn.className = 'stop'; stopBtn.textContent = '停止';
    const resetBtn = document.createElement('button'); resetBtn.className = 'warn'; resetBtn.textContent = 'リセット';
    const lapBtn = document.createElement('button'); lapBtn.textContent = 'ラップ';
    [startBtn, pauseBtn, stopBtn, resetBtn, lapBtn].forEach(b => ctrls.appendChild(b));
    state.startBtn = startBtn; state.pauseBtn = pauseBtn; state.stopBtn = stopBtn; state.resetBtn = resetBtn; state.lapBtn = lapBtn;

    const subEl = document.createElement('div');
    subEl.className = 'ktimer-sub';
    subEl.textContent = '※ 停止＝計測終了＆保存。保存時も自動で終了→結果保存します。';

    const row1 = document.createElement('div'); row1.className = 'ktimer-row';
    row1.appendChild(timeEl); row1.appendChild(ctrls);
    const row2 = document.createElement('div'); row2.className = 'ktimer-row';
    row2.appendChild(modeCol); row2.appendChild(cdCol);
    wrap.appendChild(row1); wrap.appendChild(row2); wrap.appendChild(subEl);
    container.appendChild(wrap);

    // ====== 状態の読み込み ======
    const recMode = (record[MODE_FIELD] && record[MODE_FIELD].value) || 'Stopwatch';
    const recCountdown = Number((record[COUNTDOWN_SEC_FIELD] && record[COUNTDOWN_SEC_FIELD].value) || 0);
    const recStatus = (record[STATUS_FIELD] && record[STATUS_FIELD].value) || 'ready';
    const recElapsed = Number((record[ELAPSED_MS_FIELD] && record[ELAPSED_MS_FIELD].value) || 0);
    const recStartedAt = (record[STARTED_AT_FIELD] && record[STARTED_AT_FIELD].value) || null;

    const local = loadLocal(recordId);
    state.baseElapsedMs = !isNaN(local.baseElapsedMs) ? local.baseElapsedMs : recElapsed;

    modeSel.value = local.mode || recMode;
    cdInput.value = String(!isNaN(local.countdownSec) ? local.countdownSec : recCountdown || '');

    // runningなら自動復元
    if (recStatus === 'running' && recStartedAt) {
      const startedAt = new Date(recStartedAt).getTime();
      const serverElapsed = recElapsed + (Date.now() - startedAt);
      state.baseElapsedMs = serverElapsed;
      startTimer();
    } else {
      renderDisplay(state.baseElapsedMs);
    }

    // ====== イベントハンドラ ======
    modeSel.addEventListener('change', () => {
      saveLocal(recordId, { ...loadLocal(recordId), mode: modeSel.value });
    });
    cdInput.addEventListener('input', () => {
      const v = Math.max(0, Number(cdInput.value || 0));
      saveLocal(recordId, { ...loadLocal(recordId), countdownSec: v });
    });

    startBtn.addEventListener('click', async () => {
      if (state.running) return;
      startTimer();
      if (record.$id && record.$id.value) {
        await updateRecord(record.$id.value, {
          [STATUS_FIELD]: { value: 'running' },
          [STARTED_AT_FIELD]: { value: nowIso() }
        });
      } else {
        record[STATUS_FIELD].value = 'running';
        record[STARTED_AT_FIELD].value = nowIso();
      }
    });

    pauseBtn.addEventListener('click', async () => {
      if (!state.running) return;
      stopTimerAndFreeze();
      await saveElapsedToServer('paused');
    });

    // ★ 停止：完全終了して ready に戻す（最終値保存）
    stopBtn.addEventListener('click', async () => {
      finalizeStopAndSave(record);
    });

    resetBtn.addEventListener('click', async () => {
      stopTimerAndFreeze();
      state.baseElapsedMs = 0;
      renderDisplay(0);
      saveLocal(recordId, { ...loadLocal(recordId), baseElapsedMs: 0 });
      if (record.$id && record.$id.value) {
        await updateRecord(record.$id.value, {
          [STATUS_FIELD]: { value: 'ready' },
          [ELAPSED_MS_FIELD]: { value: '0' },
          [STARTED_AT_FIELD]: { value: '' }
        });
      } else {
        record[STATUS_FIELD].value = 'ready';
        record[ELAPSED_MS_FIELD].value = '0';
        record[STARTED_AT_FIELD].value = '';
      }
    });

    lapBtn.addEventListener('click', async () => {
      const ms = currentElapsed();
      const line = `[${new Date().toLocaleString()}] ${formatMs(ms)}\n`;
      const prev = (record[LAP_LOG_FIELD] && record[LAP_LOG_FIELD].value) || '';
      const next = prev + line;

      if (record.$id && record.$id.value) {
        await updateRecord(record.$id.value, {
          [LAP_LOG_FIELD]: { value: next },
          [ELAPSED_MS_FIELD]: { value: String(Math.floor(ms)) }
        });
      } else {
        record[LAP_LOG_FIELD].value = next;
        record[ELAPSED_MS_FIELD].value = String(Math.floor(ms));
      }
    });

    // ====== タイマーロジック ======
    function currentElapsed() {
      if (!state.running) return state.baseElapsedMs;
      const delta = performance.now() - state.lastPerfStart;
      return state.baseElapsedMs + delta;
    }

    function renderDisplay(elapsedMs) {
      const mode = state.modeSelEl.value;
      if (mode === 'Countdown') {
        const totalMs = Math.max(0, Number(state.cdInputEl.value || 0) * 1000);
        const remain = totalMs - elapsedMs;
        state.displayEl.textContent = formatMs(remain);
      } else {
        state.displayEl.textContent = formatMs(elapsedMs);
      }
    }

    function tick() {
      renderDisplay(currentElapsed());
      // カウントダウン終了検知
      if (state.modeSelEl.value === 'Countdown') {
        const totalMs = Math.max(0, Number(state.cdInputEl.value || 0) * 1000);
        if (currentElapsed() >= totalMs && state.running) {
          stopTimerAndFreeze();
          alert('カウントダウンが終了しました。');
          saveElapsedToServer('paused');
          return;
        }
      }
      state.rafId = requestAnimationFrame(tick);
    }

    function startTimer() {
      state.running = true;
      state.lastPerfStart = performance.now();
      cancelAnimationFrame(state.rafId);
      state.rafId = requestAnimationFrame(tick);
    }

    function stopTimerAndFreeze() {
      if (!state.running) return;
      state.running = false;
      cancelAnimationFrame(state.rafId);
      state.baseElapsedMs = currentElapsed();
      saveLocal(recordId, { ...loadLocal(recordId), baseElapsedMs: state.baseElapsedMs });
      renderDisplay(state.baseElapsedMs);
    }

    async function saveElapsedToServer(nextStatus) {
      const ms = Math.floor(state.baseElapsedMs);
      if (record.$id && record.$id.value) {
        await updateRecord(record.$id.value, {
          [STATUS_FIELD]: { value: nextStatus },
          [ELAPSED_MS_FIELD]: { value: String(ms) },
          [STARTED_AT_FIELD]: { value: '' }
        });
      } else {
        record[STATUS_FIELD].value = nextStatus;
        record[ELAPSED_MS_FIELD].value = String(ms);
        record[STARTED_AT_FIELD].value = '';
      }
    }

    // ★ 完全停止して保存する関数（停止ボタン／保存時に利用）
    async function finalizeStopAndSave(rec) {
      // 走行中なら止めて最終値を確定
      if (state.running) stopTimerAndFreeze();

      // カウントダウンの場合、負の時間は0に丸める
      if (state.modeSelEl.value === 'Countdown') {
        const totalMs = Math.max(0, Number(state.cdInputEl.value || 0) * 1000);
        state.baseElapsedMs = Math.min(state.baseElapsedMs, totalMs);
        renderDisplay(state.baseElapsedMs);
      }

      const ms = Math.floor(state.baseElapsedMs);

      // 既存レコードならPUT、作成/編集画面ならevent.recordへ反映
      if (rec.$id && rec.$id.value) {
        await updateRecord(rec.$id.value, {
          [STATUS_FIELD]: { value: 'ready' },
          [ELAPSED_MS_FIELD]: { value: String(ms) },
          [STARTED_AT_FIELD]: { value: '' }
        });
      } else {
        rec[STATUS_FIELD].value = 'ready';
        rec[ELAPSED_MS_FIELD].value = String(ms);
        rec[STARTED_AT_FIELD].value = '';
      }

      // 完全停止後はローカルも0クリア（次回はゼロから）
      saveLocal(recordId, { ...loadLocal(recordId), baseElapsedMs: 0 });
    }

    // visibilitychange（表示補正）
    document.addEventListener('visibilitychange', () => {
      if (!state.running) return;
      renderDisplay(currentElapsed());
    });

    // state内で関数を共有（保存時フックから呼ぶため）
    state.api = { finalizeStopAndSave, currentElapsed };
  }

  // ====== 画面フック（描画） ======
  const desktopShow = ['app.record.create.show', 'app.record.edit.show', 'app.record.detail.show'];
  const mobileShow  = ['mobile.app.record.create.show', 'mobile.app.record.edit.show', 'mobile.app.record.detail.show'];

  kintone.events.on(desktopShow, function (event) {
    const el = getSpaceElement(event, false);
    if (!el) return event;
    el.innerHTML = '';
    renderUI({ container: el, event, isMobile: false });
    return event;
  });

  kintone.events.on(mobileShow, function (event) {
    const el = getSpaceElement(event, true);
    if (!el) return event;
    el.innerHTML = '';
    renderUI({ container: el, event, isMobile: true });
    return event;
  });

  // ====== 保存時の自動終了（作成/編集 送信時） ======
  const desktopSubmit = ['app.record.create.submit', 'app.record.edit.submit'];
  const mobileSubmit  = ['mobile.app.record.create.submit', 'mobile.app.record.edit.submit'];

  function submitHandler(event) {
    try {
      const rec = event.record;
      const recordId = rec.$id ? rec.$id.value : 'create';
      const state = runtime.get(recordId);
      // UIが未描画（スペース未配置）でも、安全に動くように最低限の処理
      if (state && state.api && typeof state.api.finalizeStopAndSave === 'function') {
        // 送信直前に完全停止して record に最終値を反映
        state.api.finalizeStopAndSave(rec);
      } else {
        // UI未描画時：Started_Atが入っていたら経過を概算する（保険）
        const status = (rec[STATUS_FIELD] && rec[STATUS_FIELD].value) || 'ready';
        const started = (rec[STARTED_AT_FIELD] && rec[STARTED_AT_FIELD].value) || '';
        let elapsed = Number((rec[ELAPSED_MS_FIELD] && rec[ELAPSED_MS_FIELD].value) || 0);
        if (status === 'running' && started) {
          const delta = Date.now() - new Date(started).getTime();
          if (isFinite(delta) && delta > 0) elapsed += delta;
        }
        // 送信直前にreadyへ
        rec[STATUS_FIELD].value = 'ready';
        rec[ELAPSED_MS_FIELD].value = String(Math.max(0, Math.floor(elapsed)));
        rec[STARTED_AT_FIELD].value = '';
      }
    } catch (e) {
      // 何かあっても保存ブロックはしない（値は可能な範囲で反映）
      console.warn('[timer] submit finalize error:', e);
    }
    return event;
  }

  kintone.events.on(desktopSubmit, submitHandler);
  kintone.events.on(mobileSubmit, submitHandler);

})();(function () {
  'use strict';

  // ====== フィールドコード ======
  const SPACE_CODE = 'timer_space';
  const MODE_FIELD = 'Timer_Mode';           // 'Stopwatch' | 'Countdown'
  const COUNTDOWN_SEC_FIELD = 'Countdown_Sec';
  const STATUS_FIELD = 'Timer_Status';       // 'ready' | 'running' | 'paused'
  const ELAPSED_MS_FIELD = 'Elapsed_ms';
  const STARTED_AT_FIELD = 'Started_At';
  const LAP_LOG_FIELD = 'Lap_Log';

  const lsKey = (rid) => `kintone_timer_${kintone.app.getId()}_${rid || 'create'}`;

  // ====== utils ======
  const pad = (n, z=2)=>String(n).padStart(z,'0');
  const nowIso = ()=>new Date().toISOString();

  function formatMs(ms){
    if(ms<0) ms=0;
    const t=Math.floor(ms), s=Math.floor(t/1000);
    const h=Math.floor(s/3600), m=Math.floor((s%3600)/60), ss=s%60, cs=Math.floor((t%1000)/10);
    return `${pad(h)}:${pad(m)}:${pad(ss)}.${pad(cs)}`;
  }
  function loadLocal(rid){
    try{ const raw=localStorage.getItem(lsKey(rid)); return raw?JSON.parse(raw):{}; }catch(e){ return {}; }
  }
  function saveLocal(rid,obj){ localStorage.setItem(lsKey(rid), JSON.stringify(obj||{})); }

  async function updateRecord(recordId, patch){
    const app=kintone.app.getId();
    return kintone.api(kintone.api.url('/k/v1/record', true), 'PUT', { app, id: recordId, record: patch });
  }

  // ランタイム（レコードごと）
  const runtime = new Map(); // rid -> state

  // ====== UI描画 ======
  function renderUI({container, event, isMobile}){
    const record = event.record;
    const rid = record.$id ? record.$id.value : 'create';

    const state = runtime.get(rid) || {};
    runtime.set(rid, state);

    Object.assign(state, {
      running: false,
      rafId: null,
      lastPerfStart: 0,
      baseElapsedMs: state.baseElapsedMs || 0, // 既存維持
      displayEl: null, modeSelEl: null, cdInputEl: null,
      startBtn: null, pauseBtn: null, stopBtn: null, resetBtn: null, lapBtn: null
    });

    // スタイル最小
    const style = document.createElement('style');
    style.textContent = `
      .ktimer-wrap{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
      .ktimer-time{font:600 28px/1.2 ui-monospace,Menlo,Consolas,monospace}
      .ktimer-ctrls{display:flex;gap:8px;flex-wrap:wrap}
      .ktimer-ctrls button{padding:8px 12px;border-radius:8px;border:1px solid #ccc;cursor:pointer}
      .primary{background:#4f46e5;border-color:#4f46e5;color:#fff}
      .warn{background:#ef4444;border-color:#ef4444;color:#fff}
      .stop{background:#111827;border-color:#111827;color:#fff}
      .ktimer-col{display:flex;gap:8px;align-items:center}
      .ktimer-input{width:120px;padding:6px 8px;border:1px solid #ccc;border-radius:8px}
      .ktimer-sub{opacity:.7;font-size:12px}
      @media (max-width:480px){.ktimer-time{font-size:24px}.ktimer-input{width:100px}}
    `;
    container.appendChild(style);

    const wrap = document.createElement('div'); wrap.className='ktimer-wrap';
    const timeEl = document.createElement('div'); timeEl.className='ktimer-time'; timeEl.textContent='00:00:00.00'; state.displayEl=timeEl;

    // モード
    const modeCol = document.createElement('div'); modeCol.className='ktimer-col';
    const modeLbl = document.createElement('span'); modeLbl.textContent='モード:';
    const modeSel = document.createElement('select'); modeSel.className='ktimer-input';
    ['Stopwatch','Countdown'].forEach(v=>{ const o=document.createElement('option'); o.value=o.textContent=v; modeSel.appendChild(o); });
    modeCol.append(modeLbl, modeSel); state.modeSelEl=modeSel;

    // CD秒
    const cdCol = document.createElement('div'); cdCol.className='ktimer-col';
    const cdLbl = document.createElement('span'); cdLbl.textContent='カウントダウン秒:';
    const cdInput=document.createElement('input'); cdInput.type='number'; cdInput.min='0'; cdInput.step='1'; cdInput.placeholder='例:300'; cdInput.className='ktimer-input';
    cdCol.append(cdLbl, cdInput); state.cdInputEl=cdInput;

    // ボタン
    const ctrls = document.createElement('div'); ctrls.className='ktimer-ctrls';
    const bStart=document.createElement('button'); bStart.className='primary'; bStart.textContent='開始 / 再開';
    const bPause=document.createElement('button'); bPause.textContent='一時停止';
    const bStop=document.createElement('button'); bStop.className='stop'; bStop.textContent='停止';
    const bReset=document.createElement('button'); bReset.className='warn'; bReset.textContent='リセット';
    const bLap=document.createElement('button'); bLap.textContent='ラップ';
    ctrls.append(bStart,bPause,bStop,bReset,bLap);
    Object.assign(state,{startBtn:bStart,pauseBtn:bPause,stopBtn:bStop,resetBtn:bReset,lapBtn:bLap});

    const sub=document.createElement('div'); sub.className='ktimer-sub';
    sub.textContent='一時停止＝保持、停止＝確定保存。保存時は自動停止→結果保存。';

    const row1=document.createElement('div'); row1.style.display='flex'; row1.style.gap='16px'; row1.style.alignItems='center'; row1.style.flexWrap='wrap';
    row1.append(timeEl, ctrls);
    const row2=document.createElement('div'); row2.style.display='flex'; row2.style.gap='16px'; row2.style.alignItems='center'; row2.style.flexWrap='wrap';
    row2.append(modeCol, cdCol);
    wrap.append(row1,row2,sub);
    container.appendChild(wrap);

    // 初期値（record / local）
    const recMode = (record[MODE_FIELD] && record[MODE_FIELD].value) || 'Stopwatch';
    const recCD   = Number((record[COUNTDOWN_SEC_FIELD] && record[COUNTDOWN_SEC_FIELD].value) || 0);
    const recStat = (record[STATUS_FIELD] && record[STATUS_FIELD].value) || 'ready';
    const recEl   = Number((record[ELAPSED_MS_FIELD] && record[ELAPSED_MS_FIELD].value) || 0);
    const recStart= (record[STARTED_AT_FIELD] && record[STARTED_AT_FIELD].value) || null;

    const local = loadLocal(rid);
    state.baseElapsedMs = Number.isFinite(local.baseElapsedMs) ? local.baseElapsedMs : recEl;
    modeSel.value = local.mode || recMode;
    cdInput.value = String(Number.isFinite(local.countdownSec) ? local.countdownSec : (recCD || ''));

    if (recStat === 'running' && recStart){
      const startedAt = new Date(recStart).getTime();
      state.baseElapsedMs = recEl + Math.max(0, Date.now()-startedAt);
      startTimer(state);
    } else {
      renderDisplay(state);
    }

    // ハンドラ
    modeSel.addEventListener('change', ()=> saveLocal(rid, {...loadLocal(rid), mode: modeSel.value}));
    cdInput.addEventListener('input', ()=>{
      const v = Math.max(0, Number(cdInput.value||0));
      saveLocal(rid, {...loadLocal(rid), countdownSec: v});
    });

    bStart.addEventListener('click', async ()=>{
      if (state.running) return;
      startTimer(state);
      if (record.$id && record.$id.value){
        await updateRecord(record.$id.value, {
          [STATUS_FIELD]: { value: 'running' },
          [STARTED_AT_FIELD]: { value: nowIso() }
        });
      } else {
        record[STATUS_FIELD].value = 'running';
        record[STARTED_AT_FIELD].value = nowIso();
      }
    });

    // ★ 一時停止：必ず保持＋フィールドへも反映
    bPause.addEventListener('click', async ()=>{
      if (!state.running) return;
      freezeNow(state, rid);                   // baseElapsedMs を確定＆保存
      writeElapsedToRecord(record, state);     // event側へ即反映（create/editでも消えない）
      if (record.$id && record.$id.value){
        await updateRecord(record.$id.value, {  // 既存レコードはPUTで確実に保存
          [STATUS_FIELD]:   { value: 'paused' },
          [ELAPSED_MS_FIELD]: { value: String(Math.floor(state.baseElapsedMs)) },
          [STARTED_AT_FIELD]: { value: '' }
        });
      } else {
        record[STATUS_FIELD].value = 'paused';
        record[STARTED_AT_FIELD].value = '';
      }
    });

    // ★ 停止：必ず保存（detailはPUT、create/editはevent.recordへ）
    bStop.addEventListener('click', async ()=>{
      finalizeStop(state, rid, modeSel, cdInput);      // 値確定（CDは0で下駄）
      writeElapsedToRecord(record, state);             // event側へ反映
      if (record.$id && record.$id.value){
        await updateRecord(record.$id.value, {
          [STATUS_FIELD]:     { value: 'ready' },
          [ELAPSED_MS_FIELD]: { value: String(Math.floor(state.baseElapsedMs)) },
          [STARTED_AT_FIELD]: { value: '' }
        });
      } else {
        record[STATUS_FIELD].value = 'ready';
        record[STARTED_AT_FIELD].value = '';
      }
      // 次回はゼロから
      saveLocal(rid, {...loadLocal(rid), baseElapsedMs: 0});
    });

    bReset.addEventListener('click', async ()=>{
      cancelTimer(state);
      state.baseElapsedMs = 0;
      saveLocal(rid, {...loadLocal(rid), baseElapsedMs: 0});
      renderDisplay(state);
      if (record.$id && record.$id.value){
        await updateRecord(record.$id.value, {
          [STATUS_FIELD]:     { value: 'ready' },
          [ELAPSED_MS_FIELD]: { value: '0' },
          [STARTED_AT_FIELD]: { value: '' }
        });
      } else {
        record[STATUS_FIELD].value = 'ready';
        record[ELAPSED_MS_FIELD].value = '0';
        record[STARTED_AT_FIELD].value = '';
      }
    });

    bLap.addEventListener('click', async ()=>{
      const ms = currentElapsed(state);
      const line = `[${new Date().toLocaleString()}] ${formatMs(ms)}\n`;
      const prev = (record[LAP_LOG_FIELD] && record[LAP_LOG_FIELD].value) || '';
      const next = prev + line;
      writeElapsedToRecord(record, {baseElapsedMs: ms}); // event側にも反映
      if (record.$id && record.$id.value){
        await updateRecord(record.$id.value, {
          [LAP_LOG_FIELD]: { value: next },
          [ELAPSED_MS_FIELD]: { value: String(Math.floor(ms)) }
        });
      } else {
        record[LAP_LOG_FIELD].value = next;
      }
    });

    document.addEventListener('visibilitychange', ()=>{
      if (!state.running) return;
      renderDisplay(state);
    });
  }

  // ====== タイマーロジック ======
  function currentElapsed(state){
    if (!state.running) return state.baseElapsedMs;
    return state.baseElapsedMs + (performance.now() - state.lastPerfStart);
  }
  function renderDisplay(state){
    const modeSel = state.modeSelEl, cdInput = state.cdInputEl;
    const elapsed = currentElapsed(state);
    if (modeSel && modeSel.value === 'Countdown'){
      const totalMs = Math.max(0, Number(cdInput.value||0)*1000);
      state.displayEl.textContent = formatMs(totalMs - elapsed);
    } else {
      state.displayEl.textContent = formatMs(elapsed);
    }
  }
  function tick(state){
    renderDisplay(state);
    if (state.modeSelEl && state.modeSelEl.value==='Countdown'){
      const totalMs = Math.max(0, Number(state.cdInputEl.value||0)*1000);
      if (currentElapsed(state) >= totalMs && state.running){
        freezeNow(state); // 終了
        alert('カウントダウンが終了しました。');
        // 一時停止扱いで保持（必要ならここで即保存PUTしても良い）
        return;
      }
    }
    state.rafId = requestAnimationFrame(()=>tick(state));
  }
  function startTimer(state){
    state.running = true;
    state.lastPerfStart = performance.now();
    cancelAnimationFrame(state.rafId);
    state.rafId = requestAnimationFrame(()=>tick(state));
  }
  function cancelTimer(state){
    state.running = false;
    cancelAnimationFrame(state.rafId);
  }
  // 今の値で停止し baseElapsedMs を確定・保存
  function freezeNow(state, rid){
    if (state.running){
      state.baseElapsedMs = currentElapsed(state);
      cancelTimer(state);
    }
    if (rid) saveLocal(rid, {...loadLocal(rid), baseElapsedMs: state.baseElapsedMs});
    renderDisplay(state);
  }
  // 停止確定（CDは下回らないよう0～totalにクランプ）
  function finalizeStop(state, rid, modeSel, cdInput){
    freezeNow(state, rid);
    if (modeSel && modeSel.value==='Countdown'){
      const totalMs = Math.max(0, Number(cdInput.value||0)*1000);
      state.baseElapsedMs = Math.min(state.baseElapsedMs, totalMs);
    }
    renderDisplay(state);
  }
  // event.record へ「数値(ms)」を**同期的に**反映（submitで消えない）
  function writeElapsedToRecord(record, state){
    const ms = Math.max(0, Math.floor(state.baseElapsedMs));
    record[ELAPSED_MS_FIELD].value = String(ms); // 数値フィールドは文字列でOK
  }

  // ====== 画面フック ======
  const showDesktop = ['app.record.create.show','app.record.edit.show','app.record.detail.show'];
  const showMobile  = ['mobile.app.record.create.show','mobile.app.record.edit.show','mobile.app.record.detail.show'];

  function getSpaceElement(event, isMobile){
    return isMobile ? kintone.mobile.app.record.getSpaceElement(SPACE_CODE)
                    : kintone.app.record.getSpaceElement(SPACE_CODE);
  }

  kintone.events.on(showDesktop, function(event){
    const el = getSpaceElement(event,false); if(!el) return event;
    el.innerHTML=''; renderUI({container:el, event, isMobile:false}); return event;
  });
  kintone.events.on(showMobile, function(event){
    const el = getSpaceElement(event,true); if(!el) return event;
    el.innerHTML=''; renderUI({container:el, event, isMobile:true}); return event;
  });

  // ====== ★ 作成/編集の送信時：同期で確定してから送信 ======
  const submitDesktop = ['app.record.create.submit','app.record.edit.submit'];
  const submitMobile  = ['mobile.app.record.create.submit','mobile.app.record.edit.submit'];

  function submitHandler(event){
    const rec = event.record;
    const rid = rec.$id ? rec.$id.value : 'create';
    const state = runtime.get(rid);

    // UI未描画でも安全に確定する
    if (state){
      finalizeStop(state, rid, state.modeSelEl, state.cdInputEl); // ここでrunningなら止める
      writeElapsedToRecord(rec, state);                           // msをevent.recordへ
    } else {
      // 最低限の保険：running+Started_Atから概算
      const status = (rec[STATUS_FIELD] && rec[STATUS_FIELD].value)||'ready';
      const started = (rec[STARTED_AT_FIELD] && rec[STARTED_AT_FIELD].value)||'';
      let elapsed = Number((rec[ELAPSED_MS_FIELD] && rec[ELAPSED_MS_FIELD].value) || 0);
      if (status==='running' && started){
        const delta = Date.now() - new Date(started).getTime();
        if (isFinite(delta) && delta>0) elapsed += delta;
      }
      rec[ELAPSED_MS_FIELD].value = String(Math.max(0, Math.floor(elapsed)));
    }
    // 送信後は ready / Started_At クリア
    rec[STATUS_FIELD].value = 'ready';
    rec[STARTED_AT_FIELD].value = '';
    return event; // 同期で返す（await/PUTはしない）
  }

  kintone.events.on(submitDesktop, submitHandler);
  kintone.events.on(submitMobile,  submitHandler);

})();

