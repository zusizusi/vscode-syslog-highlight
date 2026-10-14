# Syslog Highlight

RFC 5424・BSD形式のsyslogを読みやすく表示するVS Code拡張です。
WARN行にはアンバー、ERROR以上の行には赤の薄い背景を付け、ROS 2のstdoutを転送したログにも対応します。

日時・ホスト名・アプリ名などを色分けし、PRIのホバーでseverityとfacilityを確認できます。

## 使い始める

VS Code 1.85以上に対応しています。

1. GitHubの **Releases** から`syslog-highlight-*.vsix`をダウンロードします。自分で作成する場合は[開発](#開発)を参照してください。
2. コマンドパレットで **Extensions: Install from VSIX...** を実行し、ダウンロードしたVSIXを選択します。
3. `.log`または`.syslog`ファイルを開きます。

[サンプルログ](examples/mixed.log)で両形式・各レベルの表示を確認できます。複数の形式が混在していても、行ごとに判定します。

拡張子のない`/var/log/messages`などは、右下の言語モードから **Syslog** を選択してください。
`files.associations`や他の拡張によって別の言語モードになっていても、`.log`・`.syslog`内の認識できるsyslog行は色分けします。

## 表示のルール

### 行の背景

メッセージ先頭にROS 2のレベルがあれば、それを優先します。なければ、PRIから求めたseverity（`PRI % 8`）を使います。

| 判定したレベル | 行の背景 |
| --- | --- |
| Emergency・Alert・Critical・Error（severity 0〜3） | 薄い赤 |
| Warning（severity 4） | 薄いアンバー（黄寄り） |
| Notice・Informational・Debug（severity 5〜7） | なし |

PRIもROS 2のレベルもないBSDログでは、ヘッダーだけを色分けします。本文中の単語からレベルを推測しません。

### ROS 2のラベル

| ラベル | 対応するseverity | 文字色（標準ダークテーマ） | 行の背景 |
| --- | --- | --- | --- |
| `[FATAL]` | 2: Critical | 赤・太字 | 薄い赤 |
| `[ERROR]` | 3: Error | オレンジ・太字 | 薄い赤 |
| `[WARN]` | 4: Warning | 黄 | 薄いアンバー |
| `[INFO]` | 6: Informational | 通常の文字色 | なし |
| `[DEBUG]` | 7: Debug | 少し暗めの白 | なし |

INFOはテーマの通常の文字色（`editor.foreground`）を直接使います。ライトテーマでは黒系になり、DEBUGもテーマに合わせた控えめな色になります。

次の3行は、順に赤い背景・アンバーの背景・背景なしになります。

```text
<166>1 2026-10-15T09:00:00+09:00 robot ros2 200 ROS - [ERROR] [controller]: Command failed
<166>Oct 15 09:00:01 robot ros2[200]: [WARN] [controller]: Battery low
Oct 15 09:00:02 robot ros2[200]: [controller-1] [INFO 1792022402.123] [controller] Ready
```

最初の行のPRIはseverity 6（Informational）ですが、背景はROS 2のERRORを優先します。PRIの数値・ファイル内容は変更しません。

検出できるのは、メッセージ先頭の`[ERROR]`や`[ERROR 1792022400.123]`などの大文字のレベルラベルです。`[controller-1]`のようなlaunchの接頭辞や、ANSIの色制御コードにも対応します。
本文途中の`ERROR`・`[ERROR]`、ヘッダーや構造化データ内の表記は、ROS 2レベルとして扱いません。

## 設定

VS Codeの`settings.json`、または設定画面で変更できます。ワークスペースごとの設定にも対応します。

| 設定 | 既定値 | 動作 |
| --- | --- | --- |
| `syslogHighlight.enabled` | `true` | 色分けとPRIのホバーを有効にする |
| `syslogHighlight.lineHighlight` | `true` | 行の背景ハイライトを有効にする |

背景だけを無効にする場合は、`syslogHighlight.lineHighlight`を`false`にします。

色や濃さは`workbench.colorCustomizations`で調整できます。以下はダークテーマ向けの例です。

```json
{
  "workbench.colorCustomizations": {
    "syslogHighlight.warningBackground": "#FACC1533",
    "syslogHighlight.errorBackground": "#EF444440",
    "syslogHighlight.debug": "#B0B0B0"
  }
}
```

背景色の末尾2桁は不透明度です。`33`は約20%、`40`は約25%で、値を大きくすると濃くなります。

<details>
<summary>その他の色設定</summary>

| 対象 | 設定キー |
| --- | --- |
| FATALラベル | `syslogHighlight.critical` |
| ERRORラベル | `syslogHighlight.error` |
| WARNラベル | `syslogHighlight.warning` |
| VERSION | `syslogHighlight.version` |
| 日時 | `syslogHighlight.timestamp` |
| ホスト名 | `syslogHighlight.hostname` |
| アプリ名・BSDのタグ | `syslogHighlight.appName` |
| プロセスID | `syslogHighlight.procId` |
| メッセージID | `syslogHighlight.msgId` |
| 構造化データ | `syslogHighlight.structuredData` |

Emergency・Alert・Critical・Errorの背景は、共通の`syslogHighlight.errorBackground`で変更します。

</details>

## 表示が変わらないとき

- **拡張を更新した後**：VS Codeのウィンドウを再読み込みします。F5で開発中なら、デバッグを停止してから再起動してください。
- **拡張子のないファイル**：言語モードを **Syslog** にします。
- **背景色が出ない**：`syslogHighlight.enabled`と`syslogHighlight.lineHighlight`、ログの形式を確認します。INFO・DEBUGには背景を付けません。
- **指定した色と違う**：ユーザー設定・ワークスペース設定の`workbench.colorCustomizations`を確認します。

## 開発

開発・VSIX作成にはNode.js 22以上を使ってください。実行時の外部依存やビルド処理はありません。

```sh
npm ci
npm test
npm run package
```

このフォルダーをVS Codeで開き、`F5`を押すと、Extension Development Hostでサンプルログが開きます。
`npm run package`でインストール用VSIXを作成できます。`vsce`は開発用の依存で、依存パッケージとlockファイルはVSIXに含めません。
ローカル用VSIXではREADMEの相対リンクを保持し、Release用VSIXではタグに対応するGitHubのURLへ変換します。

`local-syslog`はローカルパッケージ用のpublisher名です。Marketplaceに公開する場合は、登録したpublisher名に変更してください。

## GitHub Release

[リリース用ワークフロー](.github/workflows/release.yml)は、`v`で始まるタグのpushで実行されます。
タグと`package.json`・`package-lock.json`のバージョンを確認し、`npm ci` → テスト → VSIX作成 → GitHub Releaseへの添付を自動で行います。追加のシークレットは不要です。

ワークフローと変更をコミットしてGitHubにpushした後、`package.json`のバージョンと一致するタグをpushしてください。次のコマンドは現在のバージョンを読み取ってタグを作成します。

```sh
release_version=$(node -p "require('./package.json').version")
git tag "v${release_version}"
git push origin "v${release_version}"
```

タグ・両方のJSONのバージョンは一致する必要があります。`0.0.1`ならタグは`v0.0.1`です。タグは作成時のコミットを指すため、バージョンを修正した後に古いActionsを再実行しても、その変更は反映されません。

次のバージョンを公開するときは、変更をコミットした状態で次を実行できます。

```sh
npm version patch
git push origin HEAD --follow-tags
```

`npm version patch`は両方のJSONのバージョンを更新し、コミットとタグを作成します。リリースノートは自動生成され、`v0.4.0-beta.1`などはプレリリースとして公開されます。

## 対応範囲

- [RFC 5424](https://www.rfc-editor.org/rfc/rfc5424.html)のVERSION 1。NILVALUE（`-`）、タイムゾーン、最大6桁の秒小数、複数の構造化データ要素、`\"`・`\\`・`\]`エスケープに対応。
- [BSD（RFC 3164スタイル）](https://www.rfc-editor.org/rfc/rfc3164.html)。PRIの有無、`Oct 15`・`Oct  5`の日付表記、`sshd[1234]:`などのタグ・PIDに対応。
- 1行に1レコードのテキストログが対象です。認識できない行は通常の文字色で表示します。
- RFC 6587の長さプレフィックス、JSON、年付きのBSD独自形式、圧縮ファイル、複数行にまたがるレコードは対象外です。
- 編集・スクロール・分割エディターに対応し、表示範囲の前後20行を処理します。RFC適合性を網羅的に検証するツールではありません。

[MIT License](LICENSE)
