#!/bin/bash
# pi-agent-teams wrapper v3 (M2) — the pane-side process of a farm task.
#
# Launches an INTERACTIVE pi TUI with the task prompt as its initial message,
# watches the session jsonl for completion (model replied + idle 5s) and, on
# completion, writes the done file, kills the pi process tree and exits
# immediately (WezTerm closes the pane when this process exits — no countdown).
#
# Contract (env-only, 15 variables; positional args abolished):
#   PI_AGENT_TEAMS_TASK_ID  task id; also used to read the task record for the prompt
#   PI_AGENT_TEAMS_DEPTH    depth of this pane process（main=缺省0；1=depth-1 角色 agent；
#                    2=depth-2 worker；wrapper 透传不消费，pane 内进程读之知自身深度）
#   DONE_FILE        status/<id>.done — JSON {exitCode, sessionDir}
#   ABORT_FILE       status/<id>.aborted — marker file, content ignored
#   SESS_DIR         pi session dir (--session-dir)
#   TITLE            pane title
#   CWD              working dir
#   PANE=1           pane marker (wrapper guarantees PI_AGENT_TEAMS_PANE=1 for pi)
#   PERSONA_FILE     persona body for --append-system-prompt (may be empty)
#   PI_BIN           pi invocation path (injected by the main session, single
#                    source of truth; falls back to `command -v pi` when empty)
#   PI_SCRIPT        cli script path for node-style invocation (optional, already
#                    absolutized by the main session)
#   PI_NODE          node 二进制（注入自主会话 process.execPath；空则回退 command -v node）
#   PI_AGENT_TEAMS_FORM     "tui" (default) | "worker" — worker = B 形态状态窗口
#   PI_RENDERER      render-mini.ts 绝对路径（worker 形态渲染器，票 06）
#   PI_AGENT_TEAMS_RESUME   resume session id（非空则 resume，否则新起 prompt；由 main 从
#                    payload.spawn.resumeFrom 注入）
#
# usage sidecar（票 06，FR7）：wrapper 是 usage 唯一写者，写 <FARM_DIR>/usage/<taskId>.json
# = {model,inputTokens,outputTokens,updatedAt}（tmp+mv 原子；每条 done 路径先于 write_done）。
#
# Initial task prompt = payload.spawn.prompt of the task record
# (<farm>/tasks/<PI_AGENT_TEAMS_TASK_ID>.json — written by the queue BEFORE spawn,
# single source of truth). No .hb heartbeat is written (M2 dropped it; liveness
# probing on the main side goes through `wezterm cli list`).
set -u

# ── env validation (fail fast: without these nothing can be signalled) ────
for v in PI_AGENT_TEAMS_TASK_ID DONE_FILE ABORT_FILE SESS_DIR TITLE CWD; do
  if [ -z "${!v:-}" ]; then
    echo "pi-agent-teams wrapper: missing env $v" >&2
    exit 2
  fi
done

# PI_NODE 解析（票 09 #1）：node 二进制单点真源——注入自主会话 process.execPath，
# 空则回退 command -v node（老契约/手工运行兼容）。
if [ -z "${PI_NODE:-}" ]; then
  PI_NODE="$(command -v node 2>/dev/null || true)"
fi

# B 形态 fail-fast（backend#8，票 06；评审 R#1/R#4；票 09 #3 含 /dev/tty 守卫）：trap
# 注册前校验，exit 2 不被 on_exit 覆盖为 exit 1 + aborted（配置错误不应落「中止」语义）；
# 缺 PI_RENDERER（文件存在）/ node（PI_NODE 空或不可执行）/ /dev/tty → exit 2 + stderr，
# 零 aborted 文件。
if [ "${PI_AGENT_TEAMS_FORM:-tui}" = "worker" ]; then
  if [ -z "${PI_RENDERER:-}" ] || [ ! -f "${PI_RENDERER}" ] || [ -z "$PI_NODE" ] || [ ! -x "$PI_NODE" ]; then
    echo "pi-agent-teams wrapper: B 形态需要 PI_RENDERER（文件存在）与 node（缺失则无法启动渲染器）" >&2
    exit 2
  fi
  if [ ! -e /dev/tty ]; then
    echo "pi-agent-teams wrapper: B 形态需要 /dev/tty（无 tty 环境 < /dev/tty 静默失败）" >&2
    exit 2
  fi
fi

# The pane-side extension checks PI_AGENT_TEAMS_PANE=1 (PRD §13.3) — guarantee it.
export PI_AGENT_TEAMS_PANE=1

mkdir -p "$(dirname "$DONE_FILE")" "$(dirname "$ABORT_FILE")" 2>/dev/null || true

cd "$CWD" 2>/dev/null || cd "$HOME"

# task record: single source of truth for the prompt (written before spawn).
FARM_DIR="$(dirname "$(dirname "$DONE_FILE")")"
TASK_RECORD="$FARM_DIR/tasks/$PI_AGENT_TEAMS_TASK_ID.json"

# ── process-tree teardown ─────────────────────────────────────────────────
# Recursively terminate pi and its tool children (defined before on_exit so a
# signal at any moment can clean up).
kill_tree() {
  local pid="$1"
  local children
  children="$(pgrep -P "$pid" 2>/dev/null)"
  for c in $children; do
    kill_tree "$c"
  done
  kill -TERM "$pid" 2>/dev/null
}

# 收尸兜底②（B 形态，backend#2 实测前提）：渲染器被 kill -9 成 zombie 后，pi 被
# reparent 到 launchd，kill_tree(渲染器 pid) 找不到 pi → 按 --session-dir 全出口
# pkill 扫尾（auto_done 写 done 前 / 非 auto_done 写 done/ABORT 前 / on_exit trap 内）。
pkill_headless() {
  # 票 09 #2（BE#8）：-f 按 ERE 匹配，SESS_DIR 含 `.`（~/.pi-agent-teams/...）被当通配符
  # → 误杀相邻进程假阳性。转义 ERE 元字符（`. [ * ^ $ ( ) + ? { |`；路径形状下实际
  # 只有 `.` 出现，覆盖路径形状实际出现的元字符（. 等））。`-U "$(id -u)"` 已存在（backend#2），勿重复加。
  local sess_pat
  sess_pat="$(printf '%s' "$SESS_DIR" | sed 's/[.[\*^$()+?{|]/\\&/g')"
  pkill -f -U "$(id -u)" -- "--session-dir $sess_pat" 2>/dev/null || true
}

# ── aborted fallback ──────────────────────────────────────────────────────
# Pane closed (SIGHUP) / TERM / INT / abnormal exit: if done was never
# written, mark aborted so the main side returns promptly. Exit immediately —
# bash would otherwise resume the script after a signal trap and could later
# write done, leaving done+aborted co-existing.
on_exit() {
  if [ -n "${PI_PID:-}" ]; then
    kill_tree "$PI_PID" 2>/dev/null
  fi
  if [ "${PI_AGENT_TEAMS_FORM:-tui}" = "worker" ]; then
    pkill_headless
  fi
  if [ ! -f "$DONE_FILE" ] && [ ! -f "$ABORT_FILE" ]; then
    printf 'aborted %s\n' "$(date +%s)" > "$ABORT_FILE" 2>/dev/null || true
    exit 1
  fi
}
trap on_exit EXIT HUP TERM INT

# ── done file (shape must match store.parseDoneFile) ──────────────────────
write_done() {
  local code="$1"
  local sess_json
  sess_json="$(printf '%s' "$SESS_DIR" | sed 's/\\/\\\\/g; s/"/\\"/g')"
  # atomic: same-dir tmp + mv (torn-write guard lives on the read side)
  printf '{"exitCode":%s,"sessionDir":"%s"}\n' "$code" "$sess_json" > "$DONE_FILE.tmp" \
    && mv "$DONE_FILE.tmp" "$DONE_FILE" \
    || echo "⚠️ cannot write done file: $DONE_FILE" >&2
}

# ── usage sidecar（票 06，FR7）：wrapper 是 usage 唯一写者 ──────────────────
# 从最新 session jsonl 提取最后一条 message.usage（input/output/model）→ 原子写
# <FARM_DIR>/usage/<taskId>.json = {model,inputTokens,outputTokens,updatedAt}。
# mkdir 由本函数负责（BE#4：最终写必须先于 write_done，tmp+mv 原子）。
write_usage() {
  [ -n "${PI_NODE:-}" ] || return 0
  local latest line out
  latest="$(ls -t "$SESS_DIR"/*.jsonl 2>/dev/null | head -1)"
  [ -n "$latest" ] || return 0
  line="$(grep -h '"usage"' "$latest" 2>/dev/null | tail -1)"
  [ -n "$line" ] || return 0
  out="$(printf '%s' "$line" | "$PI_NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);const m=o&&o.message,u=m&&m.usage;if(m&&u&&typeof u.input==="number"&&Number.isFinite(u.input)&&typeof u.output==="number"&&Number.isFinite(u.output)){process.stdout.write(JSON.stringify({model:typeof m.model==="string"?m.model:"",inputTokens:u.input,outputTokens:u.output,updatedAt:Date.now()}))}}catch(e){}})' 2>/dev/null)"
  [ -n "$out" ] || return 0
  mkdir -p "$FARM_DIR/usage" 2>/dev/null || return 0
  printf '%s\n' "$out" > "$FARM_DIR/usage/$PI_AGENT_TEAMS_TASK_ID.json.tmp" \
    && mv "$FARM_DIR/usage/$PI_AGENT_TEAMS_TASK_ID.json.tmp" "$FARM_DIR/usage/$PI_AGENT_TEAMS_TASK_ID.json" \
    || return 0
}

# ── result sidecar（票 03，sync 等待）：wrapper 是 .result 唯一写者 ──────────
# 从最新 session jsonl 提取最后一条 assistant text（锚定 type=message + role=assistant
# + content[].type=text，评审 R2——message_update delta 与 message_end 权威全文并存时
# 只取权威全文，不取 delta 残片）→ 截断 8KB → 连同 sha256（jsonl 全文哈希）原子写
# <FARM_DIR>/status/<taskId>.result = {exitCode, sessionDir, summary, sha256, writtenAt}。
# 每条 done 路径在 write_done 之前调用（BE#4 写序：write_usage → write_result → write_done）。
write_result() {
  local code="$1"
  [ -n "${PI_NODE:-}" ] || return 0
  local latest out
  latest="$(ls -t "$SESS_DIR"/*.jsonl 2>/dev/null | head -1)"
  [ -n "$latest" ] || return 0
  out="$(RESULT_CODE="$code" RESULT_SESS="$SESS_DIR" "$PI_NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const lines=s.split("\n");let best="";for(const l of lines){let r;try{r=JSON.parse(l)}catch(e){continue}if(r&&r.type==="message"&&r.message&&r.message.role==="assistant"&&Array.isArray(r.message.content)){const t=r.message.content.filter(p=>p&&p.type==="text"&&typeof p.text==="string").map(p=>p.text);if(t.length)best=t.join("\n")}}const c=require("node:crypto");const sha=c.createHash("sha256").update(s).digest("hex");process.stdout.write(JSON.stringify({exitCode:Number(process.env.RESULT_CODE||0),sessionDir:process.env.RESULT_SESS||"",summary:best.slice(0,8192),sha256:sha,writtenAt:Date.now()}))}catch(e){}})' < "$latest")"
  [ -n "$out" ] || return 0
  mkdir -p "$FARM_DIR/status" 2>/dev/null || return 0
  printf '%s\n' "$out" > "$FARM_DIR/status/$PI_AGENT_TEAMS_TASK_ID.result.tmp" \
    && mv "$FARM_DIR/status/$PI_AGENT_TEAMS_TASK_ID.result.tmp" "$FARM_DIR/status/$PI_AGENT_TEAMS_TASK_ID.result" \
    || return 0
}

# ── B 形态（worker）分支（票 06）───────────────────────────────────────────
# worker：渲染器接管 pane 面（状态条 + 滚动输出 + 输入行），wrapper 只做监督链
# （jsonl watchdog 判 done + aborted trap + kill-tree + 收尸）。headless pi 由渲染
# 器 spawn，PI_PID 指向渲染器进程；渲染器退出码 = pi 退出码（或 130=crtl+C abort）。
if [ "${PI_AGENT_TEAMS_FORM:-tui}" = "worker" ]; then
  # 渲染器作后台子进程（stdin 绑 pane tty——非交互 bash 后台任务 stdin 会被重定向
  # /dev/null，渲染器收不到打字；pi 本身不需要 tty，pipe stdio 由渲染器给）。
  # 带 --disable-warning 防 node 22 type-stripping 警告污染渲染面（backend#10：
  # ExperimentalWarning + MODULE_TYPELESS_PACKAGE_JSON——零 package.json 下 .ts 直接
  # 跑必触发的 MODULE_TYPELESS 警告也一并吞）。严禁 exec——exec 会用渲染器替换
  # wrapper shell，watchdog/写 done/写 aborted/收尸全部消失。
  "$PI_NODE" --disable-warning=ExperimentalWarning --disable-warning=MODULE_TYPELESS_PACKAGE_JSON "$PI_RENDERER" < /dev/tty &
  PI_PID=$!

  POLL_SECS=5
  IDLE_CHECKS=1        # 1 × 5s = 5s 静默后判 done
  auto_done=0
  prev_size=-1
  idle=0
  while kill -0 "$PI_PID" 2>/dev/null; do
    sleep "$POLL_SECS"
    # zombie 判定（backend#2）：渲染器被 kill -9 成 zombie 时 kill -0 仍成功，
    # watchdog 会卡死 → 检测到 Z 即退出循环走非 auto_done 路径。
    stat="$(ps -o stat= -p "$PI_PID" 2>/dev/null | tr -d ' ')"
    if [ -n "$stat" ] && [ "$(printf '%s' "$stat" | cut -c1)" = "Z" ]; then
      break
    fi
    latest="$(ls -t "$SESS_DIR"/*.jsonl 2>/dev/null | head -1)"
    if [ -z "$latest" ]; then
      prev_size=-1
      continue
    fi
    new_size="$(wc -c < "$latest" 2>/dev/null | tr -d ' ')"
    last="$(tail -1 "$latest" 2>/dev/null)"
    write_usage
    if [ -n "$last" ] && [ "$new_size" = "$prev_size" ] \
      && printf '%s' "$last" | grep -q '"stopReason":"stop"' \
      && ! printf '%s' "$last" | grep -q '"type":"toolCall"'; then
      idle=$((idle + 1))
      if [ "$idle" -ge "$IDLE_CHECKS" ]; then
        auto_done=1
        break
      fi
    else
      idle=0
    fi
    prev_size="$new_size"
  done

  if [ "$auto_done" = "1" ]; then
    # jsonl 判 done → 写 usage → pkill 收尸（jsonl 定型）→ 写 result → 写 done → kill 渲染器树
    write_usage
    pkill_headless
    write_result 0
    write_done 0
    kill_tree "$PI_PID" 2>/dev/null
    exit 0
  else
    # 渲染器自行退出（pi 退出 / ctrl+C abort / 崩溃）
    wait "$PI_PID" 2>/dev/null
    code=$?
    pkill_headless
    if [ "$code" = "130" ]; then
      # ctrl+C abort（渲染器 readline SIGINT → 树杀 pi → exit 130）：写 ABORT_FILE 非 done
      printf 'aborted %s\n' "$(date +%s)" > "$ABORT_FILE" 2>/dev/null || true
      exit 130
    else
      write_usage
      write_result "$code"
      write_done "$code"
      exit 0
    fi
  fi
fi

# 票 09 #5（BE#9）：TITLE 派生自 prompt，含 \x07/ESC/换行即逃逸出 OSC title。
# 剥 C0 控制符 + DEL + 截断 100（与渲染器 sanitizeTitle 同口径）。
TITLE_SAFE="$(printf '%s' "$TITLE" | tr -d '\000-\037\177' | cut -c1-100)"
printf '\033]0;⏳ %s\007' "$TITLE_SAFE"
echo "── pi-agent-teams 任务 [$PI_AGENT_TEAMS_TASK_ID] — $TITLE_SAFE ──"
echo "👀 交互式 TUI：可随时打字与角色 agent 对话；模型回复完并静止 5s 后自动完成并汇报"
echo ""

# ── pi binary + launch args ───────────────────────────────────────────────
# PI_BIN/PI_SCRIPT 由主会话注入（与其探测同源，单点真源；非 login PATH 差异下
# pane 仍与主会话同 pi）；缺省回退自探测（老契约/手工运行兼容）。
if [ -z "${PI_BIN:-}" ]; then
  PI_BIN="$(command -v pi 2>/dev/null || true)"
fi
if [ -z "$PI_BIN" ]; then
  echo "❌ pi 二进制未找到（PI_BIN 未注入且 command -v pi 为空）" >&2
  exit 1
fi

# initial message + role name: payload.spawn.{prompt,role} from the task record.
# NUL-delimited output so multi-line prompts survive; role feeds pi's --name
# (PRD §13.1 D8 — empty/missing role means no --name).
msg=""
role=""
if [ -f "$TASK_RECORD" ] && [ -n "$PI_NODE" ]; then
  {
    IFS= read -r -d '' msg
    IFS= read -r -d '' role
  } < <("$PI_NODE" -e 'const fs=require("fs");try{const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const s=(r&&r.payload&&r.payload.spawn)||{};const p=typeof s.prompt==="string"?s.prompt:"";const ro=typeof s.role==="string"?s.role.trim():"";process.stdout.write(p+"\0"+ro)}catch(e){process.stdout.write("\0")}' "$TASK_RECORD" 2>/dev/null)
fi
if [ -z "$msg" ]; then
  echo "⚠️ 未从 task record 读取到任务提示（$TASK_RECORD），以空会话启动" >&2
fi
# Defend against pi CLI treating a leading "-"/"@" as a flag/file ref.
case "$msg" in
  -*) msg=" $msg" ;;
  @*) msg=" $msg" ;;
esac

mkdir -p "$SESS_DIR"

pi_args=()
if [ -n "${PI_AGENT_TEAMS_RESUME:-}" ]; then
  # 票 08 resume：--session 替代 prompt（不注入 prompt/persona；D8 人设只在新建会话注入）
  pi_args+=(--session-dir "$SESS_DIR" --session "$PI_AGENT_TEAMS_RESUME")
else
  if [ -n "${PERSONA_FILE:-}" ]; then
    if [ -f "$PERSONA_FILE" ]; then
      pi_args+=(--append-system-prompt "$PERSONA_FILE")
    else
      echo "⚠️ PERSONA_FILE 不存在，跳过人设注入: $PERSONA_FILE" >&2
    fi
  fi
  [ -n "$role" ] && pi_args+=(--name "$role")
  [ -n "$msg" ] && pi_args+=("$msg")
  pi_args+=(--session-dir "$SESS_DIR")
fi

# CRITICAL: in a non-interactive bash, background jobs get stdin redirected
# to /dev/null and pi would detect non-interactive stdin and exit right after
# one turn. Bind stdin to the pane pty. Without a tty on stdin (abnormal
# context) inherit stdin instead of failing the redirection.
launch_pi() {
  if [ -n "${PI_SCRIPT:-}" ]; then
    "$PI_BIN" "$PI_SCRIPT" "$@"
  else
    "$PI_BIN" "$@"
  fi
}
if [ -t 0 ]; then
  launch_pi "${pi_args[@]}" < /dev/tty &
else
  launch_pi "${pi_args[@]}" &
fi
PI_PID=$!

# ── completion watchdog ───────────────────────────────────────────────────
# Done when the session file stops growing AND the last event is a finished
# assistant reply (stopReason=stop, no pending tool call). User messages
# change the file size and reset the counter, so interactive chatting keeps
# the pane alive.
POLL_SECS=5
IDLE_CHECKS=1        # 1 × 5s = 5s of quiet after a finished reply
auto_done=0
prev_size=-1
idle=0
while kill -0 "$PI_PID" 2>/dev/null; do
  sleep "$POLL_SECS"
  latest="$(ls -t "$SESS_DIR"/*.jsonl 2>/dev/null | head -1)"
  if [ -z "$latest" ]; then
    prev_size=-1
    continue
  fi
  new_size="$(wc -c < "$latest" 2>/dev/null | tr -d ' ')"
  last="$(tail -1 "$latest" 2>/dev/null)"
  write_usage
  if [ -n "$last" ] && [ "$new_size" = "$prev_size" ] \
    && printf '%s' "$last" | grep -q '"stopReason":"stop"' \
    && ! printf '%s' "$last" | grep -q '"type":"toolCall"'; then
    idle=$((idle + 1))
    if [ "$idle" -ge "$IDLE_CHECKS" ]; then
      auto_done=1
      echo ""
      echo "✅ 角色 agent 已回复完成，自动结束（如需继续对话请勿停顿超过 5s）"
      break
    fi
  else
    idle=0
  fi
  prev_size="$new_size"
done

if [ "$auto_done" = "1" ]; then
  # 判 done → 写 usage → 写 result → 写 done 文件 → kill pi 进程树 → 立即 exit（无 countdown）
  write_usage
  write_result 0
  write_done 0
  kill_tree "$PI_PID" 2>/dev/null
else
  # pi 自行退出（/exit 或异常）：写 usage → 按真实退出码写 result + done
  wait "$PI_PID" 2>/dev/null
  code=$?
  write_usage
  write_result "$code"
  write_done "$code"
fi
exit 0
