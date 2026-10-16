import { memoryLedgerStore } from "./store.js";
import { describeLedgerStore } from "./store.test-helpers.js";

describeLedgerStore("memory", () => memoryLedgerStore());
