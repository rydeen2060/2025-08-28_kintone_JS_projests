# 前回の逸脱判定コピー機能 v0.01.02

## 概要
kintoneアプリで、レコード保存時に前回のレコードの逸脱判定を自動的にコピーする機能です。

**v0.01.02の新機能:**
- AWS Lambda等のAPI経由でのレコード作成に対応
- UI操作とAPI操作の両方で前回の逸脱判定を自動設定

## バージョン履歴

### v0.01.02 (2025-12-08)
- API経由（Lambda等）でのレコード作成に対応
- `app.record.create.submit.success`イベントを追加
- レコード作成後の自動更新機能を実装
- Lambda側で既に値が設定されている場合はスキップする機能を追加

### v0.01.00 (2025-12-06)
- 初期リリース
- UI操作時の前回逸脱判定コピー機能

## 機能説明

### 主な処理
1. レコードの新規作成または編集時に自動実行
2. 現在のレコードの測定日時より前の最新レコードを検索
3. 前回のレコードの逸脱判定を取得し、`prev_deviation`フィールドに自動設定

### 対応イベント

**UI操作時（手動作成・編集）:**
- レコード新規作成時（`app.record.create.submit`）
- レコード編集時（`app.record.edit.submit`）

**API経由（Lambda等の外部システム）:**
- レコード作成成功後（`app.record.create.submit.success`）
- 作成後に自動でレコードを更新して前回の逸脱判定を設定

## フィールド定義

| フィールドコード | 説明 | 備考 |
|---|---|---|
| `datetime_001` | 測定日時 | レコードの時系列順を判定するために使用 |
| `deviation_status` | 現在の逸脱判定 | ユーザーが入力または自動判定される値 |
| `prev_deviation` | 前回の逸脱判定 | 本スクリプトで自動設定される |

## 処理フロー

### UI操作時（手動作成・編集）

```
1. レコード保存イベント発火（submit）
   ↓
2. 現在のレコードの測定日時とIDを取得
   ↓
3. kintone REST APIで前回レコードを検索
   - 条件: 現在の日時より前
   - 条件: 自分自身を除外（編集時）
   - ソート: 測定日時の降順
   - 件数: 1件のみ
   ↓
4. 取得した前回レコードの逸脱判定を設定
   ↓
5. レコード保存完了
```

### API経由（Lambda等）

```
1. Lambda等が kintone REST API でレコードを作成
   ↓
2. レコード作成成功イベント発火（submit.success）
   ↓
3. 前回の逸脱判定が未設定かチェック
   ↓
4. kintone REST APIで前回レコードを検索
   ↓
5. 前回の逸脱判定が見つかった場合
   ↓
6. kintone REST APIでレコードを更新
   （prev_deviationフィールドに前回の値を設定）
```

## 使用例

時系列でデータが蓄積される場合の動作例：

```
レコード1:
  datetime_001: "2025-12-01 10:00"
  deviation_status: "正常"
  prev_deviation: ""（前回データなし）

レコード2:
  datetime_001: "2025-12-01 11:00"
  deviation_status: "警告"
  prev_deviation: "正常"（自動設定）

レコード3:
  datetime_001: "2025-12-01 12:00"
  deviation_status: "異常"
  prev_deviation: "警告"（自動設定）
```

### Lambda経由での作成例

Lambda関数でレコード作成：
```javascript
// Lambdaからkintone APIでレコード作成
const record = {
  "datetime_001": { "value": "2025-12-08T10:00:00Z" },
  "deviation_status": { "value": "警告" }
  // prev_deviationは未設定でOK（自動で設定される）
};
```

数秒後、kintone JavaScriptが自動で`prev_deviation`を更新します。

## エラーハンドリング

- API取得エラーが発生した場合でも、レコード保存は継続されます
- エラー時は`prev_deviation`フィールドに空文字が設定されます
- エラー内容はコンソールに出力されます

## セットアップ

1. kintoneアプリに以下のフィールドを作成：
   - `datetime_001`（日時フィールド）
   - `deviation_status`（文字列フィールドまたはドロップダウン）
   - `prev_deviation`（文字列フィールド、読み取り専用推奨）

2. JavaScriptファイルをkintoneアプリに設定：
   - アプリの設定 → JavaScript / CSSでカスタマイズ
   - `2025-12-08_alert_controller_0.01.02.js`をアップロード

3. アプリを更新して動作確認

## 注意事項

- `prev_deviation`フィールドは自動設定されるため、ユーザーが直接編集する必要はありません
- 測定日時が未入力の場合、前回レコードの検索が正しく機能しない可能性があります
- kintone REST APIの実行権限が必要です

**Lambda等のAPI経由でレコード作成する場合:**
- レコード作成後、数秒以内に自動でレコードが更新されます
- `prev_deviation`フィールドの編集権限が必要です
- Lambda側で`prev_deviation`に値を設定している場合は、その値が優先されます（上書きされません）

## デバッグ

kintoneのブラウザコンソールで以下のログを確認できます：

**UI操作時:**
```
=== 前回の逸脱判定コピー処理開始（submit） ===
現在の逸脱判定: 警告
測定日時: 2025-12-08T10:00:00Z
検索クエリ: datetime_001 < "2025-12-08T10:00:00Z" order by datetime_001 desc limit 1
前回の逸脱判定: 正常
=== 処理完了（submit） ===
```

**API経由（Lambda等）:**
```
=== 前回の逸脱判定コピー処理開始（API作成後） ===
レコードID: 123
測定日時: 2025-12-08T10:00:00Z
検索クエリ: $id != 123 and datetime_001 < "2025-12-08T10:00:00Z" order by datetime_001 desc limit 1
前回の逸脱判定: 正常
=== 前回の逸脱判定を更新完了（API） ===
```

## ファイル

- `2025-12-08_alert_controller_0.01.02.js` - メインスクリプト
- `README.md` - このドキュメント

## 作成日

- 初版: 2025-12-06
- v0.01.02: 2025-12-08

## 関連リンク

- リポジトリ: https://github.com/rydeen2060/2025-08-28_kintone_JS_projests
