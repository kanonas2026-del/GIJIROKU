# 図面メモ議事録 GitHub Pages版 v02

iPad Safari + GitHub Pages + Gemini API の試作版です。

## 重要

GitHubに本物のAPIキーを絶対にアップしないでください。

- GitHub：アプリ本体だけ
- Dropbox：プロンプト、テンプレート、案件バックアップ
- iPad内：本物の `gemini_api_key.txt`

## 今回の機能

- `gemini_api_key.txt` 読み込み
- 複数APIキーのローテーション
- 429 / quota 系エラー時のキー切替
- 「このiPadに保存する」
- 「読み取り後にキーを破棄する」
- プロンプトtxt読み込み
- 図面画像アップロード
- iPadカメラ撮影
- カメラプレビュー撮影
- Gemini画像読み取り
- AI読み取り結果の修正画面
- 案件をiPad内ブラウザDBへ保存
- JSON書き出し
- Wordで開ける `.doc` 書き出し

## GitHubへアップするファイル

リポジトリ直下に以下をアップロードしてください。

```text
index.html
style.css
app.js
manifest.json
README.md
prompt_sample.txt
gemini_api_key.sample.txt
```

既存ファイルがある場合は上書きでOKです。

## iPadでの使い方

1. GitHub PagesのURLをSafariで開く
2. 共有ボタン → ホーム画面に追加
3. `gemini_api_key.txt` をiPad内から読み込む
4. `prompt_sample.txt` または物件別プロンプトを読み込む
5. 図面画像を追加、またはカメラで撮影
6. Geminiで読み取り
7. 修正画面で確認
8. Word出力

## APIキー形式

`gemini_api_key.txt` は1行1キーです。

```text
API_KEY_1
API_KEY_2
API_KEY_3
```

## 注意

この試作版のWord出力は、Wordで開ける `.doc` 形式です。
正式な `.docx` テンプレート差し込みは次段階で実装予定です。

PDF画像の直接読み込みは未対応です。
PDF図面は、iPadでスクリーンショットまたは画像化して読み込んでください。
