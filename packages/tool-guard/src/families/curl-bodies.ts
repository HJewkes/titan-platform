import type { Option, Options } from "./options.js";

/** The literal body texts curl sends, or null when any comes from a file, a config file or run-time text. */
export function curlBodies(o: Options, bodyFlags: readonly string[]): string[] | null {
  if (o.opts.some((opt) => opt.flag === "-K" || opt.flag === "--config")) return null;
  const texts: string[] = [];
  for (const opt of o.opts.filter((x) => bodyFlags.includes(x.flag))) {
    const text = curlBodyText(opt);
    if (text === null) return null;
    texts.push(text);
  }
  return texts;
}

function curlBodyText({ flag, value }: Option): string | null {
  if (!value || value.dynamic || flag === "-T" || flag === "--upload-file") return null;
  return curlReadsFile(flag, value.value) ? null : value.value;
}

/** `@file` loads a file except under `--data-raw`; `--data-urlencode` reads `name@file`; a form field reads `=@file` and `=<file`. */
function curlReadsFile(flag: string, text: string): boolean {
  if (flag === "--data-raw" || flag === "--form-string") return false;
  if (flag === "-F" || flag === "--form") return /=[@<]/.test(text);
  if (flag !== "--data-urlencode") return text.startsWith("@");
  const at = text.indexOf("@");
  const eq = text.indexOf("=");
  return at >= 0 && (eq < 0 || at < eq);
}
