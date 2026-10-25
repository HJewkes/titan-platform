/**
 * The NFA steps every LinearRegExp has simulated in this process: one per state a closure visits and one per state a
 * character is tested against. A test reads it before and after a match to assert counted work, which no load on the
 * machine moves, where a timing ratio would flake (TP-4262).
 */
declare const linearRegExpSteps: () => number;
/**
 * A RegExp whose `test` costs input length times pattern length, for patterns built from untrusted globs. A backtracking
 * RegExp goes polynomial on runs such as `[^/]*` twenty times or `(?:.*\/)?` twelve times, which one config line or
 * command word can hold (TP-1756, TP-4223). The source is simulated as a Thompson NFA instead. It accepts the subset glob
 * compilers emit: literals, escapes, `.`, classes, `(?:)` and `()` groups, `|`, `*`, `+`, `?`, `^` and `$`, under the
 * `i` and `s` flags; other syntax throws a SyntaxError. `matches` replaces the compiled test when given. `exec` reports
 * a match as the whole input, which is what an anchored glob matches; capture groups are not reported.
 */
declare class LinearRegExp extends RegExp {
    #private;
    constructor(source: string, flags?: string, matches?: (input: string) => boolean);
    test(input: string): boolean;
    exec(input: string): RegExpExecArray | null;
}

export { LinearRegExp, linearRegExpSteps };
