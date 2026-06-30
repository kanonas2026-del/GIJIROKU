# 図面メモ議事録 GitHub Pages版 v05

v05の修正点：

- Word出力を `.doc` ではなく、正式な `.docx` 生成に変更
- iPad版Wordで開けない問題に対応
- 外部ライブラリなしでブラウザ内でDOCXパッケージを生成

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

## iPadで更新されない場合

GitHubへ上書き後、以下で開いてください。

```text
https://kanonas2026-del.github.io/GIJIROKU/?ver=05
```

## Word出力の確認

1. 読み取り結果または試験データを表示
2. 右上の「Word出力」
3. ダウンロードされた `.docx` をファイルアプリで開く
4. 共有から Word を選択、またはWordアプリで開く



## v05の修正点

- APIキーを一度読み込むと、このiPadに保存して次回から自動読込します。
- 初期状態で「このiPadに保存する」をONにしました。
- 「読み取り後にキーを破棄する」はOFFにしました。
- 保存済みキーの状態表示を追加しました。
- 保存キー削除ボタンでリセットできます。

更新確認URL：`https://kanonas2026-del.github.io/GIJIROKU/?ver=05`
