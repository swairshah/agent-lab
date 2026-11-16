// Every element, by id. To add one: a folder with element.ts (its definition), view.tsx (its component) and a test,
// listed here and in src/lab/web/views.ts.
import { calendar } from "./calendar/element.ts";
import { checklist } from "./checklist/element.ts";
import type { ElementDef } from "../element.ts";

export const ELEMENTS = [calendar, checklist] as unknown as ElementDef<never>[];
