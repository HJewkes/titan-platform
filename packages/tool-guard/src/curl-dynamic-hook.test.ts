import { describe, expect, it } from "vitest";
import { nodeContext } from "./context.js";
import type { ReadFs } from "./context.js";
import { decide } from "./decide.js";
import { handle } from "./hook.js";
import type { HookPort } from "./hook.js";

const HOME = "/home/you";
const REPO = "/home/you/projects/app";

const noFiles: ReadFs = {
  realpath: () => {
    throw new Error("ENOENT");
  },
  readHead: () => {
    throw new Error("ENOENT");
  },
  isFile: () => false,
};

const port: HookPort = { context: nodeContext(HOME, noFiles), now: () => new Date("2026-01-02T03:04:05.000Z"), loadDecide: async () => decide };

async function logColumns(command: string, cwd = REPO): Promise<{ stdout: string; columns: string[] | undefined }> {
  const input = JSON.stringify({ tool_name: "Bash", session_id: "sess-1", tool_use_id: "tu-1", cwd, tool_input: { command } });
  const result = await handle(input, {}, port);
  return { stdout: result.stdout, columns: result.log[0]?.split("\t").slice(1, 6) };
}

describe("handle: an HTTP write to a run-time URL", () => {
  it.each([
    'curl -X PUT "$URL"',
    "curl -XPUT $U",
    'curl --request PUT "$U"',
    'wget --method=PUT "$U"',
    'http PUT "$U"',
    'curl -X "$M" "$U"',
    'curl -X PUT "https://api.github.com/repos/$R/pulls/1/merge"',
    'http "$M" "$U"',
    'http put "$U"',
    'curl -X PUT "$U" --next -X GET https://example.com/x',
    'curl -X PUT "$U" -: -X GET https://example.com/x',
    'echo "$U" | xargs curl -X PUT',
    "wget --method=PUT -i urls",
    'curl --variable %P --expand-url "https://api.github.com/{{P}}" -X PUT',
    'curl -X PUT "https://api.github.com/repos/o/r/pulls/1/merg{e}"',
    'curl -g --no-globoff -X PUT "https://api.github.com/repos/o/r/pulls/1/merg{e}"',
    'curl -X PUT --expand-url "https://api.github.com/repos/o/r/pulls/1/merg{e}"',
    'curl --variable %M --expand-request "{{M}}" https://api.github.com/repos/o/r/pulls/1/merge',
    'curl --variable %M --expand-request "{{M}}" "$U"',
    "curl --expand-upload-file f https://api.github.com/repos/o/r/pulls/1/merge",
    "curl --request-target /repos/o/r/pulls/1/merge -X PUT https://api.github.com/x",
    "curl -K cfg -X PUT https://api.github.com/x",
    "curl --some-future-option -X PUT https://api.github.com/x",
    'curl -X PUT "$U" -s: -X GET https://example.com/x',
    'curl -X PUT "$U" -:s -X GET https://example.com/x',
    'curl -X PUT "$U" $N -X GET https://example.com/x',
    'curl -X PUT "$U" "$N" -X GET https://example.com/x',
    'curl "$OPT" PUT https://api.github.com/repos/o/r/pulls/1/merge',
    'curl "$D" --next https://api.github.com/repos/o/r/pulls/1/merge',
    'set -- -X PUT https://api.github.com/repos/o/r/pulls/1/merge; curl "$@"',
    'A=(-X PUT https://api.github.com/repos/o/r/pulls/1/merge); curl "${A[@]}"',
    'wget $A "$U"',
    'wget "$O" PUT "$U"',
    "wget $A https://api.github.com/repos/o/r/pulls/1/merge",
    "wget -e method=PUT https://api.github.com/repos/o/r/pulls/1/merge",
    "wget -emethod=PUT https://api.github.com/repos/o/r/pulls/1/merge",
    "wget -qe method=PUT https://api.github.com/repos/o/r/pulls/1/merge",
    "wget --execute=method=PUT https://api.github.com/repos/o/r/pulls/1/merge",
    "wget --execute method=PUT https://api.github.com/repos/o/r/pulls/1/merge",
    "wget -e 'method = put' https://api.github.com/repos/o/r/pulls/1/merge",
    "wget --meth=PUT https://api.github.com/repos/o/r/pulls/1/merge",
    "wget --metho PUT https://api.github.com/repos/o/r/pulls/1/merge",
    "wget --post-d=x https://api.github.com/repos/o/r/pulls/1/merge",
    "wget --body-d x --method=PUT https://api.github.com/repos/o/r/pulls/1/merge",
    "wget -e post_data=x https://api.github.com/repos/o/r/pulls/1/merge",
    "wget --config=rc https://api.github.com/repos/o/r/pulls/1/merge",
    "WGETRC=rc wget https://api.github.com/repos/o/r/pulls/1/merge",
    "wget -e input=urls https://api.github.com/repos/o/r/pulls/1/merge",
    "wget --some-future-option https://api.github.com/repos/o/r/pulls/1/merge",
    'wget -e "$E" https://api.github.com/repos/o/r/pulls/1/merge',
    "export WGETRC=rc; wget https://api.github.com/repos/o/r/pulls/1/merge",
    'WGETRC="$R" wget https://api.github.com/repos/o/r/pulls/1/merge',
    'env "WGETRC=$R" wget https://api.github.com/repos/o/r/pulls/1/merge',
    "declare -x WGETRC=rc; wget https://api.github.com/repos/o/r/pulls/1/merge",
    "typeset -x WGETRC=rc; wget https://api.github.com/repos/o/r/pulls/1/merge",
    "HOME=/tmp/h wget https://api.github.com/repos/o/r/pulls/1/merge",
    "SYSTEM_WGETRC=rc wget https://api.github.com/repos/o/r/pulls/1/merge",
    "echo method=PUT > ~/.wgetrc; wget https://api.github.com/repos/o/r/pulls/1/merge",
    "echo method=PUT | tee ~/.wgetrc; wget https://api.github.com/repos/o/r/pulls/1/merge",
    "cp rc ~/.wgetrc && wget https://api.github.com/repos/o/r/pulls/1/merge",
    "bash -c 'WGETRC=rc wget https://api.github.com/repos/o/r/pulls/1/merge'",
    "CURL_HOME=/tmp/c curl https://api.github.com/repos/o/r/pulls/1/merge",
    "export CURL_HOME=/tmp/c; curl https://api.github.com/repos/o/r/pulls/1/merge",
    "XDG_CONFIG_HOME=/tmp/x curl https://api.github.com/repos/o/r/pulls/1/merge",
    "HOME=/tmp/h curl https://api.github.com/repos/o/r/pulls/1/merge",
    "echo request=PUT > ~/.curlrc; curl https://api.github.com/repos/o/r/pulls/1/merge",
    'env "WGET""RC=rc" wget https://api.github.com/repos/o/r/pulls/1/merge',
    "echo method=PUT > ~/.wget$X; wget https://api.github.com/repos/o/r/pulls/1/merge",
    'echo method=PUT > "$HOME/.$N"; wget https://api.github.com/repos/o/r/pulls/1/merge',
    'echo method=PUT >> ~/."$N"; wget https://api.github.com/repos/o/r/pulls/1/merge',
    "echo method=PUT | tee ~/.wget$X; wget https://api.github.com/repos/o/r/pulls/1/merge",
    "cp rc ~/.wget${X}; wget https://api.github.com/repos/o/r/pulls/1/merge",
    'ln -s rc "$HOME/.$N"; wget https://api.github.com/repos/o/r/pulls/1/merge',
    'mv rc "$D"; wget https://api.github.com/repos/o/r/pulls/1/merge',
    'cp "$S" ~; wget https://api.github.com/repos/o/r/pulls/1/merge',
    "echo method=PUT > ~/.wget*; wget https://api.github.com/repos/o/r/pulls/1/merge",
    'cd "$D"; echo method=PUT > .wgetrc; HOME=. wget https://api.github.com/repos/o/r/pulls/1/merge',
    "for HOME in d; do wget https://api.github.com/repos/o/r/pulls/1/merge; done",
    "read HOME <<< d; wget https://api.github.com/repos/o/r/pulls/1/merge",
    "printf -v HOME %s d; wget https://api.github.com/repos/o/r/pulls/1/merge",
    "mapfile -t HOME < f; wget https://api.github.com/repos/o/r/pulls/1/merge",
    "declare -n R=HOME; R=d; wget https://api.github.com/repos/o/r/pulls/1/merge",
    "read WGETRC; export WGETRC; wget https://api.github.com/repos/o/r/pulls/1/merge",
    "(( HOME = 1 )); wget https://api.github.com/repos/o/r/pulls/1/merge",
    "HTTPIE_CONFIG_DIR=d http https://api.github.com/repos/o/r/pulls/1/merge",
    "export HTTPIE_CONFIG_DIR=d; http https://api.github.com/repos/o/r/pulls/1/merge",
    "echo x > ~/.config/httpie/config.json; http https://api.github.com/repos/o/r/pulls/1/merge",
    'echo x > "$D/config.json"; http https://api.github.com/repos/o/r/pulls/1/merge',
    'curl -o ~/.wget$X https://example.com/x; wget https://api.github.com/repos/o/r/pulls/1/merge',
    'curl -so "$F" https://example.com/x; wget https://api.github.com/repos/o/r/pulls/1/merge',
    'wget -O "$F" https://example.com/x; wget https://api.github.com/repos/o/r/pulls/1/merge',
    'dd of="$F" < rc; wget https://api.github.com/repos/o/r/pulls/1/merge',
    'rsync rc "$F"; wget https://api.github.com/repos/o/r/pulls/1/merge',
    'sed -i s/a/b/ "$F"; wget https://api.github.com/repos/o/r/pulls/1/merge',
    'unzip a.zip -d ~; wget https://api.github.com/repos/o/r/pulls/1/merge',
    'echo m >! "$F"; wget https://api.github.com/repos/o/r/pulls/1/merge',
    'echo m >>! "$F"; wget https://api.github.com/repos/o/r/pulls/1/merge',
    "mkdir -p ~/.httpie; echo '{\"default_options\":[\"PUT\"]}' > ~/.httpie/config.json; http https://api.github.com/repos/o/r/pulls/1/merge",
    'N=$(echo d2dldHJj | base64 -d); curl -so "$HOME/.$N" https://example.com/rc; wget https://api.github.com/repos/o/r/pulls/1/merge',
    'curl --output="$F" https://example.com/x; wget https://api.github.com/repos/o/r/pulls/1/merge',
    'wget --output-doc="$F" https://example.com/x; wget https://api.github.com/repos/o/r/pulls/1/merge',
    'printf "method=PUT" > x; set -a; : ${WGETRC:=x}; wget https://api.github.com/repos/o/r/pulls/1/merge',
    'printf "method=PUT" > x; set -a; : ${WGETRC=x}; wget https://api.github.com/repos/o/r/pulls/1/merge',
    'printf "method=PUT" > x; set -a; : ${WGETRC::=x}; wget https://api.github.com/repos/o/r/pulls/1/merge',
    'mkdir c; set -a; : ${CURL_HOME:="$PWD/c"}; curl -s https://api.github.com/repos/o/r/pulls/1/merge',
    'set -a; : ${XDG_CONFIG_HOME:=/tmp/c}; curl -s https://api.github.com/repos/o/r/pulls/1/merge',
    'set -a; : ${HTTPIE_CONFIG_DIR:=/tmp/h}; http https://api.github.com/repos/o/r/pulls/1/merge',
    'X=${WGETRC:-${WGETRC:=x}}; wget https://api.github.com/repos/o/r/pulls/1/merge',
    'curl -so a.tar https://example.com/a; cd ~; tar xf projects/app/a.tar; wget https://api.github.com/repos/o/r/pulls/1/merge',
    'cd ~ && unzip projects/app/a.zip; wget https://api.github.com/repos/o/r/pulls/1/merge',
    'cd ~; cpio -i < projects/app/a.cpio; wget https://api.github.com/repos/o/r/pulls/1/merge',
    'cd ~/.config && bsdtar xf ~/projects/app/a.tar; curl -s https://api.github.com/repos/o/r/pulls/1/merge',
    'pushd ~/.httpie; tar xf ~/projects/app/a.tar; http https://api.github.com/repos/o/r/pulls/1/merge',
    'cd /etc; tar xf ~/projects/app/a.tar; wget https://api.github.com/repos/o/r/pulls/1/merge',
    'cd "$D"; tar xf ~/projects/app/a.tar; wget https://api.github.com/repos/o/r/pulls/1/merge',
    '(cd "$D" && bsdtar xf a.tar); wget https://api.github.com/repos/o/r/pulls/1/merge',
    'tar -xPf a.tar; wget https://api.github.com/repos/o/r/pulls/1/merge',
    'tar --absolute-names -xf a.tar; wget https://api.github.com/repos/o/r/pulls/1/merge',
    'bsdtar -xPf a.tar; wget https://api.github.com/repos/o/r/pulls/1/merge',
    'cpio -i < a.cpio; wget https://api.github.com/repos/o/r/pulls/1/merge',
    'unzip -: a.zip; wget https://api.github.com/repos/o/r/pulls/1/merge',
    'pax -r < a.pax; wget https://api.github.com/repos/o/r/pulls/1/merge',
    'tar xf a.tar; wget https://api.github.com/repos/o/r/pulls/1/merge',
    'tar -Pxf a.tar; wget https://api.github.com/repos/o/r/pulls/1/merge',
    'tar --extract -f a.tar; wget https://api.github.com/repos/o/r/pulls/1/merge',
    'tar --get --file=a.tar; wget https://api.github.com/repos/o/r/pulls/1/merge',
    'tar -f a.tar --ext; wget https://api.github.com/repos/o/r/pulls/1/merge',
    'tar -f a.tar "$MODE"; wget https://api.github.com/repos/o/r/pulls/1/merge',
    'gtar -C /tmp -xf a.tar; wget https://api.github.com/repos/o/r/pulls/1/merge',
    'cpio -idmv < a.cpio; wget https://api.github.com/repos/o/r/pulls/1/merge',
    'cpio --extract < a.cpio; wget https://api.github.com/repos/o/r/pulls/1/merge',
    'pax -rw -f a.pax; wget https://api.github.com/repos/o/r/pulls/1/merge',
    '7z x a.7z; wget https://api.github.com/repos/o/r/pulls/1/merge',
    '7za -y e a.7z; wget https://api.github.com/repos/o/r/pulls/1/merge',
    'ar x a.a; wget https://api.github.com/repos/o/r/pulls/1/merge',
    'jar xf a.jar; wget https://api.github.com/repos/o/r/pulls/1/merge',
  ])("denies %s as a merge", async (command) => {
    const { columns } = await logColumns(command);

    expect(columns).toEqual(["deny", "MRG-WK", "merge", "bash.merge.curl-api", "coordinator+worker+headless"]);
  });

  // A run-time name a declarer or read stores into may be any name, so the line is refused as a possible rebinding (TP-3320).
  it.each([
    'export "$V=d"; wget https://api.github.com/repos/o/r/pulls/1/merge',
    'declare "$V"=d; wget https://api.github.com/repos/o/r/pulls/1/merge',
    'read -- "$V" <<< d; wget https://api.github.com/repos/o/r/pulls/1/merge',
  ])("denies %s before reading the merge", async (command) => {
    const { columns } = await logColumns(command);

    expect(columns?.[0]).toBe("deny");
  });

  it.each([
    'set -a; V=WGETRC; : ${!V:=x}; wget https://api.github.com/repos/o/r/pulls/1/merge',
    'set -a; V=WGETRC; : ${!V=x}; wget https://api.github.com/repos/o/r/pulls/1/merge',
    'V=WGETRC; : ${(P)V::=x}; wget https://api.github.com/repos/o/r/pulls/1/merge',
    'V=WGETRC; : ${(P)V:=x}; wget https://api.github.com/repos/o/r/pulls/1/merge',
    ': ${(P)${V}:=x}; wget https://api.github.com/repos/o/r/pulls/1/merge',
    'set -a; : ${HOME:=/tmp/h}; wget https://api.github.com/repos/o/r/pulls/1/merge',
  ])("denies %s at the lexer, which refuses the assigning expansion before the write is classified", async (command) => {
    const { columns } = await logColumns(command);

    expect(columns?.[0]).toBe("deny");
  });

  it("keeps a literal non-GitHub upload under egress", async () => {
    const { columns } = await logColumns("curl -X PUT https://example.com/x");

    expect(columns).toEqual(["deny", "EXT-CO", "private-egress", "bash.egress.curl-upload", "coordinator+worker+headless"]);
  });

  it.each(["curl -X GET \"$U\"", "curl -fsSL --compressed https://api.github.com/repos/o/r/pulls/1", "curl -g --no-get --globoff https://api.github.com/repos/o/r", "curl --no-progress-meter -sS https://example.com/x", 'curl --include "$U"', 'curl --progress-meter -s "$U"', 'curl -s: -I "$U"', 'curl -s "https://api.github.com/repos/$R/pulls" -H "Authorization: Bearer $T"', 'curl -s "http://localhost:8080/$P" -o f', "wget -q -nv --no-config -O out https://api.github.com/repos/o/r/pulls/1", "wget --quiet --no-check-certificate --tries=3 https://example.com/x", "wget -e robots=off -e tries=3 -e timeout=10 -e wait=1 https://example.com/x", "wget -q https://api.github.com/repos/o/r/pulls/1", "wget -O out.html https://example.com/x", "curl -o file https://example.com/x > log.txt", 'curl -s https://example.com/x > "$D/out.html"', 'curl -s https://example.com/x > "out-$(date +%s).html"', "curl -s https://example.com/x | tee out.txt", "cp a.txt b.txt && curl -s https://example.com/x", 'for f in a b; do curl -s "https://example.com/$f"; done', 'read -r U < f; curl -s "$U"', 'grep -q x "$F" && curl -s https://example.com/x', 'echo "$U"; curl -s "$U"', '"$EDITOR" notes.md; curl -s https://example.com/x', 'cd ~/projects/app && curl -s "$U"', 'cd "$D" && wget -O out.html https://example.com/x', 'cd ~ && ls; curl -s "$U"', 'echo ${WGETRC:-none}; curl -s "$U"', 'cd /tmp; tar xf a.tar', 'cd ~; tar xf projects/app/a.tar', 'cd "$D" && make && curl -s https://example.com/x', 'tar -czf out.tgz dir && curl -s https://example.com/x', 'tar -tf a.tar; curl -s https://example.com/x', 'tar cf a.tar -C src .; curl -s https://example.com/x', 'tar --exclude=.git -cf - . | gzip > a.tgz; curl -s https://example.com/x', '7z a out.7z dir; curl -s https://example.com/x', 'cpio -o < list > a.cpio; curl -s https://example.com/x', 'pax -w -f a.pax dir; curl -s https://example.com/x', 'echo ${!V}; curl -s https://example.com/x', 'echo ${!V:-x}; curl -s https://example.com/x'])(
    "lets the read %s through",
    async (command) => {
      const { stdout } = await logColumns(command);

      expect(stdout).toBe("");
    },
  );

  it("keeps a literal non-GitHub write with known options under egress", async () => {
    const { columns } = await logColumns("curl -sS --fail-with-body --no-progress-meter -X PUT https://example.com/x");

    expect(columns).toEqual(["deny", "EXT-CO", "private-egress", "bash.egress.curl-upload", "coordinator+worker+headless"]);
  });

  it("denies an unpack in the session's own home directory before a merge request", async () => {
    const { columns } = await logColumns('tar xf a.tar; wget https://api.github.com/repos/o/r/pulls/1/merge', HOME);

    expect(columns).toEqual(["deny", "MRG-WK", "merge", "bash.merge.curl-api", "coordinator+worker+headless"]);
  });

  it("lets a GET to a run-time URL through", async () => {
    const { stdout } = await logColumns('curl -X GET "$U"');

    expect(stdout).toBe("");
  });
});

describe("handle: on a filesystem that folds case", () => {
  const MERGE = "https://api.github.com/repos/o/r/pulls/1/merge";
  const folding: HookPort = { ...port, context: { ...nodeContext(HOME, noFiles), foldCase: true } };

  async function foldedColumns(command: string): Promise<{ stdout: string; columns: string[] | undefined }> {
    const input = JSON.stringify({ tool_name: "Bash", session_id: "sess-1", tool_use_id: "tu-1", cwd: REPO, tool_input: { command } });
    const result = await handle(input, {}, folding);
    return { stdout: result.stdout, columns: result.log[0]?.split("\t").slice(1, 6) };
  }

  it.each([
    `TAR xf a.tar; wget ${MERGE}`,
    `Tar xf a.tar; wget ${MERGE}`,
    `GTAR -xf a.tar; wget ${MERGE}`,
    `BsdTar xf a.tar; wget ${MERGE}`,
    `UNZIP a.zip; wget ${MERGE}`,
    `UnZip a.zip; wget ${MERGE}`,
    `CPIO -i < a.cpio; wget ${MERGE}`,
    `Cpio -i < a.cpio; wget ${MERGE}`,
    `7Z x a.7z; wget ${MERGE}`,
    `7ZA x a.7z; wget ${MERGE}`,
    `AR x a.ar; wget ${MERGE}`,
    `Ar x a.ar; wget ${MERGE}`,
    `JAR xf a.jar; wget ${MERGE}`,
    `PAX -r < a.pax; wget ${MERGE}`,
    `TAR xf a.tar; curl ${MERGE}`,
    `echo method=PUT > ~/.WGETRC; wget ${MERGE}`,
    `echo method=PUT | tee ~/.WgetRc; wget ${MERGE}`,
    `cp rc /ETC/WGETRC; wget ${MERGE}`,
    `cp rc ~/.CurlRC; curl ${MERGE}`,
    `cp -r d ~/.conﬁg; http ${MERGE}`,
    `cp -r d ~/.Conﬁg; http ${MERGE}`,
    `cp rc "$D/config.jſon"; wget ${MERGE}`,
    `cp rc "$D/CONFIG.JſON"; wget ${MERGE}`,
  ])("denies %s as a merge", async (command) => {
    const { columns } = await foldedColumns(command);

    expect(columns).toEqual(["deny", "MRG-WK", "merge", "bash.merge.curl-api", "coordinator+worker+headless"]);
  });

  it.each([`wget -q ${MERGE.replace("/merge", "")}`, "wget https://example.com/x", `TAR cf a.tar src; wget -q https://example.com/x`])("lets the read %s through", async (command) => {
    const { stdout } = await foldedColumns(command);

    expect(stdout).toBe("");
  });
});
