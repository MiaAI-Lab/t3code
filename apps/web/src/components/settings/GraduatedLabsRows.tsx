import { ToolCallVisibility } from "@t3tools/contracts/settings";
import * as Schema from "effect/Schema";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

// Graduated from Labs: sidebar layout lives in General, tool calls in Chat.

export function BoringSidebarRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...searchableSetting("boring-sidebar")}
      description="Group sidebar threads into project folders. Pinned threads stay on top, and Snoozed and Done stay below the folders."
      control={
        <Switch
          checked={settings.boringSidebarEnabled || settings.legacySidebarEnabled}
          // Turning it off also clears the opt-in of the removed legacy sidebar.
          onCheckedChange={(checked) =>
            updateSettings({ boringSidebarEnabled: Boolean(checked), legacySidebarEnabled: false })
          }
          aria-label="Group threads by project"
        />
      }
    />
  );
}

export function BoringSidebarMultilineRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...searchableSetting("boring-sidebar-multiline")}
      description="With threads grouped by project, show each on two lines: the title, then the branch, pull request, and agent."
      control={
        <Switch
          checked={settings.boringSidebarMultilineRows}
          onCheckedChange={(checked) =>
            updateSettings({ boringSidebarMultilineRows: Boolean(checked) })
          }
          aria-label="Two-line folder rows"
        />
      }
    />
  );
}

const TOOL_CALL_VISIBILITY_LABELS: Record<ToolCallVisibility, string> = {
  showAll: "Show all",
  hideSuccessful: "Hide successful",
  hideAll: "Hide all",
  zen: "Zen",
};

const isToolCallVisibility = Schema.is(ToolCallVisibility);

export function ToolCallVisibilityRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...searchableSetting("tool-call-visibility")}
      description="Hide the commands, edits, and searches agents run. Hide successful keeps failures. Zen shows only final answers. Approvals, questions, and errors always show."
      control={
        <div className="w-full sm:w-40">
          <Select
            value={settings.toolCallVisibility}
            onValueChange={(value) => {
              if (isToolCallVisibility(value)) updateSettings({ toolCallVisibility: value });
            }}
          >
            <SelectTrigger size="sm" className="w-full min-w-0" aria-label="Tool calls in chat">
              <SelectValue>{TOOL_CALL_VISIBILITY_LABELS[settings.toolCallVisibility]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value="showAll">Show all</SelectItem>
              <SelectItem value="hideSuccessful">Hide successful</SelectItem>
              <SelectItem value="hideAll">Hide all</SelectItem>
              <SelectItem value="zen">Zen</SelectItem>
            </SelectPopup>
          </Select>
        </div>
      }
    />
  );
}
