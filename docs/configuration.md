# 設定リファレンス

`os-exec-mcp` の起動モードは一つです。CLI 引数は受け付けません。既定では
親プロセスの `PATH` にある実行ファイルを許可し、直接の権限昇格コマンドだけを
拒否します。認可の中心は MCP クライアント側の承認・sandboxへ委譲します。

## 1. 既定動作

ポリシーファイルを指定しない場合、起動時のカレントディレクトリを workspace
root として次の方針を使います。

- `commandMode: "denylist"`
- `readOnly: false`
- `inheritExecutablePath: true`
- `commands: {}`
- `deniedCommands: ["doas", "pkexec", "runas", "su", "sudo"]`

`docker`、`kubectl`、`rm`、`nohup`、shell、package managerを含むその他の
実行ファイルは既定で許可されます。サーバーはそれらの引数を書き換えません。

`doas`、`pkexec`、`runas`、`su`、`sudo` は組み込み規則でも常時拒否するため、
カスタムポリシーで許可できません。これは直接実行に対する拒否であり、許可された
runtimeやshellが別プロセスを起動する動作まで解析・遮断するものではありません。

同梱の [`examples/policy.default.json`](../examples/policy.default.json) は内蔵既定値を
明示した例です。

## 2. 起動

```bash
npx -y os-exec-mcp
```

`--development` を含むCLI引数は受け付けません。

### 環境変数

| 環境変数                 | 効果                                               |
| ------------------------ | -------------------------------------------------- |
| `OS_EXEC_POLICY_FILE`    | strict JSON のカスタムポリシーを読み込む           |
| `OS_EXEC_WORKSPACE_ROOT` | workspace rootを一つの起動時パスへ置き換える       |
| `OS_EXEC_LOG_LEVEL`      | `debug`、`info`、`warn`、`error`、`silent`         |
| `OS_EXEC_LEGACY_TOOLS`   | `batch_exec` と `workflow_exec` を一時的に公開する |

相対 `OS_EXEC_POLICY_FILE` と `OS_EXEC_WORKSPACE_ROOT` は起動時のカレント
ディレクトリから解決します。ポリシーファイル内の相対パスは、そのファイルがある
ディレクトリから解決します。

旧名 `OS_BATCH_POLICY_FILE`、`OS_BATCH_WORKSPACE_ROOT`、`OS_BATCH_LOG_LEVEL` は
0.x移行用aliasです。新旧を異なる値で同時指定すると起動を失敗させます。

## 3. ポリシーフィールド

ポリシーJSONはstrict schemaです。未知フィールド、型の違い、既定値と絶対上限の
矛盾は起動エラーになります。

### workspaceと実行量

| フィールド           |   既定値 |  設定可能範囲 | 意味                                           |
| -------------------- | -------: | ------------: | ---------------------------------------------- |
| `workspaceRoots`     |  `["."]` |     1〜32パス | `cwd` を許可するディレクトリ                   |
| `maxBatchSize`       |     `16` |        1〜256 | `exec` 一回の最大ステップ数                    |
| `maxConcurrency`     |     `16` |         1〜64 | リクエストおよびサーバー全体の同時プロセス上限 |
| `defaultConcurrency` |      `8` |         1〜64 | `concurrency`省略時の値                        |
| `defaultTimeoutMs`   | `120000` | 100〜600000ms | 各コマンドの既定タイムアウト                   |
| `maxTimeoutMs`       | `300000` | 100〜600000ms | 各コマンドが要求できる最大タイムアウト         |

### 出力

| フィールド                           |      既定値 | 意味                                 |
| ------------------------------------ | ----------: | ------------------------------------ |
| `defaultMaxOutputBytes`              |    `262144` | stdout / stderr一本あたりの既定上限  |
| `absoluteMaxOutputBytes`             |   `1048576` | 一本あたりの絶対上限                 |
| `defaultMaxTotalOutputBytes`         |    `262144` | `exec`全体の既定出力予算             |
| `absoluteMaxTotalOutputBytes`        |   `1048576` | `exec`全体の絶対出力上限             |
| `absoluteMaxSerializedResponseBytes` |   `2097152` | 最終JSONレスポンスの絶対上限         |
| `defaultOutputMode`                  | `"compact"` | 既定の結果形式                       |
| `persistTruncatedOutput`             |     `false` | 切り詰め出力を短期Resourceに保存する |
| `persistedOutputTtlMs`               |    `300000` | 出力ResourceのTTL                    |
| `persistedOutputMaxBytes`            |   `4194304` | サーバー全体の保持上限               |

### `exec_program`

| フィールド                  |      既定値 |    絶対上限 |
| --------------------------- | ----------: | ----------: |
| Program内 `exec` 呼び出し数 |        `32` |       `256` |
| Program全体の時間           | `120000 ms` | `300000 ms` |
| QuickJSメモリ               |    `64 MiB` |   `256 MiB` |
| `finish(value)`のJSONサイズ |    `64 KiB` |     `1 MiB` |

対応するフィールド名は `defaultProgramMaxExecCalls`、
`absoluteProgramMaxExecCalls`、`defaultProgramTimeoutMs`、
`absoluteProgramTimeoutMs`、`defaultProgramMemoryBytes`、
`absoluteProgramMemoryBytes`、`defaultProgramMaxReturnBytes`、
`absoluteProgramMaxReturnBytes` です。

### コマンドと環境

| フィールド                     | 既定値              | 意味                               |
| ------------------------------ | ------------------- | ---------------------------------- |
| `inheritExecutablePath`        | `true`              | 親 `PATH` を実行ファイル探索に使う |
| `trustedExecutableDirectories` | 未指定              | 探索ディレクトリを明示する         |
| `commandMode`                  | `"denylist"`        | 未登録コマンドを原則許可する       |
| `deniedCommands`               | 権限昇格コマンド5件 | 追加で拒否する実行ファイル名       |
| `commands`                     | `{}`                | 実行ファイルごとの任意の追加規則   |
| `readOnly`                     | `false`             | 宣言ベースの読み取り専用判定       |
| `allowedEnvironmentKeys`       | `[]`                | Tool Inputから渡せる環境変数名     |
| `logLevel`                     | `"info"`            | stderr JSONLのログレベル           |
| `legacyTools`                  | `false`             | 0.x互換Toolを公開する              |

カスタムポリシーでは `commandMode: "allowlist"` や `readOnly: true` を指定して
権限を狭められます。これは別の起動モードではなく、一つのサーバーに対する管理者設定です。

`commands` の各規則では `allowed`、絶対 `path`、`allowedSubcommands`、`readOnly`
を設定できます。`allowedSubcommands` は最初の引数だけを検査します。サーバーは
一般の引数を意味解析せず、そのまま実行ファイルへ渡します。

子プロセス環境は引き続き最小構成です。Tool Inputからの環境変数追加は
`allowedEnvironmentKeys` に列挙した名前だけを許可し、loader、認証情報、proxy、
`PATH`などの高リスクキーは組み込み規則で拒否します。

## 4. パス解決

Tool Inputの `cwd` は、存在するディレクトリであり、`realpath`でsymlinkを解決した
後にいずれかの `workspaceRoots` 内でなければなりません。相対 `cwd` は最初のroot
から解決します。

この制約は作業ディレクトリだけに適用されます。許可されたruntime、shell、Docker、
その他のCLIによるファイル・ネットワーク・外部サービス操作をsandbox化しません。

実行ファイルは単純名で指定し、信頼済みディレクトリから解決します。絶対パスを
使う必要があるカスタムコマンドは `commands.*.path` に管理者が設定します。

## 5. 起動時検証

- ポリシーJSONが構文的・型的に正しい
- 未知フィールドがない
- 既定値が対応する絶対上限以下
- workspace rootと明示ディレクトリが存在する
- 信頼済み実行ファイルディレクトリが一つ以上使える

ポリシー拒否は同じ入力で再試行しても変わりません。入力を変更するか、必要なら
カスタムポリシーを見直してください。
