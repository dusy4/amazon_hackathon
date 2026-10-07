/**
 * Spoken replies and audio description with Amazon Polly (generative engine).
 * The TV fetches /api/tts?text=… and plays the MP3; the browser voice is only a fallback when Polly fails.
 */
import { PollyClient, SynthesizeSpeechCommand, type VoiceId } from "@aws-sdk/client-polly";

const client = new PollyClient({ region: process.env.AWS_REGION ?? "us-east-1" });
const cache = new Map<string, Uint8Array>();
export const POLLY_VOICE = (process.env.POLLY_VOICE ?? "Ruth") as VoiceId;

export async function synthesize(text: string): Promise<Uint8Array> {
  const key = `${POLLY_VOICE}:${text}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const res = await client.send(
    new SynthesizeSpeechCommand({ Engine: "generative", VoiceId: POLLY_VOICE, OutputFormat: "mp3", Text: text.slice(0, 2900) }),
  );
  const audio = await res.AudioStream!.transformToByteArray();
  if (cache.size > 200) cache.delete(cache.keys().next().value!);
  cache.set(key, audio);
  return audio;
}
