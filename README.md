# AXIDIA

スマホ向けのWebリズムゲーム。上から降ってくるノーツを、判定ラインに重なった瞬間にタップします。

- **フリーレーン**: 固定レーンはありません。ノーツは横方向のどこにでも降ってきて、その位置をタップします
- **タップノーツのみ**
- 音楽なし（拍のガイド線とタップ音のみ）
- ビルド不要・依存なしの素の HTML / Canvas / ES Modules

## 遊び方

| 判定 | タイミング幅 |
| --- | --- |
| PERFECT | ±45ms |
| GREAT | ±90ms |
| GOOD | ±135ms |
| MISS | それ以外・見逃し |

ノーツの左右（ノーツ幅 + 少しの余裕）以内をタップすれば当たり判定になります。
スコアは 1,000,000 点満点（PERFECT 100% / GREAT 70% / GOOD 30%）。

## スマホでテストする

### A. GitHub Pages（どこからでも）

`main` または `claude/**` ブランチに push すると `.github/workflows/pages.yml` が自動デプロイします。

初回のみ設定が必要です:

1. GitHub のリポジトリで **Settings → Pages → Build and deployment → Source** を **GitHub Actions** にする
2. **Settings → Environments → github-pages → Deployment branches** で、デプロイしたいブランチ（例: `claude/*`）を許可する（デフォルトブランチ以外から出す場合）
3. **Actions** タブから「Deploy to GitHub Pages」を再実行（または再 push）

公開URL: `https://<user>.github.io/axidia/`
タイトル画面下部の `build xxxxxxx` で、どのコミットが表示されているか確認できます。

> Pages はキャッシュされるため、更新直後は数分古い版が出ることがあります。

### B. ローカルネットワーク（PCとスマホが同じWi-Fi）

```sh
npm run dev        # または: node scripts/serve.mjs [port]
```

表示された `network: http://192.168.x.x:5173/` をスマホのブラウザで開きます。

### ホーム画面に追加

iOS Safari の「共有 → ホーム画面に追加」で、アドレスバーなしの全画面で遊べます。

## 構成

```
web/
  index.html          画面（タイトル / ポーズ / リザルト）
  style.css
  src/main.js         画面遷移・設定の保存
  src/game.js         ゲームループ・判定・描画（Canvas）
  src/chart.js        譜面フォーマットと譜面生成
  src/sfx.js          タップ音（Web Audio で合成）
scripts/serve.mjs     スマホ確認用の静的サーバー
```

### 譜面フォーマット

```js
{ bpm, duration, notes: [{ time: ms, x: 0..1 }] }
```

`x` はプレイフィールド幅に対するノーツ中心の位置です。現在は難易度ごとに固定シードで生成しています。

### デバッグ

`?debug` を付けて開くと `window.__game` からゲーム状態を参照できます。
