import { Service } from "../../b/src/service.js";

export function main(): string {
  const service = new Service();
  return service.run("hello");
}
