import { describe, expect, it } from "vitest";
import { extractCommands } from "../shell/commands.js";
import { unpacks } from "./unpackers.js";

function unpacksLine(src: string): boolean {
  return extractCommands(src).some(unpacks);
}

describe("unpacks", () => {
  it.each([
    "tar xf a.tar",
    "tar -xPf a.tar",
    "tar -Pxf a.tar",
    "tar --absolute-names -xf a.tar",
    "tar --extract -f a.tar",
    "tar --ext -f a.tar",
    "tar --get --file=a.tar",
    "tar -f a.tar -x",
    'tar -f a.tar "$MODE"',
    'tar "$MODE" a.tar',
    "bsdtar -xPf a.tar",
    "cpio -i < a.cpio",
    "cpio -idmv < a.cpio",
    "cpio --extract < a.cpio",
    'cpio "$MODE" < a.cpio',
    'pax "$MODE" < a.pax',
    "unzip -: a.zip",
    "pax -r < a.pax",
    "pax -rw -f a.pax",
    "7z x a.7z",
    "7za -y e a.7z",
    '7z "$CMD" a.7z',
    "ar x a.a",
    "jar xf a.jar",
    "jar --extract -f a.jar",
  ])("reads %s as an extract", (src) => {
    expect(unpacksLine(src)).toBe(true);
  });

  it.each([
    "tar -czf out.tgz dir",
    'tar -czf "$OUT" dir',
    'tar cf "$OUT" dir',
    'tar -C "$D" -cf a.tar .',
    'tar --file "$OUT" -c dir',
    "tar -fx -c dir",
    "tar -tf a.tar",
    'tar -cf a.tar -- "$F"',
    "cpio -o < list",
    "pax -w -f a.pax dir",
    "7z a out.7z dir",
    "7z l a.7z",
    "ar rcs lib.a a.o",
    "jar cf a.jar dir",
  ])("reads %s as no extract", (src) => {
    expect(unpacksLine(src)).toBe(false);
  });
});
