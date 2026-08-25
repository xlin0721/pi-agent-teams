// src/node-modules.d.ts
// 零依赖类型门的环境声明（tsconfig.json "types": [] 不引任何 @types 包，本文件是
// 唯一环境类型来源）：
//   - node: 内置模块通配声明 → 任意 import "node:*" 解析为 any（node API 面不设类型，
//     类型门只严格类型化我们自己的逻辑层；评审整改 C2：TS2307 必炸项在此清零）；
//   - 装配层第三方 SDK 包（typebox / pi-coding-agent / pi-ai）→ any——index.ts 是
//     唯一 SDK 边界（运行时边界纪律），装配层第三方 API 面为 any 符合边界定位；
//   - Node 运行时全局最小声明（process/console/定时器/NodeJS 命名空间）——按源码
//     实际用量最小化声明、真实类型（非 any 逃逸）。新增代码不得向本文件塞新全局：
//     Node API 一律走 node: 模块 import。

declare module "node:*";

// 装配层第三方 SDK 包（评审整改 C2）：index.ts 是唯一 SDK 边界，第三方 API 面为
// any——此处逐名声明源码实际使用的导出（全 any），新增 SDK 用法时同步补名。
declare module "typebox" {
  export const Type: any;
}
declare module "@earendil-works/pi-coding-agent" {
  export const VERSION: any;
  export const getAgentDir: any;
  export const parseFrontmatter: any;
  export type ExtensionAPI = any;
}
declare module "@earendil-works/pi-ai" {
  export const StringEnum: any;
}

// node:test 最小类型面（覆盖通配 any：test 回调参数 t 需要 TestContext 才能过
// strict 隐式 any 门；面按测试实际用量声明——test(name, fn) + t.after）。
declare module "node:test" {
  export interface TestContext {
    after(fn: () => void | Promise<void>): void;
  }
  export function test(
    name: string,
    fn: (t: TestContext) => void | Promise<void>,
  ): Promise<void>;
}

// node:assert/strict 最小类型面（覆盖通配 any）：ok/fail 带真实断言签名——
// ok(value) → asserts value、fail() → never，测试里 assert.ok(x !== null) 后的
// null 收窄与 instanceof 收窄依赖这两条（node 官方 @types/node 同款语义）。
// 面按测试实际用量声明：ok/fail/equal/notEqual/deepEqual/match/doesNotMatch/
// throws/rejects（默认导出）。
declare module "node:assert/strict" {
  type AssertExpected =
    | RegExp
    | ((err: unknown) => boolean)
    | (new (...args: any[]) => Error)
    | Error
    | string
    | undefined;

  function ok(value: unknown, message?: string | Error): asserts value;
  function fail(message?: string | Error): never;
  function equal(actual: unknown, expected: unknown, message?: string | Error): void;
  function notEqual(actual: unknown, expected: unknown, message?: string | Error): void;
  function deepEqual(actual: unknown, expected: unknown, message?: string | Error): void;
  function match(value: string, regExp: RegExp, message?: string | Error): void;
  function doesNotMatch(value: string, regExp: RegExp, message?: string | Error): void;
  function throws(
    block: () => unknown,
    expected?: AssertExpected,
    message?: string | Error,
  ): void;
  function rejects(
    block: Promise<unknown> | (() => Promise<unknown>),
    expected?: AssertExpected,
    message?: string | Error,
  ): Promise<void>;

  const assert: {
    ok: typeof ok;
    fail: typeof fail;
    equal: typeof equal;
    notEqual: typeof notEqual;
    deepEqual: typeof deepEqual;
    match: typeof match;
    doesNotMatch: typeof doesNotMatch;
    throws: typeof throws;
    rejects: typeof rejects;
  };
  export default assert;
}

// ── Node 运行时全局最小声明 ─────────────────────────────────────────────────

declare namespace NodeJS {
  /** process.platform 值域（@types/node 同款；split.ts toCliCwd 使用） */
  type Platform =
    | "aix"
    | "android"
    | "darwin"
    | "freebsd"
    | "haiku"
    | "linux"
    | "openbsd"
    | "sunos"
    | "win32"
    | "cygwin"
    | "netbsd";

  /** process.env：字符串索引签名（含 undefined 值，delete 语义合法） */
  interface ProcessEnv {
    [key: string]: string | undefined;
  }
}

/** console 最小面（源码只用 log/warn/error） */
interface FarmConsole {
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

declare const console: FarmConsole;

/** process 最小面（按源码实际用量声明；扩展此面时保持真实类型） */
declare const process: {
  readonly env: NodeJS.ProcessEnv;
  readonly pid: number;
  readonly argv: string[];
  readonly execPath: string;
  readonly platform: NodeJS.Platform;
  readonly stdout: { write(data: string): void };
  readonly stderr: { write(data: string): void };
  /** 存活探测（farm.ts isPidAlive）：signal=0 探测，ESRCH=死 */
  kill(pid: number, signal?: number): void;
  exit(code?: number): never;
  cwd(): string;
  nextTick(callback: (...args: unknown[]) => void): void;
  /** 进程事件注册（display/render-mini 用：exit/SIGTERM/SIGHUP/uncaughtException 收尸） */
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
};

/** 定时器最小面（handle 为 number——node 定时器真实返回 Timeout 对象，源码只作
 *  不透明句柄传递/清除，number 面够用且诚实） */
declare function setTimeout(callback: (...args: unknown[]) => void, ms?: number): number;
declare function clearTimeout(handle?: number): void;
declare function setInterval(callback: (...args: unknown[]) => void, ms?: number): number;
declare function clearInterval(handle?: number): void;

// ── AbortSignal / AbortController（票 TD2）──────────────────────────────────
// Node ≥15 运行时全局（无对应 node: 模块可 import——node:abort_controller 不存在，
// 故「Node API 走 node: import」不适用，归属 Node 运行时全局最小声明）。面按源码
// 实际用量：signal?.aborted 只读判定 + new AbortController() 后 .abort()/.signal。
interface AbortSignal {
  readonly aborted: boolean;
}

interface AbortController {
  readonly signal: AbortSignal;
  abort(): void;
}

declare var AbortController: {
  new (): AbortController;
};

/** import.meta.url（index.ts HERE 定位；ES lib 无 url 字段，node 运行时真实存在） */
interface ImportMeta {
  url: string;
}
