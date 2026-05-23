import { link, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { stringifyYaml } from "../domain/schema.js";

export async function writeOnceText(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  const handle = await open(tempPath, "wx");
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await link(tempPath, filePath);
  } finally {
    await rm(tempPath, { force: true });
  }
}

export async function writeOnceYaml(filePath: string, value: unknown): Promise<void> {
  await writeOnceText(filePath, stringifyYaml(value));
}

export async function writeAtomicText(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  await writeFile(tempPath, content);
  try {
    await renameWithRetry(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

export async function writeAtomicYaml(filePath: string, value: unknown): Promise<void> {
  await writeAtomicText(filePath, stringifyYaml(value));
}

export function isFileAlreadyExistsError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "EEXIST"
  );
}

async function renameWithRetry(source: string, destination: string): Promise<void> {
  const maxAttempts = 8;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      if (!isTransientRenameError(error) || attempt === maxAttempts) {
        throw error;
      }

      await delay(10 * attempt);
    }
  }
}

function isTransientRenameError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ((error as { readonly code?: unknown }).code === "EPERM" ||
      (error as { readonly code?: unknown }).code === "EBUSY")
  );
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
