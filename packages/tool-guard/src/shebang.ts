/** What running a file by path hands the kernel: no `#!` line, a shell the guard knows to read the body as, or a line it cannot follow. */
type Shebang = { kind: "none" } | { kind: "shell"; shell: string; flags: string } | { kind: "opaque" };

const SHELL_LINE_RE = /^#!(?:\/usr)?\/bin\/(bash|sh|zsh)(?: -([euxvf]+))?$/;
const ENV_LINE_RE = /^#!\/usr\/bin\/env (bash|sh|zsh)$/;
/** Only blanks and invisible marks before `#!`: a BOM or NBSP there is no shebang to the kernel, but a tool that strips it would see one. */
const PADDED_RE = /^[\p{Z}\p{C}\s]*#!/u;

/**
 * Reads a script's first line the way the kernel hands it on. The kernel passes everything after the interpreter to it
 * as options and operands, and the interpreter's own parser then reads them again, so only the short positive list
 * below is followed: `#!/bin/bash`, `#!/usr/bin/env bash` and one `-[euxvf]+` word on the first form. Anything else is
 * opaque, since the body may not be what runs.
 */
export function parseShebang(text: string): Shebang {
  const line = text.slice(0, text.indexOf("\n") === -1 ? undefined : text.indexOf("\n"));
  if (!line.startsWith("#!")) return PADDED_RE.test(line) ? { kind: "opaque" } : { kind: "none" };
  const [, shell = "", flags = ""] = SHELL_LINE_RE.exec(line) ?? [];
  if (shell !== "") return { kind: "shell", shell, flags };
  const [, envShell = ""] = ENV_LINE_RE.exec(line) ?? [];
  return envShell === "" ? { kind: "opaque" } : { kind: "shell", shell: envShell, flags: "" };
}

const HEADER_BYTES = 4096;
/** bash's own test for a binary: a NUL in the first line, looked for in at most 80 bytes. */
const BINARY_LINE_BYTES = 80;
const PT_LOAD = 1;
const ET_EXEC = 2;
const ET_DYN = 3;
/** The Linux loader (`load_elf_phdrs`) refuses a program-header table over 64 KiB with ENOEXEC. */
const MAX_PHDR_TABLE = 64 * 1024;
const ELF_MACHINES: Readonly<Record<string, number>> = { ia32: 3, arm: 0x28, ppc64: 0x15, s390x: 0x16, x64: 0x3e, arm64: 0xb7, riscv64: 0xf3 };
const MACHO_CPUS: Readonly<Record<string, number>> = { x64: 0x01000007, arm64: 0x0100000c };
const MACHO_THIN = new Set([0xfeedfacf, 0xfeedface]);
const FAT_MAGICS = new Set([0xcafebabe, 0xcafebabf]);

/** Reads `length` bytes at `position`, or fewer at the end of the file. */
type ReadAt = (position: number, length: number) => Buffer;

/**
 * Whether the head of a file is one the kernel, or dyld, would commit to run as a native program on this host. A file
 * that merely begins with a magic number is no program: when the kernel refuses it (ENOEXEC) bash runs it as a script
 * unless a NUL shows in its first line, and glibc's `execvp` (behind `env`, `xargs`, `find -exec`) hands it to `/bin/sh`
 * whatever it holds. So both must hold: the NUL, and a header valid down to the structure the loader checks first.
 */
export function isNativeProgram(readAt: ReadAt, size: number, arch: string = process.arch, platform: string = process.platform): boolean {
  const head = readAt(0, HEADER_BYTES);
  const firstLine = head.subarray(0, Math.min(BINARY_LINE_BYTES, head.indexOf(0x0a) === -1 ? head.length : head.indexOf(0x0a)));
  if (head.length < 4 || !firstLine.includes(0)) return false;
  if (head.readUInt32BE(0) === 0x7f454c46) return platform !== "darwin" && validElf(head, readAt, size, arch);
  return platform === "darwin" && validMachO(head, size, arch);
}

function validElf(head: Buffer, readAt: ReadAt, size: number, arch: string): boolean {
  if (head.length < 64 || (head[4] !== 1 && head[4] !== 2) || (head[5] !== 1 && head[5] !== 2) || head[6] !== 1) return false;
  const wide = head[4] === 2;
  const le = head[5] === 1;
  const u16 = (at: number): number => (le ? head.readUInt16LE(at) : head.readUInt16BE(at));
  const type = u16(16);
  const phentsize = u16(wide ? 54 : 42);
  const phnum = u16(wide ? 56 : 44);
  if ((type !== ET_EXEC && type !== ET_DYN) || u16(18) !== ELF_MACHINES[arch] || phentsize !== (wide ? 56 : 32) || phnum === 0) return false;
  const phoff = wide ? Number(le ? head.readBigUInt64LE(32) : head.readBigUInt64BE(32)) : le ? head.readUInt32LE(28) : head.readUInt32BE(28);
  const table = phnum * phentsize;
  if (table > MAX_PHDR_TABLE || !Number.isSafeInteger(phoff) || phoff + table > size) return false;
  const phdrs = readAt(phoff, table);
  for (let at = 0; at + phentsize <= phdrs.length; at += phentsize) if ((le ? phdrs.readUInt32LE(at) : phdrs.readUInt32BE(at)) === PT_LOAD) return true;
  return false;
}

function validMachO(head: Buffer, size: number, arch: string): boolean {
  const cpu = MACHO_CPUS[arch];
  if (head.length < 32 || cpu === undefined) return false;
  const magicLE = head.readUInt32LE(0);
  if (MACHO_THIN.has(magicLE)) return head.readUInt32LE(4) === cpu && machoCommandsFit(head, magicLE === 0xfeedfacf ? 32 : 28, size);
  return FAT_MAGICS.has(head.readUInt32BE(0)) && fatSliceFits(head, size, cpu);
}

function machoCommandsFit(head: Buffer, headerSize: number, size: number): boolean {
  const ncmds = head.readUInt32LE(16);
  return ncmds > 0 && headerSize + head.readUInt32LE(20) <= size;
}

function fatSliceFits(head: Buffer, size: number, cpu: number): boolean {
  const wide = head.readUInt32BE(0) === 0xcafebabf;
  const entry = wide ? 32 : 20;
  const count = head.readUInt32BE(4);
  if (count === 0 || count > 30) return false;
  for (let i = 0; i < count && 8 + (i + 1) * entry <= head.length; i++) {
    const at = 8 + i * entry;
    const offset = wide ? Number(head.readBigUInt64BE(at + 8)) : head.readUInt32BE(at + 8);
    const length = wide ? Number(head.readBigUInt64BE(at + 16)) : head.readUInt32BE(at + 12);
    if (head.readUInt32BE(at) === cpu && length > 0 && offset + length <= size) return true;
  }
  return false;
}
