import { count } from "./store.js";

export function report(): string {
  return `rows: ${count()}`;
}
