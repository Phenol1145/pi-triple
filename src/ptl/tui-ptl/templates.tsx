import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import fs from "node:fs";
import path from "node:path";
import {
  DataTable,
  SelectList,
  ConfirmDialog,
  theme,
} from "../tui-shared/index.js";
import type { ColumnDef, SelectItem } from "../tui-shared/index.js";
import {
  loadConfig,
  listTemplates,
  createTemplate,
  removeTemplate,
  saveConfig,
  getTemplateAlias,
  resolveDataDir,
  renameTemplate,
} from "../config.js";

interface TenantsPageProps {
  width: number;
  height: number;
  enabled?: boolean;
}

type Mode = "list" | "new-alias" | "delete-confirm" | "set-default-confirm" | "rename-select" | "rename-input";

export function TemplatesPage({ width, height: _h, enabled = true }: TenantsPageProps) {
  const [mode, setMode] = useState<Mode>("list");
  const [aliasInput, setAliasInput] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleteAlias, setDeleteAlias] = useState("");
  const [renameTarget, setRenameTarget] = useState<string | null>(null);
  const [renameAlias, setRenameAlias] = useState("");
  const config = loadConfig();
  const templates = listTemplates(config);

  useInput((input, key) => {
    if (!enabled) return;
    if (mode === "list") {
      if (input === "n") { setMode("new-alias"); setAliasInput(""); return; }
      if (input === "r") { setMode("rename-select"); return; }
      if (input === "d") return; // handled per-row via select
      if (input === "s") return; // handled per-row via select
      if (key.escape && mode === "list") return; // parent handles quit
    }
    if (mode === "new-alias") {
      if (key.return) {
        if (aliasInput.trim()) {
          const id = createTemplate(aliasInput.trim(), {}, config);
          const dir = path.join(resolveDataDir(config), "pi-config", id);
          fs.mkdirSync(dir, { recursive: true });
          setMode("list");
          setAliasInput("");
        }
        return;
      }
      if (key.escape) { setMode("list"); setAliasInput(""); return; }
      if (key.backspace) { setAliasInput((s) => s.slice(0, -1)); return; }
      if (input && !key.ctrl && !key.meta) { setAliasInput((s) => s + input); return; }
    }
    if (mode === "rename-input") {
      if (key.return) {
        if (renameAlias.trim() && renameTarget) {
          renameTemplate(renameTarget, renameAlias.trim(), loadConfig());
          setMode("list");
          setRenameTarget(null);
          setRenameAlias("");
        }
        return;
      }
      if (key.escape) { setMode("list"); setRenameTarget(null); setRenameAlias(""); return; }
      if (key.backspace) { setRenameAlias((s) => s.slice(0, -1)); return; }
      if (input && !key.ctrl && !key.meta) { setRenameAlias((s) => s + input); return; }
    }
  });

  const templateCols: ColumnDef[] = [
    { key: "alias", label: "ALIAS", width: 16 },
    { key: "id", label: "ID" },
    { key: "model", label: "MODEL", width: 22 },
    { key: "default", label: "DEF", width: 5 },
  ];

  const templateRows = templates.map((t) => ({
    alias: t.alias,
    id: t.id.slice(0, 8) + "…",
    model: t.config.model ?? "(default)",
    default: t.isDefault ? "★" : "",
  }));

  // Convert to SelectList items
  const selectItems: SelectItem[] = templates.map((t) => ({
    label: `${t.isDefault ? "★ " : "  "}${t.alias.padEnd(16)} ${t.id.slice(0, 8)}…`,
    value: t.id,
    hint: t.config.model || "",
  }));

  const handleSetDefault = (templateId: string) => {
    const cfg = loadConfig();
    cfg.defaultTemplate = templateId;
    saveConfig(cfg);
    setMode("list");
  };

  if (mode === "new-alias") {
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>New Tenant</Text>
        <Box>
          <Text color={theme.primary}>Alias: </Text>
          <Text>{aliasInput}</Text>
          <Text dimColor>█</Text>
        </Box>
        <Text dimColor>Enter to confirm, Esc to cancel</Text>
      </Box>
    );
  }

  if (mode === "delete-confirm" && deleteTarget) {
    return (
      <Box flexDirection="column" gap={1}>
        <ConfirmDialog
          message={`Delete template "${deleteAlias}" and all its data?`}
          onConfirm={() => {
            const cfg = loadConfig();
            removeTemplate(deleteTarget, cfg);
            // cascade rm directories
            const dataDir = resolveDataDir(cfg);
            for (const sub of ["pi-config", "sessions", "workspaces", "mailbox"]) {
              const p = path.join(dataDir, sub, deleteTarget);
              try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ok */ }
            }
            setMode("list");
            setDeleteTarget(null);
          }}
          onCancel={() => { setMode("list"); setDeleteTarget(null); }}
        />
      </Box>
    );
  }

  if (mode === "set-default-confirm") {
    return (
      <Box flexDirection="column" gap={1}>
        <SelectList
          enabled={enabled}
          title="Select template to set as default"
          items={selectItems}
          onSelect={(id) => {
            handleSetDefault(id);
            setMode("list");
          }}
          onCancel={() => setMode("list")}
        />
      </Box>
    );
  }

  if (mode === "rename-select") {
    return (
      <Box flexDirection="column" gap={1}>
        <SelectList
          enabled={enabled}
          title="Select template to rename"
          items={selectItems}
          onSelect={(id) => {
            setRenameTarget(id);
            setRenameAlias(getTemplateAlias(id, config));
            setMode("rename-input");
          }}
          onCancel={() => setMode("list")}
        />
      </Box>
    );
  }

  if (mode === "rename-input") {
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>Rename Tenant</Text>
        <Box>
          <Text color={theme.primary}>New alias: </Text>
          <Text>{renameAlias}</Text>
          <Text dimColor>█</Text>
        </Box>
        <Text dimColor>Enter to confirm, Esc to cancel</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Box justifyContent="space-between">
        <Text bold underline>Templates ({templates.length})</Text>
        <Text dimColor>[n] new</Text>
      </Box>

      <DataTable columns={templateCols} rows={templateRows} />

      <Box marginTop={1} flexDirection="column">
        <Text bold>Select template to manage:</Text>
        <SelectList
          enabled={enabled}
          items={selectItems}
          onSelect={(id) => {
            setDeleteTarget(id);
            setDeleteAlias(getTemplateAlias(id, config));
            setMode("delete-confirm");
          }}
          title="Select template to delete or [s] to set default"
        />
        <Text dimColor>
          [Enter] select to delete · Press 's' on the select screen to set as default · [n] new
        </Text>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>[n] 新建 · [r] 重命名 · [d] 删除 · [s] 设为默认 · / 命令模式</Text>
      </Box>
    </Box>
  );
}
