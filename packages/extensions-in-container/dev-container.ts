/**
 * dev 容器工具——/container 命令族的执行层（薄壳）。
 *
 * 安全模型：
 *  - 所有 docker 调用走 execFile(argv 数组)，无宿主 shell 字符串拼接 → 参数不可能逃逸出 argv 边界；
 *  - verify 的整条命令作为 bash -lc 的单一 argv 透传（容器内执行，宿主侧零插值）；
 *  - start 的 --name 服务名白名单正则（/^[A-Za-z0-9][A-Za-z0-9_-]*$/）；
 *  - mount 目录要求存在 + 拒绝换行/冒号字符（YAML 注入防护），写入走 tmp+rename 原子替换。
 *
 * 设计决策（brief 标注项）：
 *  - compose 静态挂载已覆盖主仓库（~/pi-platform:/works/pi-platform:rw），mount 语义 =
 *    "把新目录写进 compose dev.volumes"（skill 文档 §4.2/§5.1），幂等 + 提示 /container start 生效；
 *  - compose 文件定位：显式 opts > 环境变量 PI_CONTAINER_COMPOSE_FILE > 仓库根 docker-compose.yaml
 *    （按本包位置推导，与 skill 文档 wrapper 的 -f ~/pi-platform/docker-compose.yaml 等价）。
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ── 类型 ────────────────────────────────────────────────────

export interface DockerResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 可注入的 docker runner（测试用 fake 替换；默认 realRun 走 execFile） */
export type DockerRun = (argv: string[]) => Promise<DockerResult>;

export interface ContainerOptions {
  /** compose 文件路径；默认仓库根 docker-compose.yaml（可用 PI_CONTAINER_COMPOSE_FILE 覆盖） */
  composeFile?: string;
  /** docker 调用器；默认 child_process execFile("docker", argv) */
  run?: DockerRun;
}

export interface MountResult {
  ok: boolean;
  /** 已存在相同挂载（幂等命中） */
  already?: boolean;
  /** 容器路径 /works/<name> 被其他宿主目录占用 */
  conflict?: boolean;
  /** 写入/已存在的挂载行内容 */
  line?: string;
  error?: string;
}

// ── 常量与消毒 ──────────────────────────────────────────────

/** 服务名/目录名白名单：字母数字开头，仅 [A-Za-z0-9._-]——挡 flag/空格/路径分隔符注入 */
export const SERVICE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** YAML 注入防护：换行/回车/冒号（macOS 路径不含冒号；容器路径由 basename 白名单保证） */
const ILLEGAL_PATH_RE = /[\n\r:]/;

// ── compose 定位 ────────────────────────────────────────────

export function resolveComposeFile(overrides?: string): string {
  if (overrides) return overrides;
  const fromEnv = process.env.PI_CONTAINER_COMPOSE_FILE;
  if (fromEnv) return fromEnv;
  const pkgDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(pkgDir, "..", "..", "docker-compose.yaml");
}

// ── docker 执行 ─────────────────────────────────────────────

export function realRun(argv: string[]): Promise<DockerResult> {
  return new Promise((resolve) => {
    execFile("docker", argv, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) {
        resolve({ code: 0, stdout, stderr });
        return;
      }
      const errno = err as NodeJS.ErrnoException;
      const code = typeof errno.code === "number" ? errno.code : 1; // ENOENT 等非退出码错误（如 docker 未安装）统一按 1
      resolve({ code, stdout, stderr: stderr || String(err.message) });
    });
  });
}

export function dockerArgs(composeFile: string, rest: string[]): string[] {
  return ["compose", "-f", composeFile, ...rest];
}

/** /container start [--name <svc>] → docker compose -f <file> up -d <svc> */
export function startArgs(composeFile: string, service: string): string[] {
  return dockerArgs(composeFile, ["up", "-d", service]);
}

/** /container status → docker compose -f <file> ps dev */
export function statusArgs(composeFile: string): string[] {
  return dockerArgs(composeFile, ["ps", "dev"]);
}

/**
 * /container verify <cmd> → docker compose -f <file> exec -T dev bash -lc -- <cmd>
 * cmd 作为单一 argv（bash -lc 的最后一个参数）——容器内任意命令，宿主侧零插值；
 * -T 非 TTY + 退出码透传（skill 文档 §4.2/§4.4）。
 */
export function verifyArgs(composeFile: string, cmd: string): string[] {
  return dockerArgs(composeFile, ["exec", "-T", "dev", "bash", "-lc", "--", cmd]);
}

// ── mount：编辑 compose dev.volumes ─────────────────────────

function atomicWrite(file: string, content: string): void {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}`);
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

/**
 * 挂载目录：把 `- <host>:/works/<name>:rw` 写进 compose 的 dev.volumes（幂等）。
 * host 部分：目录在 $HOME 下用 ${HOME}/<rel>（与现有 compose 风格一致），否则绝对路径。
 */
export function mountDir(composeFile: string, dirAbs: string): MountResult {
  const abs = path.resolve(dirAbs);
  if (ILLEGAL_PATH_RE.test(abs)) {
    return { ok: false, error: `路径含非法字符（换行/冒号），拒绝写入：${abs}` };
  }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    return { ok: false, error: `目录不存在或不是目录：${abs}` };
  }
  const name = path.basename(abs);
  if (!SERVICE_NAME_RE.test(name)) {
    return { ok: false, error: `目录名不合法（仅 [A-Za-z0-9._-]）：${name}` };
  }
  if (!fs.existsSync(composeFile)) {
    return { ok: false, error: `compose 文件不存在：${composeFile}` };
  }

  const home = os.homedir();
  const hostPart = abs.startsWith(home + path.sep)
    ? `\${HOME}/${abs.slice(home.length + 1)}`
    : abs;
  const line = `      - ${hostPart}:/works/${name}:rw`;

  const raw = fs.readFileSync(composeFile, "utf-8");
  const lines = raw.split("\n");

  // 定位 dev 服务块
  const devIdx = lines.findIndex((l) => /^  dev:/.test(l));
  if (devIdx < 0) return { ok: false, error: "compose 未定义 dev 服务，拒绝写入" };

  // dev 块内定位 volumes:（下一个同级服务键前）
  let volumesIdx = -1;
  for (let i = devIdx + 1; i < lines.length; i++) {
    if (/^  [A-Za-z0-9_-]+:/.test(lines[i])) break;
    if (/^    volumes:/.test(lines[i])) {
      volumesIdx = i;
      break;
    }
  }
  if (volumesIdx < 0) return { ok: false, error: "dev 服务未定义 volumes，拒绝写入" };

  // 最后一条卷条目下标（6 空格缩进 "- "，到下一个 4 空格键为止）
  let lastEntry = -1;
  for (let i = volumesIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^    [A-Za-z0-9_-]+:/.test(l)) break; // volumes 的下一个键
    if (/^      - /.test(l)) lastEntry = i;
  }

  // 冲突/幂等检查：容器路径 /works/<name> 是否已被占用
  const marker = `:/works/${name}:rw`;
  for (let i = volumesIdx + 1; i <= lastEntry; i++) {
    if (lines[i].includes(marker)) {
      if (lines[i].includes(hostPart)) {
        return { ok: true, already: true, line: lines[i].trim() };
      }
      return { ok: false, conflict: true, error: `容器路径 /works/${name} 已被其他挂载占用：${lines[i].trim()}` };
    }
  }

  const insertAt = lastEntry >= 0 ? lastEntry + 1 : volumesIdx + 1;
  lines.splice(insertAt, 0, line);
  atomicWrite(composeFile, lines.join("\n"));
  return { ok: true, line };
}
