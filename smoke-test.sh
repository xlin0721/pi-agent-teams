#!/bin/bash
# pi-agent-teams v3 smoke test — real WezTerm + full v3 stack
# 驱动 = 专用测试窗口里的 pi TUI（cwd=$HOME 中性环境），经 wezterm send-text 发消息，
# 断言全部走文件协议（tasks/<id>.json / status / sessions / notifiedAt），零第三方依赖。
# FARM 语义：smoke 用独立根 ~/.pi-agent-teams/smoke-farm（=SMOKE_FARM），与开发环境隔离
# （工作区隔离 C1+C9 后 dev 任务落 cwd 派生 workspace；若 smoke 断言/清扫指向 dev 根会抓错文件）。
# driver 启动即注入 PI_AGENT_TEAMS_ROOT=$SMOKE_FARM（env 优先于 cwd 派生，见 src/workspace.ts）
# → driver 及其子代理任务全部落盘 smoke 根；断言/清扫/清理同指该根。
#
# 任务发现一律 id-diff：发任务前快照 tasks/*.json 的 id 集合，只认快照外的新 id。
# 严禁用文件计数/字母序推断新任务（ls 字母序≠时间序；多农场并存时计数会漂移，
# 曾导致抓陈旧文件、杀错 pane）。
#
# Usage: smoke-test.sh [timeout-secs]   （默认 180s；总时长约 16-20 分钟，Case6-11 新增约 11 分钟）
set -u

SMOKE_FARM="${HOME}/.pi-agent-teams/smoke-farm"   # smoke 独立根（隔离于开发环境，见头部注释）
FARM="$SMOKE_FARM"
EXT="$HOME/.pi/agent/extensions/pi-agent-teams"
TIMEOUT="${1:-180}"
FAIL=0

# ── 票07修复5：set -u 一次性根除（全局无条件初始化）───────────────
# 以下变量均存在「条件分支内赋值、分支外/后续引用」的执行路径（if/for/while/case 未走到
# 赋值即被引用 → unbound）。历史打地鼠：Case9 TQID8/TSID8 → Case8a PA/S → Case8b N。
# 根治法：所有此类变量在脚本头部无条件初始化（空串/0），任何分支组合下均有绑定值。
# 事实源唯一：新增 task_* 返回值承载变量（T1/T3/T4/T6/TA/TB/TF/TQ/TS/TG/TZ 及派生
# id/id8/状态/notifiedAt/pane 变量）必须在此登记，禁止只在分支内赋值后分支外引用。
S=""; P=""; N=""; SD=""; J=""; C=""
PA=""; P3=""; P4=""; PZ=""; PS=""; STILL=""; DSTILL=""
T1=""; T3=""; T4=""; T6=""; TA=""; TB=""; TF=""; TQ=""; TS=""; TG=""; TZ=""
T1ID=""; T3ID=""; T4ID=""; T6ID=""; T6ID8=""; TAID=""; TBID=""; TFID=""
TQID=""; TQID8=""; TSID=""; TSID8=""; TGID=""; TGID8=""; TZID=""
NEW=""; NEWN=0; RUN=0; Q=0; ALIVE=""; TXT=""; GONE=0
FOUND_S=0; FOUND_Q=1; FOUND_F=0; ALL=""; MAXR=0; DONEN=0; R=0; D=0
IDS=""; BASE=0; NOW=0; OUT=""; WIN_OUT=""; PKDIR=""

say()  { printf '%s\n' "$*"; }
fail() { say "❌ $*"; FAIL=1; }
pass() { say "✅ $*"; }

# JSON 字段读取（node -e，零依赖）
json_get() {
  node -e '
    const fs = require("fs");
    try {
      const o = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      let v = o;
      for (const k of process.argv[2].split(".")) v = v == null ? undefined : v[k];
      process.stdout.write(v === undefined || v === null ? "" : String(v));
    } catch { process.stdout.write(""); }
  ' "$1" "$2"
}

# 窗口内 pane 数（按 driver pane 所属 window 计）
win_panes() {
  wezterm cli --no-auto-start list --format json 2>/dev/null | node -e '
    const w = Number(process.argv[1]);
    let data = "";
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => {
      try {
        const panes = JSON.parse(data);
        const me = panes.find((p) => Number(p.pane_id) === w);
        if (!me) { console.log(-1); return; }
        console.log(panes.filter((p) => p.window_id === me.window_id).length);
      } catch { console.log(-1); }
    });
  ' "$1"
}

task_status()  { json_get "$1" "status"; }
task_paneid()  { json_get "$1" "payload.spawn.paneId"; }
task_notif()   { json_get "$1" "notifiedAt"; }
task_sessdir() { json_get "$1" "result.sessionDir"; }
task_exit()    { json_get "$1" "result.exitCode"; }

# ── id-diff 发现原语 ────────────────────────────────────────
# 快照当前 tasks/*.json 的 id 集合到文件
snapshot_ids() {
  local out="$1" f
  : > "$out"
  for f in "$FARM"/tasks/*.json; do
    [ -f "$f" ] || continue
    basename "$f" .json
  done | sort >> "$out"
}
# 首个不在基线快照内的任务文件路径（1s 轮询 ×60）
new_task_since() {
  local basefile="$1" f id
  for ((i=0; i<60; i++)); do
    for f in "$FARM"/tasks/*.json; do
      [ -f "$f" ] || continue
      id=$(basename "$f" .json)
      grep -qx "$id" "$basefile" 2>/dev/null || { printf '%s\n' "$f"; return 0; }
    done
    sleep 1
  done
  return 1
}
# 基线快照外的新任务文件（至多 $2 个）
collect_new() {
  local basefile="$1" max="$2" f id n=0
  for f in "$FARM"/tasks/*.json; do
    [ -f "$f" ] || continue
    id=$(basename "$f" .json)
    grep -qx "$id" "$basefile" 2>/dev/null || { printf '%s\n' "$f"; n=$((n + 1)); [ "$n" -ge "$max" ] && return 0; }
  done
}

DRIVER_PANE=""
DRIVER_PID=""
DRIVER_PID_FILE=""
cleanup() {
  # 先 SIGTERM driver pi（触发 session_shutdown 全 kill；先于 pane kill，防脱孤）
  [ -n "$DRIVER_PID" ] && kill -TERM "$DRIVER_PID" >/dev/null 2>&1 || true
  [ -n "$DRIVER_PANE" ] && wezterm cli kill-pane --pane-id "$DRIVER_PANE" >/dev/null 2>&1 || true
  if [ "$FAIL" = "1" ]; then
    # 失败保留任务文件/会话供诊断（下次运行 0.5 前置清扫回收）
    say "💾 smoke 失败：保留 tasks/status/sessions 现场供诊断"
  else
    for id in $SMOKE_TASKS; do
      # FARM=$SMOKE_FARM（smoke 根，与 driver 落盘根一致）
      rm -rf "$FARM/tasks/$id.json" "$FARM/status/$id.done" "$FARM/status/$id.aborted" "$FARM/sessions/$id" 2>/dev/null
    done
  fi
  rm -f "$DRIVER_PID_FILE" "${SNAP:-}" "$SNAP2" 2>/dev/null || true
}
trap cleanup EXIT
SMOKE_TASKS=""
SNAP=""
SNAP2=""

# ── 0. 前置 ────────────────────────────────────────────────
say "── pi-agent-teams v3 smoke test（timeout=${TIMEOUT}s）──"
command -v wezterm >/dev/null || { fail "缺 wezterm"; exit 1; }
[ -f "$EXT/index.ts" ] || { fail "v3 扩展未部署到 $EXT"; exit 1; }
wezterm cli --no-auto-start list --format json >/dev/null 2>&1 || { fail "wezterm cli 不可用（L1）"; exit 1; }

# ── 0.5 前置清扫（tasks/ 仅 v3 写，安全；含对应 status/sessions 残留）──
mkdir -p "$FARM"/tasks "$FARM"/status "$FARM"/sessions   # 保证 smoke 根目录存在（snapshot/cleanup 依赖）
for f in "$FARM"/tasks/*.json; do
  [ -f "$f" ] || continue
  id=$(basename "$f" .json)
  rm -f "$f" "$FARM/status/$id.done" "$FARM/status/$id.aborted"
  rm -rf "$FARM/sessions/$id"
  say "🧹 清扫残留任务: $id"
done

# ── 1. 测试窗口 + 驱动 pi ───────────────────────────────────
# bash 先记 $$ 再 exec pi：exec 后 pid 不变，DRIVER_PID 即 pi 进程 pid
# （wezterm list JSON 无 pid 字段，spike-facts §1；Case4 需 SIGTERM pi 本体）
DRIVER_PID_FILE="${TMPDIR:-/tmp}/pi-agent-teams-smoke-driver-$$.pid"
WIN_OUT=$(wezterm cli spawn --new-window --cwd "$HOME" -- bash -lc 'export PI_AGENT_TEAMS_ROOT="$1"; echo $$ > "$0"; exec pi' "$DRIVER_PID_FILE" "$SMOKE_FARM" 2>&1) || { fail "测试窗口创建失败: $WIN_OUT"; exit 1; }
DRIVER_PANE=$(printf '%s' "$WIN_OUT" | tail -1 | tr -cd '0-9')
[ -n "$DRIVER_PANE" ] || { fail "取不到 driver pane-id"; exit 1; }
say "驱动 pane: $DRIVER_PANE"
for ((i=0; i<50; i++)); do [ -s "$DRIVER_PID_FILE" ] && break; sleep 0.2; done
DRIVER_PID=$(cat "$DRIVER_PID_FILE" 2>/dev/null)
[ -n "$DRIVER_PID" ] || fail "取不到 driver pi pid（$DRIVER_PID_FILE 为空）"
say "驱动 pi pid: $DRIVER_PID"
sleep 10   # pi TUI 启动

send() { # 向 driver 发消息
  printf '%s' "$1" | wezterm cli send-text --no-paste --pane-id "$DRIVER_PANE" 2>/dev/null
  printf '\r'   | wezterm cli send-text --no-paste --pane-id "$DRIVER_PANE" 2>/dev/null
  say "▸ 已发: ${1:0:60}…"
}

# ── 票07修复2：非清理场景护栏 ──
# 新教学 description（任务一次性、执行完即可清理）会诱导 driver 主动 farm_cleanup，
# 与 Case1-5 的「任务落盘供断言」冲突（实机第2轮 Case1/2 即因此失败）。清理仅 Case6-11 验证。
KEEP_ON_DISK="不要调用 farm_cleanup 清理任务，保持任务落盘供检查。"
send_keep() { send "$1 护栏：$KEEP_ON_DISK"; }
# 护栏后仍无任务落盘（>60s）的诊断：区分 driver 未响应 vs 环境问题（票07修复2 要求）
diag_no_task() {
  say "── diag($1)：60s+ 无新任务落盘 ──"
  if [ -n "$DRIVER_PID" ]; then
    if ps -p "$DRIVER_PID" >/dev/null 2>&1; then say "driver pid=$DRIVER_PID 存活"; else say "driver pid=$DRIVER_PID 已死（疑 driver 未响应）"; fi
  fi
  if [ -n "$DRIVER_PANE" ]; then
    say "── driver pane 文本尾部 15 行 ──"
    wezterm cli get-text --pane-id "$DRIVER_PANE" --start-line 0 2>/dev/null | tail -15 || true
  fi
}

SNAP="${TMPDIR:-/tmp}/pi-agent-teams-smoke-snap-$$.ids"
SNAP2="${TMPDIR:-/tmp}/pi-agent-teams-smoke-snap2-$$.ids"

# ── 2. Case1 派发→出队→done→自动关窗→farm.done→人设 ──────────
say; say "── Case1 派发 + 完成 + 通知 + 人设 ──"
snapshot_ids "$SNAP"
send_keep '请调用 spawn_visible_agent 工具派发一个 worker 角色，prompt 参数设为「只用一个短句自述你的角色身份」，其余参数用默认。派完只回复我 taskId 本身。'
T1=$(new_task_since "$SNAP") || { fail "Case1: 60s 内无新任务落盘（护栏后仍无落盘：疑另有 driver 未响应）"; diag_no_task "Case1"; }
[ -n "$T1" ] || { fail "Case1: 新任务路径为空"; T1=""; }
if [ -n "$T1" ]; then
  SMOKE_TASKS="$SMOKE_TASKS $(basename "$T1" .json)"
  T1ID=$(basename "$T1" .json); pass "Case1: taskId=$T1ID"
  # 出队 + paneId 写回
  for ((i=0; i<30; i++)); do
    S=$(task_status "$T1"); P=$(task_paneid "$T1")
    [ "$S" = "running" ] && [ -n "$P" ] && break
    sleep 1
  done
  [ "$S" = "running" ] || fail "Case1: 未进入 running（status=${S}）"
  [ -n "$P" ] || fail "Case1: paneId 未写回"
  [ -n "$S" ] && [ "$S" = "running" ] && [ -n "$P" ] && pass "Case1: running + paneId=$P"
  # 等待 done
  for ((i=0; i<TIMEOUT; i++)); do
    S=$(task_status "$T1"); [ "$S" = "done" ] && break; sleep 1
  done
  [ "$S" = "done" ] || { fail "Case1: 超时未 done（status=${S}）"; }
  [ "$(task_exit "$T1")" = "0" ] || fail "Case1: exitCode=$(task_exit "$T1") != 0"
  SD=$(task_sessdir "$T1"); [ -n "$SD" ] || fail "Case1: sessionDir 空"
  N=$(task_notif "$T1"); [ -n "$N" ] && [ "$N" != "0" ] || fail "Case1: notifiedAt 未写（farm.done 未发）"
  [ "$S" = "done" ] && [ "$(task_exit "$T1")" = "0" ] && [ -n "$SD" ] && [ -n "$N" ] && pass "Case1: done + exitCode=0 + sessionDir + farm.done 已发"
  # 自动关窗（countdown 已删除，done 后应立即关）
  for ((i=0; i<15; i++)); do
    C=$(win_panes "$DRIVER_PANE"); [ "$C" = "1" ] && break; sleep 1
  done
  [ "$C" = "1" ] || fail "Case1: pane 未自动关闭（window panes=${C}）"
  [ "$C" = "1" ] && pass "Case1: pane 立即自动关闭（无 countdown）"
  # 人设抽查（session jsonl 含 worker 自述）
  J=$(ls "$SD"/*.jsonl 2>/dev/null | head -1)
  if [ -n "$J" ] && grep -qi "worker" "$J" 2>/dev/null; then
    pass "Case1: 人设注入生效（session 含 worker 自述）"
  else
    fail "Case1: session jsonl 未检出 worker 自述"
  fi
fi

# ── 3. Case2 并发 5 → 3 跑 2 排队 ────────────────────────────
say; say "── Case2 并发 5 个（≤3 running）──"
snapshot_ids "$SNAP"
send_keep '请连续调用 spawn_visible_agent 派发 5 个 worker 任务，prompt 分别是「只回答：1+1」「只回答：2+2」「只回答：3+3」「只回答：4+4」「只回答：5+5」，派完只回复「已派 5 个」。'
# id-diff 收集 5 个新任务（最长 90s，容忍 agent 逐批派发）
NEW=""
for ((i=0; i<90; i++)); do
  NEW=$(collect_new "$SNAP" 5)
  NEWN=$(printf '%s' "$NEW" | grep -c json)
  [ "$NEWN" -ge 5 ] && break
  sleep 1
done
NEWN=$(printf '%s' "$NEW" | grep -c json)
[ "$NEWN" -ge 5 ] || { fail "Case2: 只发现 $NEWN/5 个新任务（护栏后仍不足：疑另有 driver 未响应）"; diag_no_task "Case2"; }
MAXR=0; DONEN=0
PKDIR="${TMPDIR:-/tmp}/pi-agent-teams-smoke-case2-pids-$$"; rm -rf "$PKDIR"; mkdir -p "$PKDIR"
for ((i=0; i<TIMEOUT*2; i++)); do
  R=0; D=0
  for f in $NEW; do
    [ -f "$f" ] || continue
    # 运行期捕获 paneId（每任务首个非空值，done 后记录仍保留 paneId，
    # 但趁 running 就抓更稳；防任何落盘时序差异）
    P=$(task_paneid "$f"); [ -n "$P" ] && echo "$P" > "$PKDIR/$(basename "$f" .json)"
    case "$(task_status "$f")" in
      running) R=$((R + 1));;
      done)    D=$((D + 1));;
    esac
  done
  [ "$R" -gt "$MAXR" ] && MAXR=$R
  [ "$D" -eq 5 ] && break
  sleep 1
done
[ "$MAXR" -le 3 ] || fail "Case2: 峰值并发 $MAXR > 3"
[ "$D" -eq 5 ] || fail "Case2: 只完成 $D/5"
[ "$MAXR" -le 3 ] && [ "$D" -eq 5 ] && pass "Case2: 峰值并发 $MAXR ≤3，5/5 完成"
# paneId 唯一性（运行期捕获值）+ 全部关窗
IDS=$(cd "$PKDIR" 2>/dev/null && cat * 2>/dev/null | sort -u | grep -v '^$' | wc -l | tr -d ' ')
[ "$IDS" = "5" ] || fail "Case2: paneId 唯一数 $IDS != 5（捕获值: $(cd "$PKDIR" 2>/dev/null && cat * 2>/dev/null | tr '\n' ' ')）"
[ "$IDS" = "5" ] && pass "Case2: paneId 5 个全唯一"
C=$(win_panes "$DRIVER_PANE"); [ "$C" = "1" ] || fail "Case2: 有残留 pane（=${C}）"
[ "$C" = "1" ] && pass "Case2: 全部 pane 已自动关闭"
SMOKE_TASKS="$SMOKE_TASKS $(for f in $NEW; do basename "$f" .json; done)"
rm -rf "$PKDIR"

# ── 4. Case3 手动关 pane → aborted + 通知（含恢复命令数据）─────────────────
say; say "── Case3 手动关 pane → aborted + 通知 ──"
snapshot_ids "$SNAP"
send_keep '请调用 spawn_visible_agent 派发一个 worker 任务，prompt 设为「请用 bash 工具执行 sleep 60，命令结束后只输出 DONE」，派完只回复 taskId。'
T3=$(new_task_since "$SNAP") || { fail "Case3: 无新任务（护栏后仍无落盘：疑另有 driver 未响应）"; diag_no_task "Case3"; T3=""; }
if [ -n "$T3" ]; then
  T3ID=$(basename "$T3" .json); SMOKE_TASKS="$SMOKE_TASKS $T3ID"
  # 0.2s 轮询：paneId 一写回立即 kill（kill 窗口 2-3s，别等 agent 执行 sleep）
  P3=""; S=""
  for ((i=0; i<150; i++)); do
    P3=$(task_paneid "$T3"); [ -n "$P3" ] && break
    S=$(task_status "$T3"); [ "$S" = "done" ] && break
    sleep 0.2
  done
  [ -n "$P3" ] || fail "Case3: paneId 未写回（status=${S}，任务可能已完成、错过 kill 窗口）"
  if [ -n "$P3" ]; then
    wezterm cli kill-pane --pane-id "$P3" >/dev/null 2>&1
    say "Case3: 已 kill 任务 pane $P3"
  fi
  S=""
  for ((i=0; i<20; i++)); do S=$(task_status "$T3"); [ "$S" = "aborted" ] && break; sleep 1; done
  [ "$S" = "aborted" ] || fail "Case3: 状态=$S 非 aborted"
  N=$(task_notif "$T3"); [ -n "$N" ] && [ "$N" != "0" ] || fail "Case3: aborted 通知未发（notifiedAt 空）"
  [ "$S" = "aborted" ] && [ -n "$N" ] && pass "Case3: aborted + 通知已发（恢复命令数据在 result.sessionDir）"
else
  say "ℹ️ Case3: 未抓到新任务（driver 可能未响应），跳过"
fi

# ── 5. Case4 主会话退出 → 全 kill + cancelled ────────────────
say; say "── Case4 杀 driver（主会话退出）→ 全 kill + cancelled ──"
snapshot_ids "$SNAP"
send_keep '请调用 spawn_visible_agent 派发一个 worker 任务，prompt 设为「请用 bash 工具执行 sleep 120，命令结束后只输出结果」，派完只回复 taskId。'
T4=$(new_task_since "$SNAP") || { fail "Case4: 无新任务（护栏后仍无落盘：疑另有 driver 未响应）"; diag_no_task "Case4"; T4=""; }
if [ -n "$T4" ]; then
  T4ID=$(basename "$T4" .json); SMOKE_TASKS="$SMOKE_TASKS $T4ID"
  P4=""; S=""
  for ((i=0; i<60; i++)); do P4=$(task_paneid "$T4"); [ -n "$P4" ] && break; sleep 0.5; done
  # 杀 pi 进程本体（SIGTERM→session_shutdown→farm 全 kill + cancelled），
  # 不能 kill pane：pane 关闭会脱孤 pi 进程、shutdown 不触发（实测）。
  # queued（paneId 未写回）也可被 shutdown 双扫 cancel，故不因 P4 空而跳过。
  [ -n "$DRIVER_PID" ] || fail "Case4: driver pi pid 为空"
  kill -TERM "$DRIVER_PID" 2>/dev/null
  say "Case4: 已 SIGTERM driver pi (pid=$DRIVER_PID)"
  for ((i=0; i<20; i++)); do S=$(task_status "$T4"); [ "$S" = "cancelled" ] && break; sleep 1; done
  [ "$S" = "cancelled" ] || fail "Case4: 状态=$S 非 cancelled"
  if [ -n "$P4" ]; then
    STILL=$(wezterm cli --no-auto-start list --format json 2>/dev/null | node -e '
      let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{const p=JSON.parse(d);console.log(p.some(x=>String(x.pane_id)===process.argv[1])?"1":"0")}catch{console.log("-1")}})' "$P4")
    [ "$STILL" = "0" ] || fail "Case4: 任务 pane 仍存活"
  else
    STILL="0"   # queued 无 pane 可杀，跳过存活断言
  fi
  DSTILL=$(wezterm cli --no-auto-start list --format json 2>/dev/null | node -e '
    let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{const p=JSON.parse(d);console.log(p.some(x=>String(x.pane_id)===process.argv[1])?"1":"0")}catch{console.log("-1")}})' "$DRIVER_PANE")
  [ "$DSTILL" = "0" ] || fail "Case4: driver pane 仍存活"
  [ "$S" = "cancelled" ] && [ "$STILL" = "0" ] && [ "$DSTILL" = "0" ] && pass "Case4: cancelled 落盘 + 任务 pane/driver pane 均已收敛"
  DRIVER_PANE=""   # 已收敛，防 cleanup 重复
  DRIVER_PID=""    # 已杀，防 cleanup 重复
fi

# ── 6. Case5 L1 拒绝（不落盘）────────────────────────────────
say; say "── Case5 L1（bogus socket）→ 拒绝 + 不落盘 ──"
BASE=$(ls "$FARM"/tasks/*.json 2>/dev/null | wc -l | tr -d ' ')
OUT=$(WEZTERM_UNIX_SOCKET=/tmp/pi-agent-teams-smoke-bogus.sock PI_AGENT_TEAMS_ROOT="$SMOKE_FARM" timeout 60 pi -p -e '请调用 spawn_visible_agent 工具派发一个 worker' 2>&1)
NOW=$(ls "$FARM"/tasks/*.json 2>/dev/null | wc -l | tr -d ' ')
[ "$NOW" = "$BASE" ] || fail "Case5: L1 下仍有任务落盘（${BASE} → ${NOW}）"
[ "$NOW" = "$BASE" ] && pass "Case5: L1 下零落盘（拒绝生效）"
printf '%s' "$OUT" | grep -qiE "subagent|子代理|不可用|降级|拒绝" && pass "Case5: 输出含引导文案" || say "ℹ️ Case5: 输出未检出引导关键词（软断言，不判失败）"

# ── 6.5 driver 重启（Case4 已 SIGTERM 旧 driver；Case6+ 需要交互式 driver）──
# 依赖前置：新扩展已部署（含 farm_cleanup 工具，票 05）。文本断言用 wezterm cli
# get-text 读当前屏幕（--start-line 0 排除 scrollback，防旧渲染残留假阳性）。
say; say "── 重启 driver（Case6+ 用）──"
DRIVER_PANE=""; DRIVER_PID=""
: > "$DRIVER_PID_FILE"   # 清旧 pid（Case4 遗留），防取到死进程 pid
WIN_OUT=$(wezterm cli spawn --new-window --cwd "$HOME" -- bash -lc 'export PI_AGENT_TEAMS_ROOT="$1"; echo $$ > "$0"; exec pi' "$DRIVER_PID_FILE" "$SMOKE_FARM" 2>&1) || { fail "Case6+: 重启测试窗口失败: $WIN_OUT"; }
DRIVER_PANE=$(printf '%s' "$WIN_OUT" | tail -1 | tr -cd '0-9')
[ -n "$DRIVER_PANE" ] || { fail "Case6+: 取不到重启后 pane-id"; DRIVER_PANE=""; }
if [ -n "$DRIVER_PANE" ]; then
  say "新 driver pane: $DRIVER_PANE"
  for ((i=0;i<50;i++)); do [ -s "$DRIVER_PID_FILE" ] && break; sleep 0.2; done
  DRIVER_PID=$(cat "$DRIVER_PID_FILE" 2>/dev/null)
  [ -n "$DRIVER_PID" ] || fail "Case6+: 取不到重启后 driver pi pid（$DRIVER_PID_FILE 为空）"
  say "新 driver pi pid: $DRIVER_PID"
  sleep 10   # pi TUI 启动

  # 文本断言原语。面板/工具表行 = 可选对齐前导空格 + id 前 8 位 + 空格（dump 实证：` 8c850493 worker 运行中`）；
  # 聊天区行首是完整 36 位 id（第 9 位非空格），故行首锚定 ^[[:space:]]*<id8> 既容忍面板前导空格、
  # 又区分面板行与聊天文本（票07修复6）。
  pane_text() { wezterm cli get-text --pane-id "$DRIVER_PANE" --start-line 0 2>/dev/null; }
  wait_text() { local m="$1" t="${2:-60}" i; for ((i=0;i<t;i++)); do pane_text | grep -qF "$m" && return 0; sleep 1; done; return 1; }

  T6=""; TA=""; TB=""; TQ=""; TS=""; TG=""

  # ── 6. Case6 farm_cleanup 全链路：spawn→done→报告→confirm→tasks 消失+farm_status 同步+费用影响 ──
  say; say "── Case6 farm_cleanup 全链路 ──"
  snapshot_ids "$SNAP"
  # 票07修复4：Case6 fixture 改用 send_keep（禁 driver 教学清理——实机第4轮 driver 主动 farm_cleanup
  # 致 dry-run 后任务文件消失，误报「dry-run 竟删除任务」）
  send_keep '请调用 spawn_visible_agent 派发一个 worker 任务，prompt 设为「只回答：ok」，派完只回复 taskId。'
  T6=$(new_task_since "$SNAP") || { fail "Case6: 60s 内无新任务落盘"; T6=""; }
  if [ -n "$T6" ]; then
    T6ID=$(basename "$T6" .json); SMOKE_TASKS="$SMOKE_TASKS $T6ID"; T6ID8=${T6ID:0:8}
    S=""
    for ((i=0;i<TIMEOUT;i++)); do S=$(task_status "$T6"); [ "$S" = "done" ] && break; sleep 1; done
    [ "$S" = "done" ] || fail "Case6: 前置任务未 done（status=${S}）"
    N=$(task_notif "$T6"); [ -n "$N" ] && [ "$N" != "0" ] || fail "Case6: 前置任务未通知（notifiedAt 空，无法过守卫）"
    if [ "$S" = "done" ] && [ -n "$N" ] && [ "$N" != "0" ]; then
      # 票07修复4：判据改行为级——文件系统事实=硬断言；工具输出文案降级软断言
      # （driver 摘要是已知不稳定：实机第4轮工具已执行但屏幕缺「费用影响/skipped/已清理」）。
      # 1) dry-run：硬断言=任务文件仍存在（未删）；可清理/费用影响/skipped 软断言
      send '请调用 farm_cleanup 工具，status 参数传 done，不要传 confirm。回复第一行写「==R1==」，然后原样贴出工具返回的完整文本。'
      if wait_text "==R1=="; then
        [ -f "$T6" ] && pass "Case6: dry-run 后任务文件仍存在（未删，文件级硬断言）" || fail "Case6: dry-run 竟删除任务（文件消失）"
        TXT=$(pane_text)
        grep -qF "可清理" <<<"$TXT" && pass "Case6: dry-run 报告含「可清理」" || say "ℹ️ Case6: 未检出「可清理」（软断言：driver 摘要不稳定）"
        grep -qF "费用影响: 合计" <<<"$TXT" && pass "Case6: dry-run 含费用影响行" || say "ℹ️ Case6: 未检出「费用影响」行（软断言）"
        grep -qF "skipped 分组" <<<"$TXT" && pass "Case6: dry-run 含 skipped 分组" || say "ℹ️ Case6: 未检出「skipped 分组」（软断言）"
      else
        # 同步失败仍做一次性文件存在检查（捕获 driver 教学清理：文件消失=真 bug）
        if [ -f "$T6" ]; then
          say "ℹ️ Case6: 60s 内未见 ==R1== 回复（driver 摘要不稳定），dry-run 文件断言跳过（任务仍在）"
        else
          fail "Case6: dry-run 阶段任务文件消失（未见 ==R1== 且文件已删——疑 driver 教学清理）"
        fi
      fi
      # 2) confirm：硬断言=任务文件消失（直接观察文件，不依赖 ==R2== 文本）；「已清理」软断言
      send '请再次调用 farm_cleanup，status 传 done，confirm 传 true。回复第一行写「==R2==」，然后原样贴出返回文本。'
      GONE=0
      for ((i=0;i<90;i++)); do [ -f "$T6" ] || { GONE=1; break; }; sleep 1; done
      if [ "$GONE" = "1" ]; then
        pass "Case6: confirm 后任务文件已删除（文件级硬断言）"
        grep -qF "已清理" <<<"$(pane_text)" && pass "Case6: confirm 报告含「已清理」" || say "ℹ️ Case6: 未检出「已清理」（软断言：driver 摘要不稳定）"
      elif wait_text "==R2==" 15; then
        fail "Case6: confirm 后任务文件仍在（==R2== 已出现但 90s 内文件未消失——清理逻辑未生效？）"
      else
        fail "Case6: confirm 后任务文件未消失且未见 ==R2==（driver 未执行 confirm？）"
      fi
      # 3) farm_status 同步：硬断言=同源数据（tasks/ 已无该 id，farm_status 即读此根）；agent 裁决=文本交叉验证
      if ! ls "$FARM"/tasks/*.json 2>/dev/null | grep -qF "$T6ID"; then
        pass "Case6: farm_status 同步（tasks/ 无该 id，列表不再列出）"
      else
        fail "Case6: tasks/ 仍含该任务（与文件断言矛盾）"
      fi
      send "请调用 farm_status（无参数）。如果列表里还能看到 taskId 前缀 ${T6ID8} 就回答「仍在列表」，否则回答「不在列表」。只回答这四个字。"
      if wait_text "不在列表"; then
        pass "Case6: farm_status 同步（agent 确认不在列表）"
      elif pane_text | grep -qF "仍在列表"; then
        fail "Case6: farm_status 仍列出已删任务（文件已删但列表仍见？）"
      else
        say "ℹ️ Case6: 未收到 agent 裁决（软断言跳过，数据层断言已覆盖）"
      fi
    fi
  fi

  # ── 7. Case7 拒绝路径：queued/running/timeout 不可清理 ──
  say; say "── Case7 拒绝路径 ──"
  snapshot_ids "$SNAP"
  send '请连续调用 spawn_visible_agent 派发 5 个 worker 任务，prompt 全部设为「用 bash 执行 sleep 240，命令结束后只输出 DONE」，派完只回复「已派 5 个」。'
  NEW=""
  for ((i=0;i<90;i++)); do NEW=$(collect_new "$SNAP" 5); NEWN=$(printf '%s' "$NEW" | grep -c json); [ "$NEWN" -ge 5 ] && break; sleep 1; done
  NEWN=$(printf '%s' "$NEW" | grep -c json)
  [ "$NEWN" -ge 5 ] || fail "Case7: 只发现 $NEWN/5 个新任务"
  SMOKE_TASKS="$SMOKE_TASKS $(for f in $NEW; do basename "$f" .json; done)"
  RUN=0; Q=0
  for ((i=0;i<90;i++)); do
    RUN=0; Q=0
    for f in $NEW; do case "$(task_status "$f")" in running) RUN=$((RUN+1));; queued) Q=$((Q+1));; esac; done
    [ "$RUN" -ge 3 ] && [ "$Q" -ge 1 ] && break
    sleep 1
  done
  [ "$RUN" -ge 1 ] || fail "Case7: 无任务进入 running"
  [ "$RUN" -ge 3 ] && [ "$Q" -ge 1 ] && pass "Case7: ${RUN} running + ${Q} queued" || say "ℹ️ Case7: 并发 ${RUN}R/${Q}Q（软观察）"
  # 票07修复4：R3/R4/R5 等待 60→90s（实机第4轮 driver 慢、60s 未回复）；文案断言降级软断言
  # （skipped 分组/非法 status 均依赖 driver 贴工具返回，摘要是已知不稳定）；文件保留=硬断言。
  # 取舍：marker 同步缺失≠行为失败——核心行为（confirm 未删活跃）由 R5 文件级硬断言覆盖，
  # R3/R4 marker 超时只记 ℹ️ 不判 FAIL；仅当 marker 缺失且文件消失才判 FAIL（真 bug 信号）。
  # 1) dry-run：活跃任务只进 skipped，不删除（文件保留=硬断言；skipped 文案=软断言）
  send '请调用 farm_cleanup 工具，不要传任何参数。回复第一行写「==R3==」，然后原样贴出返回文本。'
  if wait_text "==R3==" 90; then
    TXT=$(pane_text)
    grep -E "活跃 [0-9]+（queued/running/timeout" <<<"$TXT" >/dev/null && pass "Case7: dry-run skipped 含活跃分组" || say "ℹ️ Case7: 未检出「活跃」skipped 分组（软断言：driver 摘要不稳定）"
    ALIVE=1
    for f in $NEW; do [ -f "$f" ] || { ALIVE=0; break; }; done
    [ "$ALIVE" = "1" ] && pass "Case7: dry-run 未删除活跃任务（文件级硬断言）" || fail "Case7: dry-run 删除了活跃任务"
  else
    ALIVE=1
    for f in $NEW; do [ -f "$f" ] || { ALIVE=0; break; }; done
    if [ "$ALIVE" = "1" ]; then
      say "ℹ️ Case7: 90s 内未见 ==R3== 回复（driver 慢/摘要不稳定），dry-run 文件断言降级（活跃任务文件均在）"
    else
      fail "Case7: dry-run 阶段活跃任务文件消失（未见 ==R3== 且文件已删）"
    fi
  fi
  # 2) 非法 status：queued/running/timeout 被拒（拒绝文案=软断言；拒绝后文件保留=硬断言）
  send '请调用 farm_cleanup 工具，status 参数传 running。回复第一行写「==R4==」，然后原样贴出返回文本。'
  if wait_text "==R4==" 90; then
    grep -qF "非法 status" <<<"$(pane_text)" && pass "Case7: status=running 被拒（queued/running/timeout 非终态不可清理）" || say "ℹ️ Case7: 未检出「非法 status」拒绝文案（软断言：driver 摘要不稳定）"
  else
    say "ℹ️ Case7: 90s 内未见 ==R4== 回复（driver 慢/摘要不稳定），拒绝文案断言跳过"
  fi
  ALIVE=1
  for f in $NEW; do [ -f "$f" ] || { ALIVE=0; break; }; done
  [ "$ALIVE" = "1" ] && pass "Case7: status=running 调用后活跃任务文件仍全在（未被误删）" || fail "Case7: status=running 调用后活跃任务被删"
  # 3) confirm 默认集：不碰任何活跃任务（文件级硬断言，核心行为）
  send '请调用 farm_cleanup 工具，confirm 传 true（status 缺省）。回复第一行写「==R5==」，然后原样贴出返回文本。'
  if wait_text "==R5==" 90; then
    ALIVE=1
    for f in $NEW; do [ -f "$f" ] || { ALIVE=0; break; }; done
    [ "$ALIVE" = "1" ] && pass "Case7: confirm 未删除活跃任务（文件级硬断言）" || fail "Case7: confirm 删除了活跃任务"
  else
    ALIVE=1
    for f in $NEW; do [ -f "$f" ] || { ALIVE=0; break; }; done
    if [ "$ALIVE" = "1" ]; then
      say "ℹ️ Case7: 90s 内未见 ==R5== 回复（driver 慢/摘要不稳定），confirm 文件级断言降级（活跃任务文件均在）"
    else
      fail "Case7: confirm 阶段活跃任务文件消失"
    fi
  fi

  # ── 8. Case8 aborted 显式点名才清 + 未通知 skipped ──
  say; say "── Case8 aborted 显式点名 + 未通知 skipped ──"
  # 8a) aborted fixture：spawn → kill pane（镜像 Case3 手法，自包含不依赖 Case3）
  snapshot_ids "$SNAP"
  send_keep '请调用 spawn_visible_agent 派发一个 worker 任务，prompt 设为「用 bash 执行 sleep 120，命令结束后只输出 DONE」，派完只回复 taskId。'   # 票07修复4：防教学清理误删 fixture
  TA=$(new_task_since "$SNAP") || { fail "Case8: 无新任务"; TA=""; }
  PA=""; S=""   # 票07修复4：无条件初始化（set -u：paneId 首轮写回即 break、S 赋值被跳过 → L451 $S unbound 崩；同 TQID8/TSID8 修法）
  if [ -n "$TA" ]; then
    TAID=$(basename "$TA" .json); SMOKE_TASKS="$SMOKE_TASKS $TAID"
    for ((i=0;i<150;i++)); do PA=$(task_paneid "$TA"); [ -n "$PA" ] && break; S=$(task_status "$TA"); [ "$S" = "done" ] && break; sleep 0.2; done
    [ -n "$PA" ] || fail "Case8: paneId 未写回（status=${S}，可能错过 kill 窗口）"
    if [ -n "$PA" ]; then wezterm cli kill-pane --pane-id "$PA" >/dev/null 2>&1; say "Case8: 已 kill 任务 pane $PA"; fi
    S=""
    for ((i=0;i<20;i++)); do S=$(task_status "$TA"); [ "$S" = "aborted" ] && break; sleep 1; done
    [ "$S" = "aborted" ] || fail "Case8: fixture 状态=$S 非 aborted"
    N=$(task_notif "$TA"); [ -n "$N" ] && [ "$N" != "0" ] || fail "Case8: aborted fixture 未通知（notifiedAt 空，无法过守卫）"
    [ "$S" = "aborted" ] && [ -n "$N" ] && [ "$N" != "0" ] && pass "Case8: aborted fixture 就绪（notifiedAt 已写）"
  fi
  # 8b) 未通知 fixture：done 后回写 notifiedAt=0（mock 未确认通知；updatedAt 保持 now 防 GC 误删）
  snapshot_ids "$SNAP"
  send_keep '请调用 spawn_visible_agent 派发一个 worker 任务，prompt 设为「只回答：ok」，派完只回复 taskId。'   # 票07修复4：防教学清理误删 fixture
  TB=$(new_task_since "$SNAP") || { fail "Case8: 无新任务"; TB=""; }
  if [ -n "$TB" ]; then
    TBID=$(basename "$TB" .json); SMOKE_TASKS="$SMOKE_TASKS $TBID"
    S=""; N=""   # 票07修复5：L508 曾 unbound——N 头部已无条件初始化，fixture 缺失/未 done 时引用安全
    for ((i=0;i<TIMEOUT;i++)); do S=$(task_status "$TB"); [ "$S" = "done" ] && break; sleep 1; done
    [ "$S" = "done" ] || fail "Case8: 未通知 fixture 未 done（status=${S}）"
    if [ "$S" = "done" ]; then
      node -e 'const fs=require("fs");const p=process.argv[1];const o=JSON.parse(fs.readFileSync(p,"utf8"));o.notifiedAt=0;o.updatedAt=Date.now();fs.writeFileSync(p,JSON.stringify(o,null,2));' "$TB"
      N=$(task_notif "$TB"); { [ "$N" = "0" ] || [ -z "$N" ]; } && pass "Case8: 未通知 fixture 就绪（notifiedAt 已清零）" || fail "Case8: notifiedAt 清零失败（=${N}）"   # 票07修复6：清零后字段值="0"（非空串），0/缺失都算清零成功
    fi
  fi
  # 8c) 默认 dry-run：aborted 不在默认集 + 未通知进 skipped（文件级硬断言）
  send '请调用 farm_cleanup 工具，不要传任何参数。回复第一行写「==R6==」，然后原样贴出返回文本。'
  if wait_text "==R6==" 90; then
    [ -n "$TA" ] && { [ -f "$TA" ] && pass "Case8: 默认集不碰 aborted" || fail "Case8: aborted 被默认清理"; }
    [ -n "$TB" ] && { [ -f "$TB" ] && pass "Case8: 未通知任务未删" || fail "Case8: 未通知任务被删"; }
  else
    # 票07修复6：marker 超时不判 FAIL（与 R3/R4/R5 同策略）——文件保留=硬事实，一次性兜底检查
    if { [ -z "$TA" ] || [ -f "$TA" ]; } && { [ -z "$TB" ] || [ -f "$TB" ]; }; then
      say "ℹ️ Case8: 90s 内未见 ==R6== 回复（driver 慢/摘要不稳定），默认集保留断言降级（aborted/未通知文件均在）"
    else
      fail "Case8: 默认 dry-run 阶段文件消失（未见 ==R6== 且 aborted/未通知被删）"
    fi
  fi
  # 8d) confirm 默认集：同样不碰（文件级硬断言）
  send '请调用 farm_cleanup 工具，confirm 传 true（status 缺省）。回复第一行写「==R7==」，然后原样贴出返回文本。'
  if wait_text "==R7==" 90; then
    [ -n "$TA" ] && { [ -f "$TA" ] && pass "Case8: confirm(默认) 保留 aborted" || fail "Case8: confirm(默认) 误删 aborted"; }
    [ -n "$TB" ] && { [ -f "$TB" ] && pass "Case8: confirm(默认) 保留未通知" || fail "Case8: confirm(默认) 误删未通知"; }
  else
    # 票07修复6：同 R6——marker 超时不判 FAIL，文件保留=硬事实
    if { [ -z "$TA" ] || [ -f "$TA" ]; } && { [ -z "$TB" ] || [ -f "$TB" ]; }; then
      say "ℹ️ Case8: 90s 内未见 ==R7== 回复（driver 慢/摘要不稳定），confirm(默认) 保留断言降级（aborted/未通知文件均在）"
    else
      fail "Case8: confirm(默认) 阶段文件消失（未见 ==R7== 且 aborted/未通知被删）"
    fi
  fi
  # 8e) 显式点名 aborted：dry-run 不删 → confirm 删除
  # 票07修复6：R8/R9 marker 未回复时旧走法在 R8 处判 FAIL（假失败，confirm(aborted) 删除断言根本没跑到）。
  # 改为：confirm(aborted) = 文件级硬断言——发出指令后轮询 90s 任务文件消失即 pass，不 grep marker 文本；
  # 指令明确「status 传 aborted（默认排除，必须点名）+ confirm 传 true」；dry-run 阶段 marker 超时只记 ℹ️。
  send '请调用 farm_cleanup 工具，status 参数传 aborted，不要传 confirm。回复第一行写「==R8==」，然后原样贴出返回文本。'
  if wait_text "==R8==" 90; then
    [ -n "$TA" ] && { [ -f "$TA" ] && pass "Case8: dry-run(aborted) 未删" || fail "Case8: dry-run(aborted) 误删"; }
  else
    if [ -z "$TA" ]; then
      say "ℹ️ Case8: aborted fixture 缺失，dry-run(aborted) 断言跳过"
    elif [ -f "$TA" ]; then
      say "ℹ️ Case8: 90s 内未见 ==R8== 回复（driver 慢/摘要不稳定），dry-run(aborted) 断言降级（文件仍在=未删）"
    else
      fail "Case8: dry-run(aborted) 阶段文件消失（未见 ==R8== 且已删——aborted 默认排除+无 confirm 必不删）"
    fi
  fi
  send '请调用 farm_cleanup 工具，status 参数传 aborted（必须显式点名，aborted 默认排除），confirm 传 true。回复第一行写「==R9==」，然后原样贴出返回文本。'
  if [ -n "$TA" ]; then
    GONE=0
    for ((i=0;i<90;i++)); do [ ! -f "$TA" ] && { GONE=1; break; }; sleep 1; done
    if [ "$GONE" = "1" ]; then
      pass "Case8: confirm(aborted) 显式点名已清（文件级硬断言）"
    elif wait_text "==R9==" 15; then
      fail "Case8: confirm(aborted) 后任务文件仍在（==R9== 已出现但 90s 未删——清理未生效或 driver 未传 status=aborted）"
    else
      fail "Case8: confirm(aborted) 后文件未消失且未见 ==R9==（driver 未执行 confirm？）"
    fi
  else
    say "ℹ️ Case8: aborted fixture 缺失，confirm(aborted) 删除断言跳过"
  fi

  # ── 8.5 Case8.5 批删失败 failed 计数（chflags uchg 注入单文件 rm 失败 → 报告 failed 计数 + 批删不断链）──
  # 注：deleteTask 对坏文件/缺文件折叠为 skipped(missing)，不触发 failed——failed 只在 rm 抛异常时计。
  # macOS uchg 令 unlink 返回 EPERM（读不受影响），是唯一能在单文件上稳定制造 rm 失败的注入点。
  say; say "── Case8.5 批删失败 failed 计数 ──"
  snapshot_ids "$SNAP"
  send_keep '请调用 spawn_visible_agent 派发一个 worker 任务，prompt 设为「只回答：ok」，派完只回复 taskId。'   # 票07修复4：防教学清理误删 fixture
  TF=$(new_task_since "$SNAP") || { fail "Case8.5: 无新任务"; TF=""; }
  if [ -n "$TF" ]; then
    TFID=$(basename "$TF" .json); SMOKE_TASKS="$SMOKE_TASKS $TFID"
    S=""
    for ((i=0;i<TIMEOUT;i++)); do S=$(task_status "$TF"); [ "$S" = "done" ] && break; sleep 1; done
    [ "$S" = "done" ] || fail "Case8.5: 前置任务未 done（status=${S}）"
    N=$(task_notif "$TF"); [ -n "$N" ] && [ "$N" != "0" ] || fail "Case8.5: 前置任务未通知（notifiedAt 空，无法过守卫）"
    if [ "$S" = "done" ] && [ -n "$N" ] && [ "$N" != "0" ]; then
      if command -v chflags >/dev/null 2>&1 && chflags uchg "$TF" 2>/dev/null; then
        say "Case8.5: 已对 ${TFID} 置 uchg（rm 将被拒，读不受影响）"
        # 1) confirm 批删：其余可清任务照删（断链验证），仅 TF 进 failed 计数
        send '请调用 farm_cleanup 工具，confirm 传 true（status 缺省）。回复第一行写「==R9b==」，然后原样贴出返回文本。'
        if wait_text "==R9b==" 90; then
          grep -qF "个删除失败（已跳过）" <<<"$(pane_text)" && pass "Case8.5: 报告含 failed 计数（rm 失败已跳过，批删不断链）" || say "ℹ️ Case8.5: 未检出 failed 计数行（软断言：driver 摘要不稳定；文件保留=硬断言）"
          [ -f "$TF" ] && pass "Case8.5: 失败任务文件仍在（未误删）" || fail "Case8.5: 失败任务竟被删除（flag 未生效？）"
        else
          # 票07修复6：同 R3-R5——marker 超时不判 FAIL，文件保留=硬事实（rm 被 uchg 拒）
          [ -f "$TF" ] && say "ℹ️ Case8.5: 90s 内未见 ==R9b== 回复（driver 慢/摘要不稳定），failed 计数文案断言降级（失败任务文件仍在）" || fail "Case8.5: 失败任务文件消失（未见 ==R9b== 且文件已删——flag 未生效或误删）"
        fi
        chflags nouchg "$TF" 2>/dev/null || say "ℹ️ Case8.5: nouchg 恢复失败（残留标志，下次运行 0.5 清扫兜底）"
        # 2) 恢复后可清：再次 confirm 应成功（证明 failed 确因 rm 被拒，非清理逻辑误判）
        send '请再次调用 farm_cleanup 工具，confirm 传 true（status 缺省）。回复第一行写「==R9c==」，然后原样贴出返回文本。'
        # 票07修复6：删除=文件级硬断言——轮询 90s 文件消失即 pass，不依赖 ==R9c== marker 文本
        GONE=0
        for ((i=0;i<90;i++)); do [ ! -f "$TF" ] && { GONE=1; break; }; sleep 1; done
        if [ "$GONE" = "1" ]; then
          pass "Case8.5: 恢复后 confirm 已清（failed 计数语义闭环，文件级硬断言）"
        elif wait_text "==R9c==" 15; then
          fail "Case8.5: 恢复后仍未删除（==R9c== 已出现但 90s 文件仍在）"
        else
          fail "Case8.5: 恢复后文件未消失且未见 ==R9c==（driver 未执行 confirm？）"
        fi
      else
        say "ℹ️ Case8.5: chflags 不可用/被拒（非 macOS 或权限不足），failed 计数用例跳过"
      fi
    fi
  fi

  # ── 9. Case9 面板 active-only：终态完成即不在面板 ──
  say; say "── Case9 面板 active-only ──"
  TQID8=""; TSID8=""   # 无条件初始化（set -u：fixture 缺失时循环内空值跳过，防 unbound 崩）
  snapshot_ids "$SNAP"
  send_keep '请调用 spawn_visible_agent 派发一个 worker 任务，prompt 设为「只回答：ok」（很快完成），派完只回复 taskId。'   # 票07修复4：防教学清理误删 fixture
  TQ=$(new_task_since "$SNAP") || { fail "Case9: 无新任务"; TQ=""; }
  if [ -n "$TQ" ]; then
    TQID=$(basename "$TQ" .json); SMOKE_TASKS="$SMOKE_TASKS $TQID"; TQID8=${TQID:0:8}
    S=""
    for ((i=0;i<TIMEOUT;i++)); do S=$(task_status "$TQ"); [ "$S" = "done" ] && break; sleep 1; done
    [ "$S" = "done" ] || fail "Case9: 快任务未 done（status=${S}）"
    [ "$S" = "done" ] && pass "Case9: 快任务已 done"
  fi
  snapshot_ids "$SNAP"
  send_keep '请调用 spawn_visible_agent 派发一个 worker 任务，prompt 设为「用 bash 执行 sleep 240，命令结束后只输出 DONE」，派完只回复 taskId。'   # 票07修复4：防教学清理误删 fixture
  TS=$(new_task_since "$SNAP") || { fail "Case9: 慢任务未落盘"; TS=""; }
  if [ -n "$TS" ]; then
    TSID=$(basename "$TS" .json); SMOKE_TASKS="$SMOKE_TASKS $TSID"; TSID8=${TSID:0:8}
    S=""
    for ((i=0;i<60;i++)); do S=$(task_status "$TS"); [ "$S" = "running" ] && break; sleep 1; done
    [ "$S" = "running" ] || fail "Case9: 慢任务未 running（status=${S}）"
    [ "$S" = "running" ] && pass "Case9: 慢任务 running"
  fi
  FOUND_S=0; FOUND_Q=1; FOUND_F=0
  for ((i=0;i<10;i++)); do
    TXT=$(pane_text)
    # 票07修复6：dump 实证面板行首有对齐空格（` 8c850493 worker 运行中`）——^[[:space:]]* 容忍前导空格；
    # 仍锚定行首（聊天区行首是完整 36 位 id，第 9 位非空格，不会误匹配 id8+空格）
    [ -n "$TSID8" ] && { echo "$TXT" | grep -qE "^[[:space:]]*${TSID8} .*运行中" && FOUND_S=1 || FOUND_S=0; }
    [ -n "$TQID8" ] && { echo "$TXT" | grep -qE "^[[:space:]]*${TQID8} " && FOUND_Q=1 || FOUND_Q=0; }
    echo "$TXT" | grep -qF "合计=保留期内列表费用" && FOUND_F=1 || FOUND_F=0
    ALL=1
    [ -n "$TSID8" ] && [ "$FOUND_S" != "1" ] && ALL=0
    [ -n "$TQID8" ] && [ "$FOUND_Q" != "0" ] && ALL=0
    [ "$FOUND_F" != "1" ] && ALL=0
    [ "$ALL" = "1" ] && break
    sleep 2
  done
  if [ -n "$TSID8" ]; then
    [ "$FOUND_S" = "1" ] && pass "Case9: 面板显示运行中任务（${TSID8} 运行中）" || fail "Case9: 面板未显示活跃任务行（${TSID8} 未在面板）"
  else
    say "ℹ️ Case9: 慢任务 fixture 缺失，跳过活跃行断言"
  fi
  if [ -n "$TQID8" ]; then
    [ "$FOUND_Q" = "0" ] && pass "Case9: 面板不再显示终态任务（${TQID8} 不在面板，active-only 生效）" || fail "Case9: 面板仍显示已 done 任务（active-only 未生效）"
  else
    say "ℹ️ Case9: 快任务 fixture 缺失，跳过终态隐藏断言"
  fi
  [ "$FOUND_F" = "1" ] && pass "Case9: 面板 footer 含即清提示" || fail "Case9: 面板 footer 文案缺失"
  # 任一面板断言失败 → dump 面板文本尾部 20 行（区分脚本 bug vs 渲染未出面板）
  if [ "$FOUND_F" != "1" ] || { [ -n "$TSID8" ] && [ "$FOUND_S" != "1" ]; } || { [ -n "$TQID8" ] && [ "$FOUND_Q" != "0" ]; }; then
    say "── Case9 面板文本尾部 20 行（诊断 dump）──"
    pane_text | tail -20
  fi
  # 收尾：kill 慢任务 pane（防残留占位；转 aborted 由下次运行 0.5 清扫回收）
  if [ -n "$TS" ]; then
    PS=$(task_paneid "$TS")
    [ -n "$PS" ] && { wezterm cli kill-pane --pane-id "$PS" >/dev/null 2>&1; say "Case9: 已 kill 慢任务 pane $PS"; } || true
  fi

  # ── 10. Case10 自动 GC 兜底（updatedAt 回拨注入 >24h 年龄，等 GC 60s 节流周期）──
  say; say "── Case10 自动 GC 兜底 ──"
  snapshot_ids "$SNAP"
  send_keep '请调用 spawn_visible_agent 派发一个 worker 任务，prompt 设为「只回答：ok」，派完只回复 taskId。'   # 票07修复4：防教学清理误删 fixture
  TG=$(new_task_since "$SNAP") || { fail "Case10: 无新任务"; TG=""; }
  if [ -n "$TG" ]; then
    TGID=$(basename "$TG" .json); SMOKE_TASKS="$SMOKE_TASKS $TGID"; TGID8=${TGID:0:8}
    S=""
    for ((i=0;i<TIMEOUT;i++)); do S=$(task_status "$TG"); [ "$S" = "done" ] && break; sleep 1; done
    [ "$S" = "done" ] || fail "Case10: 前置任务未 done（status=${S}）"
    if [ "$S" = "done" ]; then
      node -e 'const fs=require("fs");const p=process.argv[1];const o=JSON.parse(fs.readFileSync(p,"utf8"));o.updatedAt=Date.now()-25*3600*1000;fs.writeFileSync(p,JSON.stringify(o,null,2));' "$TG"
      say "Case10: 已回拨 ${TGID8} updatedAt → 25h 前（GC_TASKS_TTL_MS=24h 严格 > 才删；等 GC 60s 节流）"
      GONE=0
      for ((i=0;i<100;i++)); do [ -f "$TG" ] || { GONE=1; break; }; sleep 1; done
      [ "$GONE" = "1" ] && pass "Case10: GC 兜底已回收超龄终态任务" || fail "Case10: 100s 内 GC 未回收回拨任务（GC 未生效？）"
    fi
  fi

  # ── 11. Case11 僵尸回收链路：死 owner running → SIGKILL driver → 重启 session_start reap → aborted → 通知 → 清理 ──
  # 依赖：session_start 先 reapDeadOwnerRunnings（死 owner 的 running/timeout → exhausted/aborted）再 replay 补发。
  # worker pane 随 driver 窗口关闭或孤儿存活两路径均成立：reap 对已死 pane killSync best-effort，断言只依赖任务记录。
  say; say "── Case11 僵尸回收链路 ──"
  snapshot_ids "$SNAP"
  send_keep '请调用 spawn_visible_agent 派发一个 worker 任务，prompt 设为「用 bash 执行 sleep 300，命令结束后只输出 DONE」，派完只回复 taskId。'   # 票07修复4：防教学清理误删 fixture
  TZ=$(new_task_since "$SNAP") || { fail "Case11: 无新任务"; TZ=""; }
  if [ -n "$TZ" ]; then
    TZID=$(basename "$TZ" .json); SMOKE_TASKS="$SMOKE_TASKS $TZID"
    PZ=""; S=""
    for ((i=0;i<60;i++)); do PZ=$(task_paneid "$TZ"); S=$(task_status "$TZ"); [ "$S" = "running" ] && [ -n "$PZ" ] && break; sleep 0.5; done
    if [ "$S" = "running" ] && [ -n "$PZ" ]; then
      pass "Case11: 僵尸 fixture 就绪（running + paneId=${PZ}）"
      [ -n "$DRIVER_PID" ] || fail "Case11: driver pid 为空"
      # SIGKILL（不走 shutdown）：任务记录保持 running = 僵尸（无 cleanup 收口）
      kill -KILL "$DRIVER_PID" 2>/dev/null
      say "Case11: 已 SIGKILL driver（pid=${DRIVER_PID}）→ 死 owner running 僵尸"
      sleep 3
      S=$(task_status "$TZ")
      # 票07修复6：中间态不对齐硬断言——reap 是特性非 bug，可能早于新 driver 启动被主循环探测
      # （状态直接转 aborted 亦可）；唯一不可接受 = 被误判 failed/cancelled（死 owner 不应判失败）。
      # 僵尸成立/收口由「重启后 reap→aborted + 通知 + 清理」后续断言覆盖，此处只防误判。
      case "$S" in
        running) pass "Case11: SIGKILL 后任务记录仍 running（死 owner 僵尸成立）";;
        aborted) say "ℹ️ Case11: SIGKILL 后已转 aborted（reap 先于断言探测，非误判——后续 reap 断言仍覆盖）";;
        *) fail "Case11: SIGKILL 后任务被误判为 ${S}（预期 running/aborted，死 owner 不应 failed/cancelled）";;
      esac
      # 重启 driver C：session_start 先 reap 死 owner running → aborted，再 replay 补发 farm.done（写 notifiedAt）
      DRIVER_PANE=""; DRIVER_PID=""
      : > "$DRIVER_PID_FILE"
      WIN_OUT=$(wezterm cli spawn --new-window --cwd "$HOME" -- bash -lc 'export PI_AGENT_TEAMS_ROOT="$1"; echo $$ > "$0"; exec pi' "$DRIVER_PID_FILE" "$SMOKE_FARM" 2>&1) || { fail "Case11: 重启测试窗口失败: $WIN_OUT"; }
      DRIVER_PANE=$(printf '%s' "$WIN_OUT" | tail -1 | tr -cd '0-9')
      [ -n "$DRIVER_PANE" ] || { fail "Case11: 取不到重启后 pane-id"; DRIVER_PANE=""; }
      if [ -n "$DRIVER_PANE" ]; then
        for ((i=0;i<50;i++)); do [ -s "$DRIVER_PID_FILE" ] && break; sleep 0.2; done
        DRIVER_PID=$(cat "$DRIVER_PID_FILE" 2>/dev/null)
        say "Case11: 新 driver pane=$DRIVER_PANE pid=$DRIVER_PID"
        sleep 10   # pi TUI 启动 + session_start reap/replay
        S=""
        for ((i=0;i<60;i++)); do S=$(task_status "$TZ"); [ "$S" = "aborted" ] && break; sleep 1; done
        [ "$S" = "aborted" ] && pass "Case11: 死 owner running 已被 reap → aborted" || fail "Case11: 60s 内未 reap（status=${S}）"
        N=$(task_notif "$TZ"); [ -n "$N" ] && [ "$N" != "0" ] || fail "Case11: reap 后未通知（notifiedAt 空，清理守卫不过）"
        # 僵尸 pane 收敛（reap killSync 或随 driver 窗口关闭，两路径均应收敛）
        if [ "$S" = "aborted" ] && [ -n "$PZ" ]; then
          STILL=$(wezterm cli --no-auto-start list --format json 2>/dev/null | node -e '
            let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{const p=JSON.parse(d);console.log(p.some(x=>String(x.pane_id)===process.argv[1])?"1":"0")}catch{console.log("-1")}})' "$PZ")
          [ "$STILL" = "0" ] && pass "Case11: 僵尸 pane 已收敛" || fail "Case11: 僵尸 pane 仍存活"
        fi
        # 清理闭环：reap 僵尸入 farm_cleanup 管辖，回收链闭环
        # 票07修复6：aborted 默认排除是设计（spec D5/aborted 例外）——清理断言必须显式点名
        # status=aborted + confirm=true，否则断言与设计冲突必然失败；删除=文件级硬断言
        # （发出指令后轮询 90s 任务文件消失即 pass，不依赖 ==R11== marker 文本）。
        if [ "$S" = "aborted" ] && [ -n "$N" ] && [ "$N" != "0" ]; then
          send '请调用 farm_cleanup 工具，status 参数传 aborted（必须显式点名，aborted 默认排除），confirm 传 true。回复第一行写「==R11==」，然后原样贴出返回文本。'
          GONE=0
          for ((i=0;i<90;i++)); do [ ! -f "$TZ" ] && { GONE=1; break; }; sleep 1; done
          if [ "$GONE" = "1" ]; then
            pass "Case11: reap 僵尸已清理（回收链闭环，文件级硬断言）"
          elif wait_text "==R11==" 15; then
            fail "Case11: reap 僵尸未被清理（==R11== 已出现但 90s 文件仍在——清理未生效或 driver 未传 status=aborted）"
          else
            fail "Case11: reap 僵尸未清理且未见 ==R11==（driver 未执行 confirm？）"
          fi
        fi
      fi
    else
      say "ℹ️ Case11: fixture 未 running（status=$S pane=${PZ}），跳过僵尸回收"
    fi
  fi
fi   # 重启 driver 成功分支（Case6-11）

# ── 7. 汇总 ────────────────────────────────────────────────
say
if [ "$FAIL" = "0" ]; then
  say "🎉 smoke 全绿"
else
  say "💥 smoke 失败（见上方 ❌）"
fi
exit "$FAIL"
