# AXIDIA

スマホ向け（横画面）のWebリズムゲーム。上から降ってくるノーツを、判定ラインに重なった瞬間に処理します。

- **横画面専用**: 縦向きでは「横向きにしてください」と表示します（Android Chrome では全画面＋向きロックも試みます）
- **上下2本の判定ライン**: 下ラインへは上端からノーツが降ってきて、上ラインへは下端からノーツが上がってきます（上下反転）。画面の上半分のタッチは上ライン、下半分のタッチは下ラインの判定になります
- **フリック（ひし形）**: 画面中央にひし形がフェードで現れ、画面外からひし形のガイドがズームインして重なった瞬間が判定タイミングです
- **同時押しガイド**: 同じタイミングのノーツ（上下ラインをまたぐものも含む）は淡い水色に光ります
- **判定はエフェクトで表示**: PERFECT＝水色の大きなバースト＋光の柱＋破片 / GREAT＝白のバースト / GOOD＝小さな灰色のリング / MISS＝赤
- **フリーレーン**: 固定レーンはありません。ノーツは横方向のどこにでも降ってきて、その位置で処理します
- 音楽なし（拍のガイド線とタップ音のみ）
- ビルド不要・依存なしの素の HTML / Canvas / ES Modules

## 遊び方

| ノーツ | 見た目 | 操作 |
| --- | --- | --- |
| TAP | 白いバー | 線に重なる瞬間にタップ |
| HOLD | 白いバー＋帯 | 頭をタップして、帯の終わりまで指を離さない |
| DRAG | 黄色の細いバー | 線に重なる瞬間にそこに指があればOK（タップ不要・なぞってよい） |
| FLICK | 中央のひし形 | ガイドが重なる瞬間に、画面に触れた指をどの方向にでも動かす（タップ判定なし） |

- HOLD は「頭」と「終点」で2回判定されます。頭はタップと同じ判定、終点は最後まで押し続ければ PERFECT、途中で離すと MISS（終点の150ms前以降は離してもOK）
- DRAG と FLICK は PERFECT か MISS のみ

| 判定 | タイミング幅 |
| --- | --- |
| PERFECT | ±45ms |
| GREAT | ±90ms |
| GOOD | ±135ms |
| MISS | それ以外・見逃し |

ノーツの左右（ノーツ幅 + 少しの余裕）以内なら当たり判定になります。
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
{ bpm, beatMs, duration, notes: [{ type: 'tap' | 'drag' | 'hold' | 'flick', side: 'top' | 'bottom' | 'center', time: ms, x: 0..1, end?: ms }] }
```

`x` はプレイフィールド幅に対するノーツ中心の位置、`end` はホールドの終了時刻です。現在は難易度ごとに固定シードで生成しています。

### デバッグ

`?debug` を付けて開くと `window.__game` からゲーム状態を参照できます。
