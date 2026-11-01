interface ObservationHints {
  focused?: boolean;
  invalid?: boolean;
  withinFocusScope?: boolean;
  role?: string;
  attributes?: Record<string, string | undefined>;
}

export function observationPriority(item: ObservationHints): number {
  const attrs = item.attributes || {};
  const ariaInvalid = attrs['aria-invalid']?.trim().toLowerCase();
  const live = attrs['aria-live']?.trim().toLowerCase();
  if (item.focused || attrs.focused === 'true') return 4;
  if (item.invalid || attrs.invalid === 'true' || (ariaInvalid && ariaInvalid !== 'false'))
    return 3;
  if (
    ['alert', 'status'].includes((item.role || attrs.role || '').toLowerCase()) ||
    (live && live !== 'off')
  )
    return 2;
  return item.withinFocusScope ? 1 : 0;
}
