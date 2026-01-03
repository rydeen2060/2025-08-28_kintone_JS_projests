(function () {
  'use strict';

  // ポータルページ以外では実行しない
  if (!kintone.portal) {
    return;
  }

  // ==========================================
  // 【重要】以下のAPP_IDを必ず変更してください
  // ==========================================
  const APP_ID = 287; // 実際のアプリIDに変更してください
  const DEADLINE_FIELD = '提出期限';
  const STATUS_FIELD = 'STATUS_FIELD';
  const NAME_FIELD = '書類名'; // 追加：書類名など識別できる文字列フィールド
  const STATUS_VALUE_ACTIVE = '未終了';
  const CONTAINER_ID = 'countdown-container';
  const MAX_RECORDS = 500; // 取得する最大レコード数

  let cachedRecords = [];

  // レコード取得（ページング対応）
  async function fetchAllRecords() {
    try {
      const allRecords = [];
      let offset = 0;
      const limit = 500; // kintone APIの1回の取得上限

      while (true) {
        const response = await kintone.api(kintone.api.url('/k/v1/records', true), 'GET', {
          app: APP_ID,
          query: `${STATUS_FIELD} in ("${STATUS_VALUE_ACTIVE}") order by ${DEADLINE_FIELD} asc limit ${limit} offset ${offset}`,
          fields: [DEADLINE_FIELD, STATUS_FIELD, NAME_FIELD],
        });

        allRecords.push(...response.records);

        // 上限に達したか、これ以上レコードがない場合は終了
        if (response.records.length < limit || allRecords.length >= MAX_RECORDS) {
          break;
        }
        offset += limit;
      }

      return allRecords;
    } catch (error) {
      console.error('レコード取得エラー:', error);
      throw new Error(`レコードの取得に失敗しました: ${error.message || 'ネットワークエラー'}`);
    }
  }

  // カウントダウン計算関数
  function calculateCountdown(deadline) {
    const now = new Date();
    const timeDiff = deadline.getTime() - now.getTime();

    if (timeDiff <= 0) return null;

    const days = Math.floor(timeDiff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((timeDiff / (1000 * 60 * 60)) % 24);
    const minutes = Math.floor((timeDiff / (1000 * 60)) % 60);
    const seconds = Math.floor((timeDiff / 1000) % 60);

    return { days, hours, minutes, seconds, timeDiff };
  }

  // 表示更新（秒単位）
  function updateDisplay() {
    const countdownHTML = cachedRecords.map(record => {
      // 日付フィールドのバリデーション
      const deadlineValue = record[DEADLINE_FIELD]?.value;
      if (!deadlineValue) {
        console.warn('期限が設定されていないレコード:', record);
        return null;
      }

      const deadline = new Date(deadlineValue);
      if (isNaN(deadline.getTime())) {
        console.warn('無効な日付形式:', deadlineValue);
        return null;
      }

      const name = record[NAME_FIELD]?.value || '(名称未設定)';
      const countdown = calculateCountdown(deadline);

      if (!countdown) return null;

      const { days, hours, minutes, seconds, timeDiff } = countdown;
      const isUrgent = timeDiff < 24 * 60 * 60 * 1000; // 24時間以内
      const urgentClass = isUrgent ? 'urgent' : '';

      return `
        <div class="countdown-item ${urgentClass}">
          <div class="doc-title">📄 ${escapeHtml(name)}</div>
          <div>提出期限: ${deadline.toLocaleString('ja-JP')}</div>
          <div class="countdown-timer">${days}日 ${hours}時間 ${minutes}分 ${seconds}秒</div>
        </div>`;
    }).filter(Boolean).join('');

    const list = document.querySelector(`#${CONTAINER_ID} .countdown-list`);
    if (list) {
      list.innerHTML = countdownHTML || '<div class="no-items-message">現在カウントダウン中の提出書類はありません。</div>';
    }
  }

  // HTMLエスケープ（XSS対策）
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // レコード再取得
  async function loadCountdowns() {
    try {
      const records = await fetchAllRecords();
      cachedRecords = records;
      updateDisplay();
    } catch (error) {
      console.error('カウントダウン読み込みエラー:', error);
      const list = document.querySelector(`#${CONTAINER_ID} .countdown-list`);
      if (list) {
        list.innerHTML = `<div class="error-message">⚠️ ${escapeHtml(error.message)}<br>アプリIDやフィールド設定を確認してください。</div>`;
      }
    }
  }

  // ポータル表示イベント
  kintone.events.on('portal.show', function() {
    // 既に追加済みの場合はスキップ
    if (document.getElementById(CONTAINER_ID)) {
      return;
    }

    // コンテンツスペース要素を取得
    const portalSpace = kintone.portal.getContentSpaceElement();

    // コンテンツスペースが無い場合は、ポータル本体に追加
    const targetElement = portalSpace || document.querySelector('.ocean-portal-body, .gaia-portal-container-body, .contents-body');

    if (!targetElement) {
      console.warn('表示先の要素が見つかりません');
      return;
    }

    const container = document.createElement('div');
    container.id = CONTAINER_ID;
    container.innerHTML = `<h2>提出期限カウントダウン</h2><div class="countdown-list">読み込み中...</div>`;

    // 先頭に挿入
    targetElement.insertBefore(container, targetElement.firstChild);

    // 初回読み込み
    loadCountdowns();

    // 秒単位で表示更新
    setInterval(updateDisplay, 1000);

    // 5分ごとにレコード再取得
    setInterval(loadCountdowns, 5 * 60 * 1000);
  });
})();
