import type { Observation } from "./types.js";

interface PrettierConfig {
  semi?: boolean;
  singleQuote?: boolean;
  trailingComma?: "none" | "es5" | "all";
  tabWidth?: number;
  useTabs?: boolean;
}

interface EditorConfigSection {
  indent_style?: "space" | "tab";
  indent_size?: string;
  insert_final_newline?: string;
}

export function parsePrettierConfig(
  raw: string,
  configPath: string,
): Observation[] {
  const config: PrettierConfig = JSON.parse(raw);
  return [
    ...prettierSyntaxObservations(config, configPath),
    ...prettierIndentObservations(config, configPath),
  ];
}

function prettierSyntaxObservations(
  config: PrettierConfig,
  configPath: string,
): Observation[] {
  const observations: Observation[] = [];

  if (config.semi !== undefined) {
    observations.push(makeFormattingObs(
      "formatting.semicolons", config.semi, configPath, 1, "config",
    ));
  }

  if (config.singleQuote !== undefined) {
    observations.push(makeFormattingObs(
      "formatting.quoteStyle",
      config.singleQuote ? "single" : "double",
      configPath, 1, "config",
    ));
  }

  if (config.trailingComma !== undefined) {
    observations.push(makeFormattingObs(
      "formatting.trailingCommas",
      config.trailingComma !== "none",
      configPath, 1, "config",
    ));
  }

  return observations;
}

function prettierIndentObservations(
  config: PrettierConfig,
  configPath: string,
): Observation[] {
  const observations: Observation[] = [];

  if (config.tabWidth !== undefined) {
    observations.push(makeFormattingObs(
      "formatting.indentSize", config.tabWidth, configPath, 1, "config",
    ));
  }

  if (config.useTabs !== undefined) {
    observations.push(makeFormattingObs(
      "formatting.indentStyle",
      config.useTabs ? "tab" : "space",
      configPath, 1, "config",
    ));
  }

  return observations;
}

export function parseEditorConfig(
  raw: string,
  configPath: string,
): Observation[] {
  const observations: Observation[] = [];
  const section = parseEditorConfigGlobal(raw);

  if (section.indent_style) {
    observations.push(makeFormattingObs(
      "formatting.indentStyle", section.indent_style, configPath, 1, "config",
    ));
  }

  if (section.indent_size) {
    observations.push(makeFormattingObs(
      "formatting.indentSize",
      parseInt(section.indent_size, 10),
      configPath, 1, "config",
    ));
  }

  if (section.insert_final_newline) {
    observations.push(makeFormattingObs(
      "formatting.trailingNewline",
      section.insert_final_newline === "true",
      configPath, 1, "config",
    ));
  }

  return observations;
}

function parseEditorConfigGlobal(raw: string): EditorConfigSection {
  const result: EditorConfigSection = {};
  const lines = raw.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#") || trimmed.startsWith("[") || !trimmed) {
      continue;
    }
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.substring(0, eqIndex).trim();
    const value = trimmed.substring(eqIndex + 1).trim();
    if (key && value) {
      (result as Record<string, string>)[key] = value;
    }
  }

  return result;
}

export function makeFormattingObs(
  type: string,
  value: string | number | boolean,
  file: string,
  line: number,
  source: string,
): Observation {
  return {
    type,
    category: "formatting",
    value,
    file,
    line,
    metadata: { source },
  };
}
