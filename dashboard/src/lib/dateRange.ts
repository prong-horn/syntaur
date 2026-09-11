import type { DateRangeField, DateRangeFilter } from '@shared/view-prefs-schema';

// The control keeps `preset`/`from`/`to` as always-strings ('' = none) so React
// treats them as controlled values; `null` = "no date filter".
export interface DateRangeUiState {
  field: DateRangeField;
  preset: string; // DateRangePreset | ''
  from: string; // YYYY-MM-DD | ''
  to: string; // YYYY-MM-DD | ''
}

export function minimizeDateRange(ui: DateRangeUiState | null): DateRangeFilter | undefined {
  if (!ui) return undefined;
  if (ui.preset) return { field: ui.field, preset: ui.preset as DateRangeFilter['preset'] };
  const from = ui.from && ui.from.length > 0 ? ui.from : undefined;
  const to = ui.to && ui.to.length > 0 ? ui.to : undefined;
  if (!from && !to) return undefined;
  const out: DateRangeFilter = { field: ui.field };
  if (from) out.from = from;
  if (to) out.to = to;
  return out;
}

export function expandDateRange(persisted: DateRangeFilter | undefined): DateRangeUiState | null {
  if (!persisted) return null;
  return {
    field: persisted.field,
    preset: persisted.preset ?? '',
    from: persisted.from ?? '',
    to: persisted.to ?? '',
  };
}
