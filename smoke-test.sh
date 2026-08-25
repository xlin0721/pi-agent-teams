#!/bin/bash
# pi-agent-teams v3 smoke test — real WezTerm + full v3 stack
# 驱动 = 专用测试窗口里的 pi TUI（cwd=$HOME 中性环境），经 wezterm send-text 发消息，
# 断言全部走文件协议（tasks/<id>.json / status / sessions / notifiedAt），零第三方依赖。
#
# 任务发现一律 id-diff：发任务前快照 tasks/*.json 的 id 集合，只认快照外的新 id。
# 严禁用文件计数/字母序推断新任务（ls 字母序≠时间序；多农场并存时计数会漂移，
# 曾导致抓陈旧文件、杀错 pane）。
#
# Usage: smoke-test.sh [timeout-secs]   （默认 180s；总时长约 5-8 分钟）
set -u

FARM="${HOME}/.pi-agent-teams"
EXT="$HOME/.pi/agent/extensions/pi-agent-teams"
TIMEOUT="${1:-180}"
FAIL=0
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
WIN_OUT=$(wezterm cli spawn --new-window --cwd "$HOME" -- bash -lc 'echo $$ > "$0"; exec pi' "$DRIVER_PID_FILE" 2>&1) || { fail "测试窗口创建失败: $WIN_OUT"; exit 1; }
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

SNAP="${TMPDIR:-/tmp}/pi-agent-teams-smoke-snap-$$.ids"
SNAP2="${TMPDIR:-/tmp}/pi-agent-teams-smoke-snap2-$$.ids"

# ── 2. Case1 派发→出队→done→自动关窗→farm.done→人设 ──────────
say; say "── Case1 派发 + 完成 + 通知 + 人设 ──"
snapshot_ids "$SNAP"
send '请调用 spawn_visible_agent 工具派发一个 worker 角色，prompt 参数设为「只用一个短句自述你的角色身份」，其余参数用默认。派完只回复我 taskId 本身。'
T1=$(new_task_since "$SNAP") || { fail "Case1: 60s 内无新任务落盘"; }
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
send '请连续调用 spawn_visible_agent 派发 5 个 worker 任务，prompt 分别是「只回答：1+1」「只回答：2+2」「只回答：3+3」「只回答：4+4」「只回答：5+5」，派完只回复「已派 5 个」。'
# id-diff 收集 5 个新任务（最长 90s，容忍 agent 逐批派发）
NEW=""
for ((i=0; i<90; i++)); do
  NEW=$(collect_new "$SNAP" 5)
  NEWN=$(printf '%s' "$NEW" | grep -c json)
  [ "$NEWN" -ge 5 ] && break
  sleep 1
done
NEWN=$(printf '%s' "$NEW" | grep -c json)
[ "$NEWN" -ge 5 ] || fail "Case2: 只发现 $NEWN/5 个新任务"
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
send '请调用 spawn_visible_agent 派发一个 worker 任务，prompt 设为「请用 bash 工具执行 sleep 60，命令结束后只输出 DONE」，派完只回复 taskId。'
T3=$(new_task_since "$SNAP") || { fail "Case3: 无新任务"; T3=""; }
if [ -n "$T3" ]; then
  T3ID=$(basename "$T3" .json); SMOKE_TASKS="$SMOKE_TASKS $T3ID"
  # 0.2s 轮询：paneId 一写回立即 kill（kill 窗口 2-3s，别等 agent 执行 sleep）
  P3=""; S=""
  for ((i=0; i<150; i++)); do
    P3=$(task_paneid "$T3"); [ -n "$P3" ] && break
    S=$(task_status "$T3"); [ "$S" = "done" ] && break
    sleep 0.2
  done
  [ -n "$P3" ] || fail "Case3: paneId 未写回（status=$S，任务可能已完成、错过 kill 窗口）"
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
send '请调用 spawn_visible_agent 派发一个 worker 任务，prompt 设为「请用 bash 工具执行 sleep 120，命令结束后只输出结果」，派完只回复 taskId。'
T4=$(new_task_since "$SNAP") || { fail "Case4: 无新任务"; T4=""; }
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
OUT=$(WEZTERM_UNIX_SOCKET=/tmp/pi-agent-teams-smoke-bogus.sock timeout 60 pi -p -e '请调用 spawn_visible_agent 工具派发一个 worker' 2>&1)
NOW=$(ls "$FARM"/tasks/*.json 2>/dev/null | wc -l | tr -d ' ')
[ "$NOW" = "$BASE" ] || fail "Case5: L1 下仍有任务落盘（${BASE} → ${NOW}）"
[ "$NOW" = "$BASE" ] && pass "Case5: L1 下零落盘（拒绝生效）"
printf '%s' "$OUT" | grep -qiE "subagent|子代理|不可用|降级|拒绝" && pass "Case5: 输出含引导文案" || say "ℹ️ Case5: 输出未检出引导关键词（软断言，不判失败）"

# ── 7. 汇总 ────────────────────────────────────────────────
say
if [ "$FAIL" = "0" ]; then
  say "🎉 smoke 全绿"
else
  say "💥 smoke 失败（见上方 ❌）"
fi
exit "$FAIL"
