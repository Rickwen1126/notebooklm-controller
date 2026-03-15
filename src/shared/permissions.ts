/**
 * T104: File permission enforcement for ~/.nbctl/ directory.
 *
 * Ensures all directories are 0o700 and all files are 0o600 on startup.
 * If permissions are wrong, fixes them and logs a warning.
 */

import { stat, chmod, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { NBCTL_HOME, DIR_PERMISSION, FILE_PERMISSION } from "./config.js";
import { logger } from "./logger.js";

const log = logger.child({ module: "permissions" });

/**
 * Enforce secure permissions on the ~/.nbctl/ directory tree.
 *
 * - Creates ~/.nbctl/ with mode 0o700 if it does not exist.
 * - Walks all subdirectories: ensures each is 0o700.
 * - Walks all files: ensures each is 0o600.
 * - If permissions are wrong, fixes them and logs a warning.
 */
export async function enforcePermissions(rootDir: string = NBCTL_HOME): Promise<void> {
  // 1. Create root directory if it doesn't exist.
  try {
    const rootStat = await stat(rootDir);
    if (!rootStat.isDirectory()) {
      throw new Error(`${rootDir} exists but is not a directory`);
    }
    // Check and fix root directory permissions.
    const currentMode = rootStat.mode & 0o777;
    if (currentMode !== DIR_PERMISSION) {
      log.warn("Fixing directory permissions", {
        path: rootDir,
        was: `0o${currentMode.toString(8)}`,
        fixed: `0o${DIR_PERMISSION.toString(8)}`,
      });
      await chmod(rootDir, DIR_PERMISSION);
    }
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      log.info("Creating nbctl home directory", { path: rootDir });
      await mkdir(rootDir, { mode: DIR_PERMISSION, recursive: true });
      return; // Fresh directory, nothing to walk.
    }
    throw err;
  }

  // 2. Walk the directory tree and fix permissions.
  await walkAndFix(rootDir);
}

/**
 * Recursively walk a directory and fix permissions on all entries.
 */
async function walkAndFix(dirPath: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    // Directory might have been removed between readdir and stat.
    return;
  }

  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);

    try {
      const entryStat = await stat(fullPath);
      const currentMode = entryStat.mode & 0o777;

      if (entryStat.isDirectory()) {
        if (currentMode !== DIR_PERMISSION) {
          log.warn("Fixing directory permissions", {
            path: fullPath,
            was: `0o${currentMode.toString(8)}`,
            fixed: `0o${DIR_PERMISSION.toString(8)}`,
          });
          await chmod(fullPath, DIR_PERMISSION);
        }
        // Recurse into subdirectory.
        await walkAndFix(fullPath);
      } else if (entryStat.isFile()) {
        if (currentMode !== FILE_PERMISSION) {
          log.warn("Fixing file permissions", {
            path: fullPath,
            was: `0o${currentMode.toString(8)}`,
            fixed: `0o${FILE_PERMISSION.toString(8)}`,
          });
          await chmod(fullPath, FILE_PERMISSION);
        }
      }
    } catch {
      // File might have been removed between readdir and stat — skip.
    }
  }
}
