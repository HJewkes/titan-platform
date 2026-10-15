/**
 * Every builtin and reserved word of bash 5 (`compgen -b -k`) and of zsh 5 with each bundled module loaded
 * (`${(k)builtins} ${(k)reswords}`), plus the modules that list missed (zsh/net/tcp, zsh/net/socket, zsh/zftp,
 * zsh/ksh93, zsh/db/gdbm). A command word outside this set runs a program or a function, neither of which writes
 * the calling shell's variables except through a body the walk reads.
 */
export const SHELL_BUILTINS = new Set(
  [
    "! - . : [ [[ ]] { } alias autoload bg bind bindkey break builtin bye caller cap case cd chdir chgrp chmod chown",
    "clone command compadd comparguments compcall compctl compdescribe compfiles compgen complete compgroups compopt",
    "compquote compset comptags comptry compvalues continue coproc declare dirs disable disown do done echo echotc",
    "echoti elif else emulate enable end esac eval example exec exit export false fc fg fi float for foreach function",
    "functions getcap getln getopts hash help history if in integer jobs kill let limit ln local log logout mapfile",
    "mkdir mv nameref nocorrect noglob pcre_compile pcre_match pcre_study popd print printf private pushd pushln pwd",
    "r read readarray readonly rehash repeat return rm rmdir sched select set setcap setopt shift shopt source stat",
    "strftime suspend sync syserror sysopen sysread sysseek syswrite test then time times trap true ttyctl type",
    "typeset ulimit umask unalias unfunction unhash unlimit unset unsetopt until vared wait whence where which while",
    "zcompile zcurses zdelattr zf_chgrp zf_chmod zf_chown zf_ln zf_mkdir zf_mv zf_rm zf_rmdir zf_sync zformat zftp",
    "zgdbmpath zgetattr zle zlistattr zmodload zparseopts zprof zpty zregexparse zselect zsetattr zsocket zstat",
    "zstyle zsystem ztcp ztie zuntie",
  ]
    .join(" ")
    .split(" "),
);

/** Builtins that write no variable, or only fixed names such as PWD, and evaluate no argument as code or arithmetic. */
export const INERT_BUILTINS = new Set(
  [
    ": [ ]] alias bg bind bindkey bye caller case cd chdir chgrp chmod chown complete compopt dirs disown echo esac false",
    "fg functions hash help history in jobs kill ln log logout mkdir mv pcre_compile pcre_study popd pushd pushln pwd",
    "rehash rm rmdir setopt shopt suspend sync test times true ttyctl type umask unalias unfunction unhash unsetopt",
    "whence where which zcompile zf_chgrp zf_chmod zf_chown zf_ln zf_mkdir zf_mv zf_rm zf_rmdir zf_sync zprof",
  ]
    .join(" ")
    .split(" "),
);

/** Builtins whose numeric arguments zsh evaluates as arithmetic, as `shift x` or `printf %d x` does. */
export const ARITH_BUILTINS = new Set(["break", "continue", "exit", "limit", "printf", "repeat", "return", "shift", "ulimit", "unlimit"]);
