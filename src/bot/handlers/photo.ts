import type { Context } from "grammy";
import type { FilePartInput, Model } from "@opencode-ai/sdk/v2";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { getModelCapabilities, supportsInput } from "../../model/capabilities.js";
import { getStoredModel } from "../../model/manager.js";
import { getCurrentProject } from "../../settings/manager.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../i18n/index.js";
import { downloadTelegramFile, toDataUri } from "../utils/file-download.js";
import { processUserPrompt, type ProcessPromptDeps } from "./prompt.js";

type PhotoSize = {
  file_id: string;
};

export interface PhotoHandlerDeps extends ProcessPromptDeps {
  downloadFile?: (
    api: Context["api"],
    fileId: string,
  ) => Promise<{ buffer: Buffer; filePath: string }>;
  getModelCapabilities?: (
    providerId: string,
    modelId: string,
  ) => Promise<Model["capabilities"] | null>;
  getStoredModel?: () => { providerID: string; modelID: string };
  processPrompt?: (
    ctx: Context,
    text: string,
    deps: ProcessPromptDeps,
    fileParts?: FilePartInput[],
  ) => Promise<boolean>;
  savePhotoFile?: (buffer: Buffer, filename: string, requestId: string) => Promise<string | null>;
}

function sanitizeFilename(filename: string): string {
  return path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, "_") || "photo.jpg";
}

async function savePhotoFile(
  buffer: Buffer,
  filename: string,
  requestId: string,
): Promise<string | null> {
  const project = getCurrentProject();
  if (!project?.worktree) {
    return null;
  }

  const outputDirectory = path.join(
    project.worktree,
    "_output",
    "telegram-image-requests",
    requestId,
    "input",
  );
  await fs.mkdir(outputDirectory, { recursive: true });

  const savedPath = path.join(outputDirectory, sanitizeFilename(filename));
  await fs.writeFile(savedPath, buffer);

  return path.relative(project.worktree, savedPath).replace(/\\/g, "/");
}

function appendSavedPhotoPaths(caption: string, savedPaths: string[]): string {
  const paths = savedPaths.filter((savedPath) => savedPath.trim().length > 0);
  if (paths.length === 0) {
    return caption;
  }

  const prefix = caption.trim().length > 0 ? caption.trim() : "See attached Telegram image.";
  return [
    prefix,
    "",
    "Telegram image local copy path(s):",
    ...paths.map((savedPath) => `- ${savedPath}`),
  ].join("\n");
}

function getLargestPhoto(photos: readonly PhotoSize[] | undefined): PhotoSize | null {
  if (!photos || photos.length === 0) {
    return null;
  }

  return photos[photos.length - 1] ?? null;
}

export async function handlePhotoMessage(ctx: Context, deps: PhotoHandlerDeps): Promise<void> {
  const largestPhoto = getLargestPhoto(ctx.message?.photo);
  if (!largestPhoto) {
    return;
  }

  const downloadFile = deps.downloadFile ?? downloadTelegramFile;
  const getCapabilities = deps.getModelCapabilities ?? getModelCapabilities;
  const getStored = deps.getStoredModel ?? getStoredModel;
  const processPrompt = deps.processPrompt ?? processUserPrompt;
  const saveFile = deps.savePhotoFile ?? savePhotoFile;
  const caption = ctx.message?.caption || "";

  try {
    const storedModel = getStored();
    const capabilities = await getCapabilities(storedModel.providerID, storedModel.modelID);

    if (!supportsInput(capabilities, "image")) {
      logger.warn(
        `[Photo] Model ${storedModel.providerID}/${storedModel.modelID} doesn't support image input`,
      );
      await ctx.reply(t("bot.photo_model_no_image"));

      if (caption.trim().length > 0) {
        await processPrompt(ctx, caption, deps);
      }
      return;
    }

    await ctx.reply(t("bot.photo_downloading"));
    const requestId = new Date().toISOString().replace(/[:.]/g, "-");
    const downloadedFile = await downloadFile(ctx.api, largestPhoto.file_id);
    const filename = "photo.jpg";
    const savedPath = await saveFile(downloadedFile.buffer, filename, requestId).catch((err) => {
      logger.warn(`[Photo] Failed to save local Telegram photo copy: ${filename}`, err);
      return null;
    });

    const filePart: FilePartInput = {
      type: "file",
      mime: "image/jpeg",
      filename,
      url: toDataUri(downloadedFile.buffer, "image/jpeg"),
    };

    const promptText = appendSavedPhotoPaths(
      caption,
      savedPath ? [savedPath] : [],
    );

    logger.info(`[Photo] Sending photo (${downloadedFile.buffer.length} bytes) with prompt`);
    await processPrompt(ctx, promptText, deps, [filePart]);
  } catch (err) {
    logger.error("[Photo] Error handling photo message:", err);
    await ctx.reply(t("bot.photo_download_error"));
  }
}
