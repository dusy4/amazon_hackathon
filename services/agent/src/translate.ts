/**
 * Translate on-screen text or dialogue for the viewer.
 *
 * Amazon Translate first. This account currently gets SubscriptionRequiredException (the same verification
 * wall as Bedrock/Transcribe, logged in the Dev + Friction Log), so the LLM agent's model translates
 * meanwhile and the result says which one ran.
 */
import { TranslateClient, TranslateTextCommand } from "@aws-sdk/client-translate";
import { defaultChatModel } from "./llm.ts";

const LANGS: Record<string, string> = {
  spanish: "es", french: "fr", german: "de", italian: "it", portuguese: "pt", ukrainian: "uk", russian: "ru", polish: "pl",
  dutch: "nl", japanese: "ja", chinese: "zh", korean: "ko", arabic: "ar", hindi: "hi", turkish: "tr", english: "en",
};
export const languageCode = (name: string) => LANGS[name.toLowerCase()] ?? (name.length <= 3 ? name.toLowerCase() : "es");
export const languageName = (code: string) => Object.keys(LANGS).find((k) => LANGS[k] === code)?.replace(/^./, (c) => c.toUpperCase()) ?? code;

let translateBlocked: string | null = null;

export async function translate(text: string, target: string): Promise<{ text: string; engine: string; note?: string }> {
  const code = languageCode(target);
  if (!translateBlocked) {
    try {
      const r = await new TranslateClient({ region: process.env.AWS_REGION ?? "us-east-1" }).send(
        new TranslateTextCommand({ Text: text, SourceLanguageCode: "auto", TargetLanguageCode: code }),
      );
      return { text: r.TranslatedText ?? "", engine: "amazon-translate" };
    } catch (e) {
      translateBlocked = `${(e as Error).name}: ${(e as Error).message}`.slice(0, 160);
    }
  }
  const model = defaultChatModel();
  if (!model) throw new Error("translation needs Amazon Translate (AWS credentials) or an LLM (SP_LLM in .env); neither is available");
  const r = await model.complete(
    `Translate the user's text into ${languageName(code)}. Reply with the translation only, no quotes, no notes.`,
    [{ role: "user", content: text }],
    [],
  );
  return { text: r.text.trim(), engine: model.label, note: `Amazon Translate unavailable (${translateBlocked})` };
}
