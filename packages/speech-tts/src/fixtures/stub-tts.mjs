#!/usr/bin/env node
// A stand-in engine for the commandTts stdio contract. Flags:
//   --mode stdout-wav | json-path | json-base64 | hang | fail | unavailable | garbage
//   --rate <Hz>        sample rate written in the WAV header (default 24000)
//   --pid-file <path>  write this process's pid there before reading stdin
//   --echo <path>      write the request JSON there
import { writeFileSync } from "node:fs";

const flags = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => (arg.startsWith("--") ? [...pairs, [arg.slice(2), all[i + 1]]] : pairs), []),
);
const mode = flags.mode ?? "stdout-wav";
const rate = Number(flags.rate ?? 24000);

function wav(seconds) {
  const n = Math.round(seconds * rate);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(3000 * Math.sin((2 * Math.PI * 220 * i) / rate)), 44 + i * 2);
  return buf;
}

function speak(request) {
  const words = request.text ? request.text.split(/\s+/).filter(Boolean) : request.tokens.map((t) => t.text);
  const slot = 0.4 / (request.speed ?? 1);
  const timings = words.map((word, i) => ({ word, start: i * slot, end: i * slot + slot * 0.75 }));
  return { audio: wav(words.length * slot), timings, durationS: words.length * slot };
}

function answer(request) {
  if (mode === "fail") {
    process.stderr.write("stub engine: voice model failed to load\n");
    process.exit(1);
  }
  if (mode === "unavailable") process.exit(69);
  if (mode === "garbage") return void process.stdout.write("not audio");
  const { audio, timings, durationS } = speak(request);
  if (mode === "stdout-wav") return void process.stdout.write(audio);
  const phonemes = request.tokens?.map((t) => t.phonemes ?? t.text);
  const extras = { durationS, words: timings, ...(phonemes ? { phonemes } : {}) };
  if (mode === "json-base64") return void process.stdout.write(JSON.stringify({ audioBase64: audio.toString("base64"), ...extras }));
  writeFileSync(request.out, audio);
  process.stdout.write(JSON.stringify({ wav: request.out, ...extras }));
}

if (flags["pid-file"]) writeFileSync(flags["pid-file"], String(process.pid));
if (mode === "hang") setInterval(() => undefined, 1_000);
else {
  let input = "";
  process.stdin.on("data", (chunk) => (input += chunk));
  process.stdin.on("end", () => {
    if (flags.echo) writeFileSync(flags.echo, input);
    answer(JSON.parse(input));
  });
}
