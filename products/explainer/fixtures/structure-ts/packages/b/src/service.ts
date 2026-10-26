import { save } from "../../c/src/store.js";

export class Service {
  run(input: string): string {
    return this.helper(input.trim());
  }

  helper(value: string): string {
    return save(value);
  }
}
