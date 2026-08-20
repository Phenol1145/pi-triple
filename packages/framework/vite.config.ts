import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import preact from "@preact/preset-vite";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const webRoot = join(packageRoot, "web", "operator-console-src");
const outDir = join(packageRoot, "dist", "operator-console", "public");

/**
 * Fixed set of build artifacts the loopback server is allowed to serve.
 * The manifest is written after the bundle so digests always match disk.
 */
const MANIFEST_ENTRIES = ["index.html", "assets/index.js", "assets/index.css"] as const;

function assetManifestPlugin(): Plugin {
  return {
    name: "operator-console-asset-manifest",
    apply: "build",
    writeBundle() {
      const manifest: Record<string, { path: string; sha256: string }> = {};
      for (const rel of MANIFEST_ENTRIES) {
        const content = readFileSync(join(outDir, rel));
        manifest[rel] = {
          path: rel,
          sha256: createHash("sha256").update(content).digest("hex"),
        };
      }
      writeFileSync(
        join(outDir, "asset-manifest.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
      );
    },
  };
}

export default defineConfig({
  base: "/",
  root: webRoot,
  plugins: [preact(), assetManifestPlugin()],
  build: {
    outDir,
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      output: {
        entryFileNames: "assets/index.js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: (assetInfo) => {
          const names = assetInfo.names ?? [];
          return names.some((name) => name.endsWith(".css"))
            ? "assets/index.css"
            : "assets/[name][extname]";
        },
      },
    },
  },
});
