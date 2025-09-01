(function () {
  'use strict';

  // QRコードライブラリの読み込み（例: QRCode.js）
  const script = document.createElement('script');
  script.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
  document.head.appendChild(script);

  script.onload = function () {
    kintone.events.on('app.record.detail.show', function (event) {
      const record = event.record;
      const tableField = record['テーブルフィールドコード']; // ←変更する

      tableField.value.forEach((row, index) => {
        const td = kintone.app.record.getFieldElement('テーブルフィールドコード').querySelectorAll('tr')[index + 1].children[1]; // 列番号に注意

        const qrDiv = document.createElement('div');
        new QRCode(qrDiv, {
          text: row.value['対象フィールドコード'].value,
          width: 80,
          height: 80
        });

        td.innerHTML = ''; // 既存の内容を消去（必要に応じて）
        td.appendChild(qrDiv);
      });

      return event;
    });
  };
})();

