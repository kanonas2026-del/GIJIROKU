# 図面メモ議事録 GitHub Pages版 v03

v03の修正点：

- 初期モデルを `gemini-2.5-flash` に変更
- Gemini応答に `items` が空でも、要確認カードを最低1件出す
- `items` 以外のJSON形式も拾う
- Gemini応答の先頭をログ表示
- Gemini応答保存ボタンを追加
- 読み取り0件対策のプロンプトを強化

## GitHubへアップするファイル

リポジトリ直下に以下を上書きアップロードしてください。

```text
index.html
style.css
app.js
manifest.json
README.md
prompt_sample.txt
gemini_api_key.sample.txt
```

本物の `gemini_api_key.txt` は絶対にGitHubへアップしないでください。

## 読み取りが0件になる場合

v03では、0件のまま終わらず、最低1件「要確認」を出します。

それでも内容が弱い場合は、以下を確認してください。

- 画像に手書きメモが写っているか
- 文字が潰れていないか
- 図面全体が遠すぎないか
- `prompt_sample.txt` を読み込んでいるか
- モデルが `gemini-2.5-flash` になっているか

## iPadで更新されない場合

GitHubへ上書き後、以下で開いてください。

```text
https://kanonas2026-del.github.io/GIJIROKU/?ver=03
```
