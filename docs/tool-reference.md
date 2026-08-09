# MCP ツールリファレンス

既定の公開面は `exec` と `exec_program` の二つです。どちらも同じサーバーポリシーとプロセスランナーを使い、シェル文字列は受け付けません。

## 目次

- [1. 共通ルール](#1-共通ルール)
- [2. exec](#2-exec)
- [3. exec の結果](#3-exec-の結果)
- [4. exec_program](#4-exec_program)
- [5. QuickJS ゲスト API](#5-quickjs-ゲスト-api)
- [6. エラー](#6-エラー)
- [7. 出力 Resource](#7-出力-resource)
- [8. レガシー Tool](#8-レガシー-tool)

## 1. 共通ルール

1. コマンドは `argv` 配列で渡す。`"git status && npm test"` のようなシェル文字列は使わない。
2. `argv[0]` は実行ファイル名であり、サーバーポリシーと信頼済みディレクトリで解決される。
3. 対話入力、TTY、標準入力、バックグラウンドデーモンは扱わない。
4. `cwd` は許可された workspace root 内の既存ディレクトリに限定される。
5. クライアントが要求する並列数、タイムアウト、出力量はサーバー上限以下でなければならない。
6. すべての OS 子プロセスは、サーバー全体の FIFO 同時実行制限を共有する。
7. ポリシー拒否は同じ入力で再試行せず、入力または管理者設定を変更する。

## 2. `exec`

独立コマンドと静的 DAG を一つのリクエストで実行します。

### 2.1 入力

| フィールド     | 必須   | 型                       | 意味                                         |
| -------------- | ------ | ------------------------ | -------------------------------------------- |
| `steps`        | はい   | step[]                   | 1〜256 個。ただし実際の上限は `maxBatchSize` |
| `concurrency`  | いいえ | integer                  | リクエスト内の最大同時実行数                 |
| `failure_mode` | いいえ | `continue` / `fail_fast` | 失敗後に独立枝を続けるか                     |
| `output`       | いいえ | object                   | 出力の射影とバイト上限                       |

### 2.2 step

| フィールド   | 必須   | 型       | 意味                                |
| ------------ | ------ | -------- | ----------------------------------- |
| `id`         | はい   | string   | リクエスト内で一意なステップ ID     |
| `argv`       | はい   | string[] | 実行ファイル名を先頭にした引数配列  |
| `cwd`        | いいえ | string   | workspace root 内の作業ディレクトリ |
| `timeout_ms` | いいえ | integer  | このステップだけの期限              |
| `env`        | いいえ | object   | ポリシーが許可したキーだけを渡す    |
| `depends_on` | いいえ | string[] | このステップより先に成功すべき ID   |

`depends_on` は順序を固定したいだけの理由で増やさず、データ依存または同じ変更対象の競合がある場合だけ指定します。不要な依存は並列性を失わせます。

### 2.3 output

| フィールド         | 既定                         | 意味                                        |
| ------------------ | ---------------------------- | ------------------------------------------- |
| `mode`             | ポリシー既定、通常 `compact` | 空・0 値を省略するか、全フィールドを返すか  |
| `max_total_bytes`  | `defaultMaxTotalOutputBytes` | 全ステップの stdout / stderr に配る合計予算 |
| `max_stream_bytes` | `defaultMaxOutputBytes`      | stdout または stderr 一本の希望上限         |
| `capture`          | `head_tail`                  | `head` または先頭と末尾を残す `head_tail`   |
| `strip_ansi`       | `true`                       | ANSI / OSC 制御列を除去するか               |

実際のストリーム上限は、`max_stream_bytes` と公平配分値 `floor(max_total_bytes / (steps.length * 2))` の小さい方です。

### 2.4 独立コマンド

```json
{
  "steps": [
    { "id": "status", "argv": ["git", "status", "-sb"] },
    { "id": "files", "argv": ["rg", "--files", "src"] },
    { "id": "package", "argv": ["cat", "package.json"] }
  ],
  "concurrency": 3,
  "failure_mode": "continue",
  "output": { "mode": "compact" }
}
```

依存がないため、三つは同時に ready になります。

### 2.5 静的 DAG

```json
{
  "steps": [
    {
      "id": "typecheck",
      "argv": ["npm", "run", "typecheck"]
    },
    {
      "id": "build",
      "argv": ["npm", "run", "build"],
      "depends_on": ["typecheck"]
    },
    {
      "id": "test",
      "argv": ["npm", "test"],
      "depends_on": ["build"]
    },
    {
      "id": "lint",
      "argv": ["npm", "run", "lint"]
    }
  ],
  "concurrency": 2,
  "failure_mode": "fail_fast",
  "output": {
    "mode": "compact",
    "capture": "head_tail",
    "max_total_bytes": 131072
  }
}
```

`lint` と `typecheck` は独立に開始できます。`build` は `typecheck` の成功後、`test` は `build` の成功後にだけ開始します。

同じ `dist/` を更新するコマンドや、順序が必要な Git 書き込みは、必ず `depends_on` で直列化してください。

## 3. `exec` の結果

### 3.1 全体

| フィールド    | 意味                                  |
| ------------- | ------------------------------------- |
| `request_id`  | サーバーが付与した UUID               |
| `output_mode` | 実際に使った `compact` または `debug` |
| `results`     | 入力 `steps` と同じ順の結果           |
| `summary`     | 状態別件数、時間、同時実行統計        |

### 3.2 ステップ結果

| フィールド                              | 意味                                                                              |
| --------------------------------------- | --------------------------------------------------------------------------------- |
| `id`                                    | 入力のステップ ID                                                                 |
| `status`                                | `success`、`failed`、`timeout`、`cancelled`、`skipped`、`rejected`、`spawn_error` |
| `exit_code`                             | OS 終了コード。compact では null / 0 を省略                                       |
| `signal`                                | 終了シグナル。debug で確認可能                                                    |
| `stdout` / `stderr`                     | 境界内に取得したテキスト                                                          |
| `stdout_bytes` / `stderr_bytes`         | 実際に流れた総バイト数                                                            |
| `stdout_truncated` / `stderr_truncated` | 返却テキストを切り詰めたか                                                        |
| `duration_ms`                           | ポリシー準備後のコマンド実行時間                                                  |
| `error`                                 | timeout、cancel、spawn などの説明                                                 |
| `rejection_reason`                      | ポリシー拒否の機械判定コード                                                      |
| `global_queue_wait_ms`                  | サーバー全体の許可を待った時間                                                    |
| `depends_on`                            | 宣言された依存先                                                                  |
| `blocked_by`                            | 失敗してこのステップを止めた依存先                                                |
| `stdout_resource` / `stderr_resource`   | 短期保持された出力 Resource URI                                                   |

compact モードでは、意味のない空値や 0 値を省略します。

### 3.3 compact の例

```json
{
  "request_id": "9ab68a3d-92c4-4ca2-9836-18fd1382fb2f",
  "output_mode": "compact",
  "results": [
    {
      "id": "status",
      "status": "success",
      "stdout": "## main...origin/main\n",
      "duration_ms": 21
    },
    {
      "id": "test",
      "status": "failed",
      "exit_code": 1,
      "stderr": "2 tests failed\n",
      "duration_ms": 1032
    },
    {
      "id": "build",
      "status": "skipped",
      "duration_ms": 0,
      "error": "Dependency did not succeed: test",
      "depends_on": ["test"],
      "blocked_by": ["test"]
    }
  ],
  "summary": {
    "total": 3,
    "succeeded": 1,
    "failed": 1,
    "skipped": 1,
    "wall_time_ms": 1060,
    "effective_concurrency": 2,
    "peak_concurrency": 2,
    "global_peak_concurrency": 4
  }
}
```

## 4. `exec_program`

前の出力を使って次の `argv`、分岐、繰り返しを決めるときに使います。

### 4.1 入力

| フィールド            | 必須   | 型       | 意味                                            |
| --------------------- | ------ | -------- | ----------------------------------------------- |
| `source`              | はい   | string   | 最大 256 KiB の ECMAScript 本文                 |
| `allowed_executables` | はい   | string[] | この Program が要求できる実行ファイル名。1〜256 |
| `cwd`                 | いいえ | string   | Program 内 `exec` の共通既定 cwd                |
| `limits`              | いいえ | object   | Program 呼び出し固有の上限                      |

`allowed_executables` はサーバーポリシーを広げません。両方に許可された場合だけ実行されます。

### 4.2 limits

| フィールド         | 意味                                     |
| ------------------ | ---------------------------------------- |
| `max_exec_calls`   | Program 内から要求できる `exec` の総回数 |
| `max_concurrency`  | Program 内の同時ホスト実行数             |
| `timeout_ms`       | Program 全体の期限                       |
| `memory_bytes`     | QuickJS ランタイムのメモリ上限           |
| `max_return_bytes` | `finish(value)` を JSON 化した最大サイズ |

すべてポリシー既定値があり、クライアントはポリシーの絶対上限を超えられません。

### 4.3 動的なファイル処理

Tool Input の `source` に、次の ECMAScript を渡す例です。

```javascript
const listed = await exec(["rg", "--files", "src"]);
if (listed.status !== "success") {
  finish({ error: listed.error ?? listed.stderr });
} else {
  const files = lines(listed).filter((path) => path.endsWith(".ts"));
  const counts = await parallel(
    files.map((path) => async () => {
      const result = await exec(["wc", "-l", path]);
      return { path, status: result.status, output: result.stdout.trim() };
    }),
    4,
  );
  finish({ file_count: files.length, counts });
}
```

対応する Tool Input の外側は次の通りです。

```json
{
  "source": "<上記の ECMAScript>",
  "allowed_executables": ["rg", "wc"],
  "cwd": ".",
  "limits": {
    "max_exec_calls": 64,
    "max_concurrency": 4,
    "timeout_ms": 30000,
    "max_return_bytes": 131072
  }
}
```

ファイル名は最初の `rg` の出力から決まるため、開始時点で静的 DAG にできません。中間結果をモデルへ返さず、Program 内で後続の `argv` を構築します。

## 5. QuickJS ゲスト API

### 5.1 `exec(argv, options?)`

```javascript
const result = await exec(["git", "status", "-sb"], {
  cwd: ".",
  timeout_ms: 10000,
});
```

`options` で指定できるのは `cwd` と `timeout_ms` だけです。Program から環境変数は渡せません。戻り値は `exec` の一ステップと同じ `CommandResult` です。

### 5.2 `lines(value)`

```javascript
const paths = lines(await exec(["rg", "--files", "src"]));
```

文字列、または `stdout` を持つ結果を行配列へ変換します。行末の改行で空になった最後の要素は残しません。

### 5.3 `parallel(operations, concurrency?)`

関数配列または argv 配列を、指定並列数まで実行します。結果は完了順ではなく入力順です。

```javascript
const results = await parallel(
  [
    ["git", "status", "-sb"],
    ["rg", "--files", "src"],
  ],
  2,
);
```

関数を使うと、個別の後処理を含められます。

### 5.4 `finish(value)`

```javascript
finish({ ok: true, count: 3 });
```

- 必ず一回だけ呼ぶ
- JSON serializable な値を渡す
- 未完了の `exec` がある間は呼ばない
- Program が `finish` なしで終了するとエラー
- JSON 化後のサイズが `max_return_bytes` 以下であること

## 6. エラー

### 6.1 Tool Call 全体のエラー

Tool Input が不正、または Program 全体が成立しない場合、MCP の `isError: true` と次の形を返します。

```json
{
  "error": {
    "code": "invalid_input",
    "message": "Input exceeds server policy limits",
    "issues": ["concurrency: 32 exceeds server limit 16"]
  }
}
```

代表的なコードは次の通りです。

| code               | 意味                                        |
| ------------------ | ------------------------------------------- |
| `invalid_input`    | strict schema、DAG、サーバー上限の違反      |
| `execution_failed` | Program の評価、`finish`、JSON 化などの失敗 |
| `timeout`          | Program 全体の期限超過                      |
| `memory_limit`     | QuickJS のメモリ上限                        |
| `result_too_large` | `finish(value)` が返却量上限を超過          |
| `internal_error`   | 詳細を外部へ出さない内部エラー              |

### 6.2 ステップ単位の拒否

コマンドポリシー違反は Tool Call 全体を失敗させず、そのステップを `rejected` にします。

```json
{
  "id": "outside",
  "status": "rejected",
  "duration_ms": 0,
  "error": "The requested working directory is outside the allowed workspace roots",
  "rejection_reason": "cwd_outside_workspace"
}
```

`continue` なら独立ステップは進み、拒否ステップに依存する子孫は `skipped` になります。

## 7. 出力 Resource

`persistTruncatedOutput: true` のとき、切り詰めた結果に次のような URI が付く場合があります。

```json
{
  "stdout_truncated": true,
  "stdout_bytes": 842193,
  "stdout_resource": "os-exec-output:///3b3bc7ef-5df6-4d48-a1c6-c158828ff810"
}
```

MCP の Resource Read で URI を取得すると、本文と次のメタデータを返します。

- `total_bytes`
- `retained_bytes`
- `truncated`
- `expires_at`

Resource が付かない場合は、永続化が無効、保持量上限に到達、または TTL 切れです。Resource は再実行キャッシュではありません。

## 8. レガシー Tool

`legacyTools: true` の場合だけ `batch_exec` と `workflow_exec` を追加公開します。

- `batch_exec`: 全コマンドを依存なしの `exec.steps` へ変換
- `workflow_exec`: `commands[].depends_on` を `exec.steps[].depends_on` へ変換

内部スケジューラーは共通です。新規クライアントは `exec` を使い、レガシー Tool の入力形式へ依存しないでください。
