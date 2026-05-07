import { describe, expect, it, vi } from "vitest";
import { InputFile } from "grammy";
import { sendTtsResponseForSession } from "../../../src/bot/utils/send-tts-response.js";
import {
  clearPromptResponseMode,
  setPromptResponseMode,
} from "../../../src/bot/handlers/prompt.js";
import { t } from "../../../src/i18n/index.js";

vi.mock("../../../src/utils/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe("bot/utils/send-tts-response", () => {
  it("sends audio when the session response mode requires TTS", async () => {
    const sendAudioMock = vi.fn().mockResolvedValue(undefined);
    const sendVoiceMock = vi.fn().mockResolvedValue(undefined);
    const sendMessageMock = vi.fn().mockResolvedValue(undefined);
    const synthesizeSpeechMock = vi.fn().mockResolvedValue({
      buffer: Buffer.from("mp3"),
      filename: "assistant-reply.mp3",
      mimeType: "audio/mpeg",
    });

    const result = await sendTtsResponseForSession({
      api: { sendAudio: sendAudioMock, sendVoice: sendVoiceMock, sendMessage: sendMessageMock },
      sessionId: "session-1",
      chatId: 123,
      text: "Hello from audio",
      getResponseMode: () => "text_and_tts",
      isTtsConfigured: () => true,
      synthesizeSpeech: synthesizeSpeechMock,
    });

    expect(result).toBe(true);
    expect(synthesizeSpeechMock).toHaveBeenCalledWith("Hello from audio");
    expect(sendAudioMock).toHaveBeenCalledTimes(1);
    expect(sendVoiceMock).not.toHaveBeenCalled();
    const [chatId, inputFile] = sendAudioMock.mock.calls[0];
    expect(chatId).toBe(123);
    expect(inputFile).toBeInstanceOf(InputFile);
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("keeps TTS enabled for multiple assistant messages in one session", async () => {
    const sendAudioMock = vi.fn().mockResolvedValue(undefined);
    const sendVoiceMock = vi.fn().mockResolvedValue(undefined);
    const sendMessageMock = vi.fn().mockResolvedValue(undefined);
    const synthesizeSpeechMock = vi.fn().mockResolvedValue({
      buffer: Buffer.from("mp3"),
      filename: "assistant-reply.mp3",
      mimeType: "audio/mpeg",
    });
    const sessionId = "session-multi-message";

    setPromptResponseMode(sessionId, "text_and_tts");
    try {
      await sendTtsResponseForSession({
        api: { sendAudio: sendAudioMock, sendVoice: sendVoiceMock, sendMessage: sendMessageMock },
        sessionId,
        chatId: 123,
        text: "First assistant message",
        isTtsConfigured: () => true,
        synthesizeSpeech: synthesizeSpeechMock,
      });

      await sendTtsResponseForSession({
        api: { sendAudio: sendAudioMock, sendVoice: sendVoiceMock, sendMessage: sendMessageMock },
        sessionId,
        chatId: 123,
        text: "Second assistant message",
        isTtsConfigured: () => true,
        synthesizeSpeech: synthesizeSpeechMock,
      });
    } finally {
      clearPromptResponseMode(sessionId);
    }

    expect(synthesizeSpeechMock).toHaveBeenCalledTimes(2);
    expect(synthesizeSpeechMock).toHaveBeenNthCalledWith(1, "First assistant message");
    expect(synthesizeSpeechMock).toHaveBeenNthCalledWith(2, "Second assistant message");
    expect(sendAudioMock).toHaveBeenCalledTimes(2);
    expect(sendVoiceMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("sends OGG audio as a voice message", async () => {
    const sendAudioMock = vi.fn().mockResolvedValue(undefined);
    const sendVoiceMock = vi.fn().mockResolvedValue(undefined);
    const sendMessageMock = vi.fn().mockResolvedValue(undefined);
    const synthesizeSpeechMock = vi.fn().mockResolvedValue({
      buffer: Buffer.from("ogg"),
      filename: "assistant-reply.ogg",
      mimeType: "audio/ogg",
    });

    const result = await sendTtsResponseForSession({
      api: { sendAudio: sendAudioMock, sendVoice: sendVoiceMock, sendMessage: sendMessageMock },
      sessionId: "session-1",
      chatId: 123,
      text: "Hello from voice",
      getResponseMode: () => "text_and_tts",
      isTtsConfigured: () => true,
      synthesizeSpeech: synthesizeSpeechMock,
    });

    expect(result).toBe(true);
    expect(sendAudioMock).not.toHaveBeenCalled();
    expect(sendVoiceMock).toHaveBeenCalledTimes(1);
    const [chatId, inputFile] = sendVoiceMock.mock.calls[0];
    expect(chatId).toBe(123);
    expect(inputFile).toBeInstanceOf(InputFile);
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("skips audio when the session response mode is text only", async () => {
    const sendAudioMock = vi.fn().mockResolvedValue(undefined);
    const sendVoiceMock = vi.fn().mockResolvedValue(undefined);
    const sendMessageMock = vi.fn().mockResolvedValue(undefined);
    const synthesizeSpeechMock = vi.fn();

    const result = await sendTtsResponseForSession({
      api: { sendAudio: sendAudioMock, sendVoice: sendVoiceMock, sendMessage: sendMessageMock },
      sessionId: "session-1",
      chatId: 123,
      text: "Hello from text",
      getResponseMode: () => "text_only",
      isTtsConfigured: () => true,
      synthesizeSpeech: synthesizeSpeechMock,
    });

    expect(result).toBe(false);
    expect(synthesizeSpeechMock).not.toHaveBeenCalled();
    expect(sendAudioMock).not.toHaveBeenCalled();
    expect(sendVoiceMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("skips audio when TTS is not configured", async () => {
    const sendAudioMock = vi.fn().mockResolvedValue(undefined);
    const sendVoiceMock = vi.fn().mockResolvedValue(undefined);
    const sendMessageMock = vi.fn().mockResolvedValue(undefined);
    const synthesizeSpeechMock = vi.fn();

    const result = await sendTtsResponseForSession({
      api: { sendAudio: sendAudioMock, sendVoice: sendVoiceMock, sendMessage: sendMessageMock },
      sessionId: "session-1",
      chatId: 123,
      text: "Hello from audio",
      getResponseMode: () => "text_and_tts",
      isTtsConfigured: () => false,
      synthesizeSpeech: synthesizeSpeechMock,
    });

    expect(result).toBe(false);
    expect(synthesizeSpeechMock).not.toHaveBeenCalled();
    expect(sendAudioMock).not.toHaveBeenCalled();
    expect(sendVoiceMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("sends a user-facing error when audio generation fails", async () => {
    const sendAudioMock = vi.fn().mockResolvedValue(undefined);
    const sendVoiceMock = vi.fn().mockRejectedValue(new Error("tts failed"));
    const sendMessageMock = vi.fn().mockResolvedValue(undefined);
    const synthesizeSpeechMock = vi.fn().mockResolvedValue({
      buffer: Buffer.from("ogg"),
      filename: "assistant-reply.ogg",
      mimeType: "audio/ogg",
    });

    const result = await sendTtsResponseForSession({
      api: { sendAudio: sendAudioMock, sendVoice: sendVoiceMock, sendMessage: sendMessageMock },
      sessionId: "session-1",
      chatId: 123,
      text: "Hello from audio",
      getResponseMode: () => "text_and_tts",
      isTtsConfigured: () => true,
      synthesizeSpeech: synthesizeSpeechMock,
    });

    expect(result).toBe(false);
    expect(sendMessageMock).toHaveBeenCalledWith(123, t("tts.failed"));
  });
});
