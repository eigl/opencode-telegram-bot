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

const MEDIA_GROUP_DEBOUNCE_MS = 1000;

type PhotoSize = {
  file_id: string;
};

type QueuedPhoto = {
  ctx: Context;
  fileId: string;
  caption: string;
};

type MediaGroupQueue = {
  timer?: ReturnType<typeof setTimeout>;
  photos: QueuedPhoto[];
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
  mediaGroupDebounceMs?: number;
}

const mediaGroupQueues = new Map<string, MediaGroupQueue>();

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

function getMediaGroupKey(ctx: Context, mediaGroupId: string): string {
  return `${ctx.chat?.id ?? "unknown"}:${mediaGroupId}`;
}

async function processPhotos(photos: QueuedPhoto[], deps: PhotoHandlerDeps): Promise<void> {
  const firstPhoto = photos[0];
  if (!firstPhoto) {
    return;
  }

  const downloadFile = deps.downloadFile ?? downloadTelegramFile;
  const getCapabilities = deps.getModelCapabilities ?? getModelCapabilities;
  const getStored = deps.getStoredModel ?? getStoredModel;
  const processPrompt = deps.processPrompt ?? processUserPrompt;
  const saveFile = deps.savePhotoFile ?? savePhotoFile;
  const caption = photos.find((photo) => photo.caption.trim().length > 0)?.caption ?? "";

  try {
    const storedModel = getStored();
    const capabilities = await getCapabilities(storedModel.providerID, storedModel.modelID);

    if (!supportsInput(capabilities, "image")) {
      logger.warn(
        `[Photo] Model ${storedModel.providerID}/${storedModel.modelID} doesn't support image input`,
      );
      await firstPhoto.ctx.reply(t("bot.photo_model_no_image"));

      if (caption.trim().length > 0) {
        await processPrompt(firstPhoto.ctx, caption, deps);
      }
      return;
    }

    await firstPhoto.ctx.reply(t("bot.photo_downloading"));
    const requestId = new Date().toISOString().replace(/[:.]/g, "-");

    const downloadedPhotos = await Promise.all(
      photos.map(async (photo, index) => {
        const downloadedFile = await downloadFile(photo.ctx.api, photo.fileId);
        const filename = photos.length === 1 ? "photo.jpg" : `photo-${index + 1}.jpg`;
        const savedPath = await saveFile(downloadedFile.buffer, filename, requestId).catch((err) => {
          logger.warn(`[Photo] Failed to save local Telegram photo copy: ${filename}`, err);
          return null;
        });

        return {
          buffer: downloadedFile.buffer,
          filename,
          savedPath,
        };
      }),
    );

    const fileParts = downloadedPhotos.map((photo): FilePartInput => ({
      type: "file",
      mime: "image/jpeg",
      filename: photo.filename,
      url: toDataUri(photo.buffer, "image/jpeg"),
    }));

    const promptText = appendSavedPhotoPaths(
      caption,
      downloadedPhotos.flatMap((photo) => (photo.savedPath ? [photo.savedPath] : [])),
    );

    logger.info(`[Photo] Sending ${fileParts.length} photo(s) with prompt`);
    await processPrompt(firstPhoto.ctx, promptText, deps, fileParts);
  } catch (err) {
    logger.error("[Photo] Error handling photo message:", err);
    await firstPhoto.ctx.reply(t("bot.photo_download_error"));
  }
}

export async function handlePhotoMessage(ctx: Context, deps: PhotoHandlerDeps): Promise<void> {
  const largestPhoto = getLargestPhoto(ctx.message?.photo);
  if (!largestPhoto) {
    return;
  }

  const queuedPhoto: QueuedPhoto = {
    ctx,
    fileId: largestPhoto.file_id,
    caption: ctx.message?.caption || "",
  };
  const mediaGroupId = ctx.message?.media_group_id;

  if (!mediaGroupId) {
    await processPhotos([queuedPhoto], deps);
    return;
  }

  const key = getMediaGroupKey(ctx, mediaGroupId);
  let queue = mediaGroupQueues.get(key);
  if (queue) {
    if (queue.timer) {
      clearTimeout(queue.timer);
    }
    queue.photos.push(queuedPhoto);
  } else {
    queue = { photos: [queuedPhoto] };
    mediaGroupQueues.set(key, queue);
  }

  queue.timer = setTimeout(() => {
    mediaGroupQueues.delete(key);
    void processPhotos(queue.photos, deps);
  }, deps.mediaGroupDebounceMs ?? MEDIA_GROUP_DEBOUNCE_MS);
}

export function clearPhotoMediaGroupQueues(): void {
  for (const queue of mediaGroupQueues.values()) {
    if (queue.timer) {
      clearTimeout(queue.timer);
    }
  }
  mediaGroupQueues.clear();
}
