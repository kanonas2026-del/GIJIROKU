# 図面メモ議事録 GitHub Pages APIキー管理サンプル

iPad Safari + GitHub Pages 前提のサンプルです。

## 目的

- GitHubにはアプリ本体だけ置く
- 本物のGemini APIキーはGitHubに置かない
- iPad内の `gemini_api_key.txt` を読み込む
- 3本以上のAPIキーをローテーションする
- 429 / quota 系エラー時は次のキーへ切り替える
- 運用が固まるまでは「毎回APIキー選択」を基本にする
- 必要になったら「このiPadに保存する」を使えるようにする

## ファイル構成

```text
zumen_minutes_github_pages_key_sample/
├ index.html
├ style.css
├ app.js
├ manifest.json
├ README.md
└ sample/
   ├ gemini_api_key.sample.txt
   └ prompt_sample.txt
```

## iPadでの使い方

1. GitHub PagesのURLをSafariで開く
2. 共有ボタンから「ホーム画面に追加」
3. ホーム画面のアイコンから起動
4. 「APIキーファイル」で、iPad内の `gemini_api_key.txt` を選択
5. `読み込み済みキー：3件` になればOK
6. 「接続テスト」を押す

## gemini_api_key.txt の形式

```text
API_KEY_1
API_KEY_2
API_KEY_3
```

空行と `#` から始まる行は無視します。

## 重要な注意

本物のAPIキーをGitHubにコミットしないでください。

このサンプルはブラウザからGemini APIを直接呼びます。GitHubにはキーを保存しませんが、ブラウザで直接APIを使う以上、完全秘匿ではありません。業務用途では、少なくともGemini APIのみにキー制限をかけてください。

## 次に組み込む予定

- Dropboxからプロンプトファイルを読み込み
- 画像アップロード / カメラ撮影
- Geminiで図面メモ読み取り
- 修正画面
- docx出力
- 案件データ保存
