/**
 * Top-level standard-library modules, from CPython 3.13's `sys.stdlib_module_names`
 * minus private `_` modules, plus the modules 3.12 and 3.13 removed (`distutils`,
 * `imp`, `asyncore`, `cgi`, ...) because older code still imports them. Kept as
 * data rather than probed from an interpreter so an index never depends on which
 * Python, if any, the host has.
 */
const PYTHON_STDLIB_MODULES: ReadonlySet<string> = new Set([
  "__future__", "_thread", "abc", "aifc", "antigravity", "argparse", "array", "ast",
  "asynchat", "asyncio", "asyncore", "atexit", "audioop", "base64", "bdb", "binascii",
  "bisect", "builtins", "bz2", "cProfile", "calendar", "cgi", "cgitb", "chunk", "cmath",
  "cmd", "code", "codecs", "codeop", "collections", "colorsys", "compileall",
  "concurrent", "configparser", "contextlib", "contextvars", "copy", "copyreg", "crypt",
  "csv", "ctypes", "curses", "dataclasses", "datetime", "dbm", "decimal", "difflib",
  "dis", "distutils", "doctest", "email", "encodings", "ensurepip", "enum", "errno",
  "faulthandler", "fcntl", "filecmp", "fileinput", "fnmatch", "fractions", "ftplib",
  "functools", "gc", "getopt", "getpass", "gettext", "glob", "graphlib", "grp", "gzip",
  "hashlib", "heapq", "hmac", "html", "http", "idlelib", "imaplib", "imghdr", "imp",
  "importlib", "inspect", "io", "ipaddress", "itertools", "json", "keyword", "lib2to3",
  "linecache", "locale", "logging", "lzma", "mailbox", "mailcap", "marshal", "math",
  "mimetypes", "mmap", "modulefinder", "msilib", "msvcrt", "multiprocessing", "netrc",
  "nis", "nntplib", "nt", "ntpath", "nturl2path", "numbers", "opcode", "operator",
  "optparse", "os", "ossaudiodev", "pathlib", "pdb", "pickle", "pickletools", "pipes",
  "pkgutil", "platform", "plistlib", "poplib", "posix", "posixpath", "pprint", "profile",
  "pstats", "pty", "pwd", "py_compile", "pyclbr", "pydoc", "pydoc_data", "pyexpat",
  "queue", "quopri", "random", "re", "readline", "reprlib", "resource", "rlcompleter",
  "runpy", "sched", "secrets", "select", "selectors", "shelve", "shlex", "shutil",
  "signal", "site", "smtpd", "smtplib", "sndhdr", "socket", "socketserver", "spwd",
  "sqlite3", "sre_compile", "sre_constants", "sre_parse", "ssl", "stat", "statistics",
  "string", "stringprep", "struct", "subprocess", "sunau", "symtable", "sys",
  "sysconfig", "syslog", "tabnanny", "tarfile", "telnetlib", "tempfile", "termios",
  "textwrap", "this", "threading", "time", "timeit", "tkinter", "token", "tokenize",
  "tomllib", "trace", "traceback", "tracemalloc", "tty", "turtle", "turtledemo", "types",
  "typing", "unicodedata", "unittest", "urllib", "uu", "uuid", "venv", "warnings", "wave",
  "weakref", "webbrowser", "winreg", "winsound", "wsgiref", "xdrlib", "xml", "xmlrpc",
  "zipapp", "zipfile", "zipimport", "zlib", "zoneinfo",
]);

/** Whether the top-level package of a dotted module path (`os.path` → `os`) is stdlib. */
export function isPythonStdlib(dotted: string): boolean {
  const dot = dotted.indexOf(".");
  return PYTHON_STDLIB_MODULES.has(dot < 0 ? dotted : dotted.slice(0, dot));
}
