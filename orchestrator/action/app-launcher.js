// R6 - First Safe Executor. The one and only place in this repository that
// is allowed to start a Windows process on behalf of an action.
//
// Hard boundary, restated from the R6 spec because it is the entire point
// of this file: there is no run(command), no exec(shellString), no
// Start-Process from model output. Every launchable app has a fixed,
// code-defined executable path and a fixed, code-defined argument list -
// never a path or argument that came from a caller, a question, or a
// parameter value beyond selecting *which* of these fixed entries to run.
// child_process.spawn() is always called with shell:false.
//
// Scope: app.open only, and only for the apps listed in APP_LAUNCH_DEFINITIONS
// below. Adding an app is a code change to this allowlist, never a runtime
// or config-file registration path (see action-registry.js's own "no
// user-editable arbitrary config" boundary note).
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

// Both paths are derived from OS-provided environment variables
// (LOCALAPPDATA), never from a user-editable settings file and never from
// caller input - only the fixed suffix path segments below are code-defined.
// Verified present on this machine during the R6 audit (2026-08-21):
//   spotify:  an App Execution Alias reparse point Windows resolves itself;
//             spawning it directly is the standard, supported way to start
//             a Microsoft Store app from a native process.
//   obsidian: a regular per-user Programs install.
function localAppData() {
  return process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Local");
}

const APP_LAUNCH_DEFINITIONS = Object.freeze({
  spotify: Object.freeze({
    exePath: path.join(localAppData(), "Microsoft", "WindowsApps", "Spotify.exe"),
    args: Object.freeze([])
  }),
  obsidian: Object.freeze({
    exePath: path.join(localAppData(), "Programs", "Obsidian", "Obsidian.exe"),
    args: Object.freeze([])
  })
});

async function defaultExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function launchError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// Resolves once the OS confirms the process actually started ("spawn"),
// rejects on a genuine launch failure ("error", e.g. the binary could not
// be executed). unref() lets this process exit independently of the
// launched app - "fire and forget", never tracked or controlled afterwards.
// If the app is already running, Windows/the app itself decides what a
// second launch does (typically: focus the existing window); this executor
// does not attempt any window-control automation of its own (out of scope
// for R6, see spec item 6).
function spawnDetached(exePath, args, spawnImpl) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let child;
    try {
      child = spawnImpl(exePath, args, { shell: false, detached: true, stdio: "ignore", windowsHide: false });
    } catch (error) {
      reject(error);
      return;
    }
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once("spawn", () => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve();
    });
  });
}

export function createAppLauncher({ spawnImpl = spawn, existsImpl = defaultExists } = {}) {
  return {
    // The single entry point. appId must already be one of the registry's
    // own validated enum values (action-registry.js's app.open.target) -
    // this function still re-checks against its own fixed allowlist rather
    // than trusting the caller, so it never depends on the registry's
    // parameter schema staying in sync with what can actually be launched.
    async launch(appId) {
      const definition = APP_LAUNCH_DEFINITIONS[appId];
      if (!definition) throw launchError("APP_NOT_ALLOWED", `"${appId}" is not in the app-launch allowlist.`);

      const installed = await existsImpl(definition.exePath);
      if (!installed) throw launchError("APP_NOT_INSTALLED", `"${appId}" launcher was not found at its configured path.`);

      try {
        await spawnDetached(definition.exePath, definition.args, spawnImpl);
      } catch {
        throw launchError("APP_LAUNCH_FAILED", `"${appId}" could not be launched.`);
      }

      return Object.freeze({ ok: true, app: appId, state: "opened" });
    }
  };
}

export const appLauncher = createAppLauncher();
