import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";
import { handlePhotoMessage, type PhotoHandlerDeps } from "../../../src/bot/handlers/photo.js";
import { t } from "../../../src/i18n/index.js";

function createPhotoContext(overrides: Partial<Context["message"]> = {}): {
  ctx: Context;
  replyMock: ReturnType<typeof vi.fn>;
} {
  const replyMock = vi.fn().mockResolvedValue({ message_id: 101 });

  const ctx = {
    chat: { id: 777 },
    message: {
      photo: [
        { file_id: "small-photo", file_unique_id: "small", width: 90, height: 90 },
        { file_id: "large-photo", file_unique_id: "large", width: 1280, height: 720 },
      ],
      caption: "Analyze this",
      ...overrides,
    },
    reply: replyMock,
    api: {},
  } as unknown as Context;

  return { ctx, replyMock };
}

function createPhotoDeps(overrides: Partial<PhotoHandlerDeps> = {}): {
  deps: PhotoHandlerDeps;
  processPromptMock: ReturnType<typeof vi.fn>;
  downloadMock: ReturnType<typeof vi.fn>;
  getCapabilitiesMock: ReturnType<typeof vi.fn>;
  savePhotoFileMock: ReturnType<typeof vi.fn>;
} {
  const processPromptMock = vi.fn().mockResolvedValue(true);
  const downloadMock = vi.fn().mockImplementation((_api, fileId: string) =>
    Promise.resolve({
      buffer: Buffer.from(`image:${fileId}`),
      filePath: `photos/${fileId}.jpg`,
    }),
  );
  const getCapabilitiesMock = vi.fn().mockResolvedValue({
    input: { image: true, pdf: true, audio: false, video: false },
  });
  const savePhotoFileMock = vi.fn().mockImplementation(
    (_buffer: Buffer, filename: string, requestId: string) =>
      Promise.resolve(`_output/telegram-image-requests/${requestId}/input/${filename}`),
  );

  const deps: PhotoHandlerDeps = {
    bot: {} as PhotoHandlerDeps["bot"],
    ensureEventSubscription: vi.fn().mockResolvedValue(undefined),
    downloadFile: downloadMock,
    getModelCapabilities: getCapabilitiesMock,
    getStoredModel: vi.fn().mockReturnValue({
      providerID: "test-provider",
      modelID: "test-model",
    }),
    processPrompt: processPromptMock,
    savePhotoFile: savePhotoFileMock,
    ...overrides,
  };

  return { deps, processPromptMock, downloadMock, getCapabilitiesMock, savePhotoFileMock };
}

describe("bot/handlers/photo", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("downloads and sends a single photo as one file part", async () => {
    const { ctx, replyMock } = createPhotoContext();
    const { deps, processPromptMock, downloadMock } = createPhotoDeps();

    await handlePhotoMessage(ctx, deps);

    expect(replyMock).toHaveBeenCalledWith(t("bot.photo_downloading"));
    expect(downloadMock).toHaveBeenCalledWith(ctx.api, "large-photo");
    expect(processPromptMock).toHaveBeenCalledWith(
      ctx,
      expect.stringMatching(
        /Analyze this\n\nTelegram image local copy path\(s\):\n- _output\/telegram-image-requests\/[^/]+\/input\/photo\.jpg/,
      ),
      deps,
      [
        expect.objectContaining({
          type: "file",
          mime: "image/jpeg",
          filename: "photo.jpg",
          url: expect.stringMatching(/^data:image\/jpeg;base64,/),
        }),
      ],
    );
  });

  it("falls back to caption only when the model does not support images", async () => {
    const { ctx, replyMock } = createPhotoContext();
    const { deps, processPromptMock, downloadMock } = createPhotoDeps({
      getModelCapabilities: vi.fn().mockResolvedValue({
        input: { image: false, pdf: true, audio: false, video: false },
      }),
    });

    await handlePhotoMessage(ctx, deps);

    expect(replyMock).toHaveBeenCalledWith(t("bot.photo_model_no_image"));
    expect(downloadMock).not.toHaveBeenCalled();
    expect(processPromptMock).toHaveBeenCalledWith(ctx, "Analyze this", deps);
  });

  it("keeps image generation captions on OpenCode path with local copy context", async () => {
    const { ctx, replyMock } = createPhotoContext({
      caption: "Generate an anime style picture",
    });
    const { deps, processPromptMock, downloadMock, getCapabilitiesMock, savePhotoFileMock } =
      createPhotoDeps();

    await handlePhotoMessage(ctx, deps);

    expect(replyMock).toHaveBeenCalledWith(t("bot.photo_downloading"));
    expect(downloadMock).toHaveBeenCalledWith(ctx.api, "large-photo");
    expect(getCapabilitiesMock).toHaveBeenCalled();
    expect(savePhotoFileMock).toHaveBeenCalledWith(
      Buffer.from("image:large-photo"),
      "photo.jpg",
      expect.any(String),
    );
    expect(processPromptMock).toHaveBeenCalledWith(
      ctx,
      expect.stringMatching(
        /Generate an anime style picture\n\nTelegram image local copy path\(s\):\n- _output\/telegram-image-requests\/[^/]+\/input\/photo\.jpg/,
      ),
      deps,
      [
        expect.objectContaining({
          type: "file",
          mime: "image/jpeg",
          filename: "photo.jpg",
        }),
      ],
    );
  });

  it("keeps normal photo prompts on the OpenCode vision path", async () => {
    const { ctx } = createPhotoContext({ caption: "What is in this image?" });
    const { deps, processPromptMock } = createPhotoDeps();

    await handlePhotoMessage(ctx, deps);

    expect(processPromptMock).toHaveBeenCalledTimes(1);
  });
});
