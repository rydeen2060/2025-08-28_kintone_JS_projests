(function () {
  'use strict';

  // ====== 設定 ======
  const SPACE_CODE = 'timer_space';
  const MODE_FIELD = 'Timer_Mode';           // 'Stopwatch' or 'Countdown'
  const COUNTDOWN_SEC_FIELD = 'Countdown_Sec';
  const STATUS_FIELD = 'Timer_Status';       // 'ready' | 'running' | 'paused'
  const ELAPSED_MS_FIELD = 'Elapsed_ms';     // 累積ミリ秒（停止中も保持）
  const STARTED_AT_FIELD = 'Started_At';     // DateTime（runningの基準点）
  const LAP_LOG_FIELD = 'Lap_Log';

  // ローカルストレージキー（レコード別）
  const lsKey = (recordId) => `kintone_timer_${kintone.app.getId()}_${recordId || 'create'}`;

  // ====== ユーティリティ ======
  const pad = (n, z = 2) => String(n).padStart(z, '0');

  function formatMs(ms) {
    if (ms < 0) ms = 0;
    const totalMs = Math.floor(ms);
    const totalSec = Math.floor(totalMs / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const cs = Math.floor((totalMs % 1000) / 10); // センチ秒(2桁)表示
    return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(cs)}`;
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function getSpaceElement(event, isMobile) {
    return isMobile
      ? kintone.mobile.app.record.getSpaceElement(SPACE_CODE)
      : kintone.app.record.getSpaceElement(SPACE_CODE);
  }

  // レコード更新（停止・ラップ時などに即時保存したいとき）
  async function updateRecord(recordId, patch) {
    const app = kintone.app.getId();
    return kintone.api(kintone.api.url('/k/v1/record', true), 'PUT', {
      app,
      id: recordId,
      record: patch
    });
  }

  // ローカルステート（描画・高頻度更新用）
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

  // ====== UI 作成 ======
  function renderUI({ container, event, isMobile }) {
    const record = event.record;
    const recordId = record.$id ? record.$id.value : 'create';
    const state = {
      rafId: null,
      running: false,
      displayEl: null,
      modeSelEl: null,
      cdInputEl: null,
      startBtn: null,
      pauseBtn: null,
      resetBtn: null,
      lapBtn: null,
      lastPerfStart: 0, // performance.now() の開始点
      baseElapsedMs: 0  // 停止中に保持している累積
    };

    // スタイル（控えめ）
    const style = document.createElement('style');
    style.textContent = `
      .ktimer-wrap { display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
      .ktimer-time { font: 600 28px/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
      .ktimer-ctrls button { padding:8px 12px; border-radius:8px; border:1px solid #ccc; cursor:pointer; }
      .ktimer-ctrls button.primary { border-color:#4f46e5; background:#4f46e5; color:#fff; }
      .ktimer-ctrls button.warn { border-color:#ef4444; background:#ef4444; color:#fff; }
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

    // モード/カウントダウン秒
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
    const cdInput = document.createElement('input'); cdInput.type = 'number'; cdInput.min = '0';
    cdInput.step = '1'; cdInput.placeholder = '例: 300 (5分)';
    cdInput.className = 'ktimer-input';
    cdCol.appendChild(cdLabel); cdCol.appendChild(cdInput);
    state.cdInputEl = cdInput;

    const ctrls = document.createElement('div'); ctrls.className = 'ktimer-ctrls';
    const startBtn = document.createElement('button'); startBtn.className = 'primary'; startBtn.textContent = '開始 / 再開';
    const pauseBtn = document.createElement('button'); pauseBtn.textContent = '一時停止';
    const resetBtn = document.createElement('button'); resetBtn.className = 'warn'; resetBtn.textContent = 'リセット';
    const lapBtn = document.createElement('button'); lapBtn.textContent = 'ラップ';
    ctrls.appendChild(startBtn); ctrls.appendChild(pauseBtn); ctrls.appendChild(resetBtn); ctrls.appendChild(lapBtn);
    state.startBtn = startBtn; state.pauseBtn = pauseBtn; state.resetBtn = resetBtn; state.lapBtn = lapBtn;

    const subEl = document.createElement('div');
    subEl.className = 'ktimer-sub';
    subEl.textContent = '※ 画面リロード・タブ移動に強い再計算式。保存は停止/ラップ時に自動反映。';

    const row1 = document.createElement('div'); row1.className = 'ktimer-row';
    row1.appendChild(timeEl); row1.appendChild(ctrls);
    const row2 = document.createElement('div'); row2.className = 'ktimer-row';
    row2.appendChild(modeCol); row2.appendChild(cdCol);

    wrap.appendChild(row1);
    wrap.appendChild(row2);
    wrap.appendChild(subEl);
    container.appendChild(wrap);

    // ====== 状態の読み込み（レコード＋ローカル） ======
    const recMode = (record[MODE_FIELD] && record[MODE_FIELD].value) || 'Stopwatch';
    const recCountdown = Number((record[COUNTDOWN_SEC_FIELD] && record[COUNTDOWN_SEC_FIELD].value) || 0);
    const recStatus = (record[STATUS_FIELD] && record[STATUS_FIELD].value) || 'ready';
    const recElapsed = Number((record[ELAPSED_MS_FIELD] && record[ELAPSED_MS_FIELD].value) || 0);
    const recStartedAt = (record[STARTED_AT_FIELD] && record[STARTED_AT_FIELD].value) || null;

    // ローカル（表示の継続性確保）
    const local = loadLocal(recordId);
    state.baseElapsedMs = !isNaN(local.baseElapsedMs) ? local.baseElapsedMs : recElapsed;

    modeSel.value = local.mode || recMode;
    cdInput.value = String(
      !isNaN(local.countdownSec) ? local.countdownSec : recCountdown || ''
    );

    // running状態なら、基準を再構築して走らせる
    if (recStatus === 'running' && recStartedAt) {
      const startedAt = new Date(recStartedAt).getTime();
      const serverElapsed = recElapsed + (Date.now() - startedAt);
      state.baseElapsedMs = serverElapsed;
      startTimer(); // 自動再開
    } else {
      // 停止中表示更新
      renderDisplay(state.baseElapsedMs);
    }

    // ====== イベントハンドラ ======
    modeSel.addEventListener('change', () => {
      saveLocal(recordId, {
        ...loadLocal(recordId),
        mode: modeSel.value
      });
    });
    cdInput.addEventListener('input', () => {
      const v = Math.max(0, Number(cdInput.value || 0));
      saveLocal(recordId, {
        ...loadLocal(recordId),
        countdownSec: v
      });
    });

    startBtn.addEventListener('click', async () => {
      if (state.running) return;
      startTimer();
      // サーバに状態反映（Started_At/Status）
      if (record.$id && record.$id.value) {
        await updateRecord(record.$id.value, {
          [STATUS_FIELD]: { value: 'running' },
          [STARTED_AT_FIELD]: { value: nowIso() }
        });
      } else {
        // 新規作成画面では画面上のrecordに反映
        record[STATUS_FIELD].value = 'running';
        record[STARTED_AT_FIELD].value = nowIso();
      }
    });

    pauseBtn.addEventListener('click', async () => {
      if (!state.running) return;
      stopTimerAndFreeze();
      // サーバへ反映
      await saveElapsedToServer('paused');
    });

    resetBtn.addEventListener('click', async () => {
      stopTimerAndFreeze();
      state.baseElapsedMs = 0;
      renderDisplay(0);
      saveLocal(recordId, {
        ...loadLocal(recordId),
        baseElapsedMs: 0
      });
      // サーバへ反映
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
          // 完了処理
          stopTimerAndFreeze();
          // 軽い通知
          alert('カウントダウンが終了しました。');
          saveElapsedToServer('paused'); // 終了値を保存
          return; // 停止
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
      saveLocal(recordId, {
        ...loadLocal(recordId),
        baseElapsedMs: state.baseElapsedMs
      });
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

    // visibilitychange でもズレ最小化（タブ復帰時に表示補正）
    document.addEventListener('visibilitychange', () => {
      if (!state.running) return;
      // 表示更新だけでOK（elapsedは差分計算）
      renderDisplay(currentElapsed());
    });
  }

  // ====== 画面ごとのフック ======
  const desktopEvents = [
    'app.record.create.show',
    'app.record.edit.show',
    'app.record.detail.show'
  ];
  const mobileEvents = [
    'mobile.app.record.create.show',
    'mobile.app.record.edit.show',
    'mobile.app.record.detail.show'
  ];

  kintone.events.on(desktopEvents, function (event) {
    const el = getSpaceElement(event, false);
    if (!el) return event;
    el.innerHTML = ''; // 再描画対策
    renderUI({ container: el, event, isMobile: false });
    return event;
  });

  kintone.events.on(mobileEvents, function (event) {
    const el = getSpaceElement(event, true);
    if (!el) return event;
    el.innerHTML = '';
    renderUI({ container: el, event, isMobile: true });
    return event;
  });

})();
