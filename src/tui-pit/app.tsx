import React from "react";
import { Box, useInput } from "ink";
import { TopBar, TabBar, StatusBar, useTabs, useTerminalSize } from "../tui-shared/index.js";
import { DashboardPage } from "./dashboard.js";
import { TenantsPage } from "./tenants.js";
import { SessionsPage } from "./sessions.js";
import { ExtensionsPage } from "./extensions.js";
import { ConfigPage } from "./config-page.js";

const TABS = ["Dashboard", "Tenants", "Sessions", "Extensions", "Config"];

export function PitApp() {
  const { activeTab, setActiveTab, tabIndex } = useTabs(TABS);
  const { columns, rows } = useTerminalSize();

  useInput((input, key) => {
    if (key.ctrl && input === "c") process.exit(130);
    if (input === "q" && !key.ctrl) process.exit(0);
  });

  const sharedProps = { width: Math.min(columns, 120), height: rows - 7 };

  return (
    <Box flexDirection="column" width={Math.min(columns, 120)} padding={1}>
      <TopBar title="Pi-Triple Control" version="0.1.0" />

      <TabBar tabs={TABS} activeTab={activeTab} onSelect={setActiveTab} />

      <Box flexDirection="column" minHeight={rows - 9}>
        {tabIndex === 0 && <DashboardPage {...sharedProps} />}
        {tabIndex === 1 && <TenantsPage {...sharedProps} />}
        {tabIndex === 2 && <SessionsPage {...sharedProps} />}
        {tabIndex === 3 && <ExtensionsPage {...sharedProps} />}
        {tabIndex === 4 && <ConfigPage {...sharedProps} />}
      </Box>

      <StatusBar hints="[1-5] Tab · [q] Quit · [Ctrl+C] Force quit" />
    </Box>
  );
}
