import { App, EventRef, MarkdownView, Workspace } from "obsidian";
import { realpathSync, writeFile } from "fs";
import { resolve, sep } from "path";
import { PluginSettings } from "../types";
import { WorkspaceContext } from "./WorkspaceContext";

type ContextManagerDeps = {
  app: App;
  settings: PluginSettings;
  getVaultBasePath: () => string;
  getConfigDir: () => string;
  registerEvent: (ref: EventRef) => void;
};

export class ContextManager {
  private app: App;
  private settings: PluginSettings;
  private workspaceContext: WorkspaceContext;
  private getVaultBasePath: () => string;
  private getConfigDir: () => string;
  private registerEvent: (ref: EventRef) => void;

  private contextEventRefs: EventRef[] = [];
  private contextRefreshTimer: number | null = null;
  private periodicRefreshTimer: number | null = null;

  constructor(deps: ContextManagerDeps) {
    this.app = deps.app;
    this.settings = deps.settings;
    this.workspaceContext = new WorkspaceContext(this.app);
    this.getVaultBasePath = deps.getVaultBasePath;
    this.getConfigDir = deps.getConfigDir;
    this.registerEvent = deps.registerEvent;
  }

  updateSettings(settings: PluginSettings): void {
    const intervalChanged = settings.refreshIntervalMs !== this.settings.refreshIntervalMs;
    const enabledChanged = settings.injectWorkspaceContext !== this.settings.injectWorkspaceContext;
    this.settings = settings;
    this.updateListeners();
    if (settings.injectWorkspaceContext && (intervalChanged || enabledChanged)) {
      this.startPeriodicRefresh();
    }
  }

  /** Start listening (call after settings are loaded). */
  start(): void {
    this.updateListeners();
    this.writeState();
    window.setTimeout(() => this.writeState(), 2000);
    if (this.settings.injectWorkspaceContext) {
      this.startPeriodicRefresh();
    }
  }

  private startPeriodicRefresh(): void {
    this.stopPeriodicRefresh();
    this.periodicRefreshTimer = window.setInterval(
      () => this.writeState(),
      this.settings.refreshIntervalMs
    );
  }

  private stopPeriodicRefresh(): void {
    if (this.periodicRefreshTimer !== null) {
      window.clearInterval(this.periodicRefreshTimer);
      this.periodicRefreshTimer = null;
    }
  }

  private updateListeners(): void {
    if (!this.settings.injectWorkspaceContext) {
      this.clearListeners();
      return;
    }

    // Already listening
    if (this.contextEventRefs.length > 0) {
      return;
    }

    const activeLeafRef = this.app.workspace.on("active-leaf-change", (leaf) => {
      if (leaf?.view instanceof MarkdownView) {
        this.workspaceContext.trackActiveView(leaf.view);
      }
      this.scheduleRefresh();
    });

    const fileOpenRef = this.app.workspace.on("file-open", () => {
      this.scheduleRefresh();
    });

    const fileCloseRef = (this.app.workspace as Workspace & { on(name: "file-close", callback: () => void): EventRef }).on("file-close", () => {
      this.scheduleRefresh();
    });

    const layoutChangeRef = this.app.workspace.on("layout-change", () => {
      this.scheduleRefresh();
    });

    const selectionChangeRef = (this.app.workspace as Workspace & { on(name: "editor-selection-change", callback: (editor: unknown, view: unknown) => void): EventRef }).on(
      "editor-selection-change",
      (_editor: unknown, view: unknown) => {
        if (view instanceof MarkdownView) {
          this.workspaceContext.trackActiveView(view);
        }
        this.scheduleRefresh(200);
      }
    );

    this.contextEventRefs = [
      activeLeafRef,
      fileOpenRef,
      fileCloseRef,
      layoutChangeRef,
      selectionChangeRef,
    ];
    this.contextEventRefs.forEach((ref) => this.registerEvent(ref));
  }

  private clearListeners(): void {
    for (const ref of this.contextEventRefs) {
      this.app.workspace.offref(ref);
    }
    this.contextEventRefs = [];
    if (this.contextRefreshTimer !== null) {
      window.clearTimeout(this.contextRefreshTimer);
      this.contextRefreshTimer = null;
    }
    this.stopPeriodicRefresh();
  }

  private scheduleRefresh(delayMs: number = 300): void {
    if (this.contextRefreshTimer !== null) {
      window.clearTimeout(this.contextRefreshTimer);
    }

    this.contextRefreshTimer = window.setTimeout(() => {
      this.contextRefreshTimer = null;
      this.writeState();
    }, delayMs);
  }

  /** Gather workspace state and write it to .obsidian/context.json */
  private writeState(): void {
    if (!this.settings.injectWorkspaceContext) {
      return;
    }

    const basePath = this.getVaultBasePath();
    if (!basePath) {
      return;
    }

    const state = this.workspaceContext.gatherState(
      this.settings.maxNotesInContext,
      this.settings.maxSelectionLength
    );

    try {
      // Resolve the absolute path and verify it stays within the vault.
      // realpathSync is used on both sides so that symlinks in .obsidian or any
      // ancestor directory cannot redirect the write to an arbitrary FS location
      // even though the lexical path would pass the startsWith() check.
      const realVaultRoot = realpathSync(resolve(basePath)) + sep;

      // .obsidian/ directory is always created by Obsidian itself
      const lexicalPath = resolve(basePath, this.getConfigDir(), "context.json");
      const filePath = realpathSync(lexicalPath);

      // Validate that the real (symlink-resolved) file path is within the vault
      if (!filePath.startsWith(realVaultRoot)) {
        console.error(
          "[AgentContext] Refusing to write outside vault:",
          filePath,
        );
        return;
      }

      writeFile(filePath, JSON.stringify(state, null, 2), "utf-8", (err) => {
        if (err) {
          console.error("[AgentContext] Failed to write context.json:", err);
        }
      });
    } catch (err) {
      console.error("[AgentContext] Failed to write context.json:", err);
    }
  }

  destroy(): void {
    this.clearListeners();
  }
}
