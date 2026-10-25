---
"titan-console": patch
---

`config import` now writes rev 0 into a coordinator revision log that exists but is empty. Before this change it refused with "another writer created rev 0 first". Rev 0 is claimed with an `O_EXCL` sibling file, so two concurrent imports still cannot both write it.
