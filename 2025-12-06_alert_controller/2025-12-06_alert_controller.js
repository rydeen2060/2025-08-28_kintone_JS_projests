(function() {
  'use strict';

  // フィールドコードの定義
  const FIELD = {
    DATETIME: 'datetime_001',        // 測定日時フィールド
    DEVIATION: 'deviation_status',   // 現在の逸脱判定フィールド
    PREV_DEVIATION: 'prev_deviation' // 前回の逸脱判定フィールド（自動設定）
  };

  // レコード保存時のイベント登録（新規作成・編集の両方）
  kintone.events.on([
    'app.record.create.submit',  // 新規作成時
    'app.record.edit.submit'     // 編集時
  ], function(event) {
    console.log('=== 前回の逸脱判定コピー処理開始 ===');
    const record = event.record;

    // 現在のレコードの測定日時を取得（存在しない場合はnull）
    const currentDatetime = record[FIELD.DATETIME] ? record[FIELD.DATETIME].value : null;
    // 現在のレコードIDを取得（編集時のみ存在、新規作成時はnull）
    const currentRecordId = record.$id ? record.$id.value : null;

    // デバッグ用：現在の状態をコンソールに出力
    console.log('現在の逸脱判定:', record[FIELD.DEVIATION].value);
    console.log('測定日時:', currentDatetime);

    // 前回のレコードから逸脱判定を取得（非同期処理）
    return getPreviousDeviation(currentDatetime, currentRecordId)
      .then(function(prevDeviation) {
        console.log('前回の逸脱判定:', prevDeviation);
        // 前回の逸脱判定フィールドに値をセット（取得できない場合は空文字）
        record[FIELD.PREV_DEVIATION].value = prevDeviation || '';
        console.log('=== 処理完了 ===');
        return event;  // イベントを返してレコード保存を継続
      })
      .catch(function(error) {
        // エラー発生時も処理を継続（前回逸脱判定は空文字に設定）
        console.error('エラー発生:', error);
        record[FIELD.PREV_DEVIATION].value = '';
        return event;  // エラーでもレコード保存は継続
      });
  });
  
  /**
   * 前回の逸脱判定を取得する関数
   * @param {string} currentDatetime - 現在のレコードの測定日時
   * @param {string} currentRecordId - 現在のレコードID（編集時のみ）
   * @return {Promise<string|null>} 前回の逸脱判定の値、または取得できない場合はnull
   */
  function getPreviousDeviation(currentDatetime, currentRecordId) {
    const appId = kintone.app.getId();  // 現在のアプリIDを取得
    let query = '';

    // 編集時：自分自身のレコードを除外する条件を追加
    if (currentRecordId) {
      query = '$id != ' + currentRecordId;
    }

    // 測定日時が存在する場合：現在の日時より前のレコードを検索対象にする
    if (currentDatetime) {
      if (query) query += ' and ';  // 既存条件がある場合はAND結合
      query += 'datetime_001 < "' + currentDatetime + '"';
    }

    // ソート条件：測定日時の降順で最新1件のみ取得
    query += ' order by datetime_001 desc limit 1';

    console.log('検索クエリ:', query);

    // kintone REST APIのパラメータ設定
    const params = {
      app: appId,
      query: query
    };

    // kintone REST APIでレコードを取得
    return kintone.api(kintone.api.url('/k/v1/records', true), 'GET', params)
      .then(function(resp) {
        console.log('API取得結果:', resp);
        // レコードが取得できた場合、その逸脱判定の値を返す
        if (resp.records && resp.records.length > 0) {
          return resp.records[0].deviation_status.value;
        }
        // レコードが見つからない場合はnullを返す
        return null;
      });
  }
  
})();