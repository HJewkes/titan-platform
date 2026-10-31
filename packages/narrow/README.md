# @titan-design/narrow

Narrow unknown values: isRecord, isObjectLike and errorCode for parsed JSON and caught errors, with no runtime dependencies

Tier 0 of the titan-platform DAG. May import only packages in the same tier or
below; the `package-layers` rule in `.codewatch/check.json` enforces this in CI.

```ts
import { errorCode, isRecord } from "@titan-design/narrow";

if (isRecord(parsed) && typeof parsed.name === "string") use(parsed.name);
if (errorCode(caught) === "ENOENT") return null;
```

- `isRecord(value)`: a non-null object that is not an array.
- `isObjectLike(value)`: any non-null object, arrays included.
- `errorCode(err)`: the string `code` on any thrown object, otherwise `undefined`.
