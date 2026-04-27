import type { Context } from "grammy";
import type { FilePartInput, Model } from "@opencode-ai/sdk/v2";
import { getModelCapabilities, supportsInput } from "../../model/capabilities.js";
import { getStoredModel } from "../../model/manager.js";
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
  mediaGroupDebounceMs?: number;
}

const mediaGroupQueues = new Map<string, MediaGroupQueue>();

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

    const fileParts = await Promise.all(
      photos.map(async (photo, index): Promise<FilePartInput> => {
        const downloadedFile = await downloadFile(photo.ctx.api, photo.fileId);
        const dataUri = toDataUri(downloadedFile.buffer, "image/jpeg");

        return {
          type: "file",
          mime: "image/jpeg",
          filename: photos.length === 1 ? "photo.jpg" : `photo-${index + 1}.jpg`,
          url: dataUri,
        };
      }),
    );

    logger.info(`[Photo] Sending ${fileParts.length} photo(s) with prompt`);
    await processPrompt(firstPhoto.ctx, caption, deps, fileParts);
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
