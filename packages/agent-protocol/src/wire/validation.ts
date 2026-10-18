import { z } from "zod";

const nonBlank = (message: string) => z.string({ error: message }).refine(value => value.trim() !== "", message);
export const requiredString = (field: string) => nonBlank(`${field} is required and must be a non-empty string`);
