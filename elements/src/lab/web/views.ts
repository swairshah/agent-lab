// Each element's component, by id: what the page draws for it.
import { CalendarView } from "../../elements/calendar/view.tsx";
import { ChecklistView } from "../../elements/checklist/view.tsx";
import type { ElementView } from "../../view.ts";

export const VIEWS: Record<string, ElementView<never>> = { calendar: CalendarView as ElementView<never>, checklist: ChecklistView as ElementView<never> };
