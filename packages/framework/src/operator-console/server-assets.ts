/**
 * operator-console/server-assets.ts —— console server 的冻结静态资源加载。
 *
 * 从 server.ts 拆出：负责解析编译产物/源码目录并预载 ASSET_MIME 白名单；
 * 启动时缺失任一资源即抛错（fail-closed）。
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ASSET_MIME, KNOWN_ASSETS } from "./server-http.js";

function resolveAssetDirectory(): string {
  // 编译产物：dist/operator-console/public；源码 tsx/vitest：web/operator-console
  const compiled = fileURLToPath(new URL("./public/", import.meta.url));
  const source = fileURLToPath(new URL("../../web/operator-console/", import.meta.url));
  return existsSync(path.join(compiled, "index.html")) ? compiled : source;
}

export function loadOperatorConsoleAssets(): Map<string, Buffer> {
  const assetDir = resolveAssetDirectory();
  const assets = new Map<string, Buffer>();
  for (const filename of KNOWN_ASSETS) {
    const fullPath = path.join(assetDir, filename);
    if (!existsSync(fullPath)) {
      throw new Error(`operator console asset missing: ${fullPath}`);
    }
    assets.set(filename, readFileSync(fullPath));
  }
  return assets;
}

export { ASSET_MIME, KNOWN_ASSETS };
