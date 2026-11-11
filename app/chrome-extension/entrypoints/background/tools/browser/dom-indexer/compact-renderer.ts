import type { IndexedElement } from 'chrome-mcp-shared';

/**
 * Format an indexed element into a concise, Accessibility-Tree-inspired line.
 * Omits closing tags and redundant markup, cutting token usage by 60%+.
 */
export function renderCompactElementLine(el: IndexedElement, frameId?: string | number): string {
  let role = el.role || el.tagName.toLowerCase();
  const tag = el.tagName.toLowerCase();
  const inputType = el.attributes?.type?.toLowerCase();
  const compactValue = (value: string | undefined) =>
    String(value || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);

  if (el.role === 'card') {
    role = 'card';
  } else if (tag === 'input') {
    if (inputType === 'checkbox') role = 'checkbox';
    else if (inputType === 'radio') role = 'radio';
    else if (inputType === 'submit' || inputType === 'button') role = 'button';
    else if (inputType === 'password') role = 'password';
    else if (inputType === 'file') role = 'file';
    else if (inputType === 'search' || el.isSearch || role === 'searchbox') role = 'searchbox';
    else role = 'textbox';
  } else if (tag === 'a') {
    role = 'link';
  } else if (tag === 'button') {
    role = 'button';
  } else if (tag === 'textarea') {
    role = 'textbox';
  } else if (tag === 'select') {
    role = 'combobox';
  } else if (tag === 'option') {
    role = 'option';
  }

  let text = el.text ? `"${el.text}"` : '';
  if (!text && el.attributes?.['aria-label']) {
    text = `"${el.attributes['aria-label']}"`;
  } else if (!text && el.attributes?.title) {
    text = `"${el.attributes.title}"`;
  }

  const parts: string[] = [`[${el.index}]`];
  if (el.isClosedShadowHost) {
    parts.push('[closed-shadow-host]');
  } else if (el.inShadowDom) {
    parts.push('[shadow]');
  }
  if (el.isComposer) {
    parts.push('[composer]');
  } else if (el.isEditor) {
    parts.push('[editor]');
  }
  parts.push(role);
  if (text) parts.push(text);

  if (
    ['table', 'grid', 'row', 'header', 'columnheader', 'rowheader', 'cell', 'gridcell'].includes(
      role,
    )
  ) {
    if (el.attributes?.tableSemantics) {
      parts.push(`tableSemantics="${compactValue(el.attributes.tableSemantics)}"`);
    }
    if (el.attributes?.tableNotice) {
      parts.push(`tableNotice="${compactValue(el.attributes.tableNotice)}"`);
    }
    if (el.attributes?.parentTable) parts.push(`table-ref=${el.attributes.parentTable}`);
    if (el.attributes?.parentRow) parts.push(`row-ref=${el.attributes.parentRow}`);
    if (el.attributes?.row) {
      const source = el.attributes.rowSource === 'aria' ? '[aria]' : '';
      parts.push(`row=${el.attributes.row}${source}`);
    }
    if (el.attributes?.column) {
      const source = el.attributes.columnSource === 'aria' ? '[aria]' : '';
      parts.push(`column=${el.attributes.column}${source}`);
    }
    if (el.attributes?.rowspan) parts.push(`rowspan=${el.attributes.rowspan}`);
    if (el.attributes?.colspan) parts.push(`colspan=${el.attributes.colspan}`);
    if (el.attributes?.['aria-sort'])
      parts.push(`sort="${compactValue(el.attributes['aria-sort'])}"`);
    if (el.attributes?.scope) parts.push(`scope="${compactValue(el.attributes.scope)}"`);
    if (el.attributes?.headerScopeSource) {
      parts.push(`headerScopeSource="${compactValue(el.attributes.headerScopeSource)}"`);
    }
    if (el.attributes?.headerDirection) {
      parts.push(`headerDirection="${compactValue(el.attributes.headerDirection)}"`);
    }
    if (el.attributes?.headers) parts.push(`headers="${compactValue(el.attributes.headers)}"`);
    if (el.attributes?.headerRefs)
      parts.push(`headerRefs="${compactValue(el.attributes.headerRefs)}"`);
    if (el.attributes?.rowHeader)
      parts.push(`rowHeader="${compactValue(el.attributes.rowHeader)}"`);
    if (el.attributes?.columnHeader) {
      parts.push(`columnHeader="${compactValue(el.attributes.columnHeader)}"`);
    }
    if (el.attributes?.headerRelation) {
      parts.push(`headerRelation="${compactValue(el.attributes.headerRelation)}"`);
    }
  }

  if (el.attributes?.id) parts.push(`#${el.attributes.id}`);
  if (el.attributes?.name && el.attributes.name !== el.text) {
    parts.push(`name="${el.attributes.name}"`);
  }
  if (el.attributes?.placeholder) parts.push(`placeholder="${el.attributes.placeholder}"`);
  if (tag === 'a' && el.attributes?.href) parts.push(`href="${el.attributes.href}"`);
  if (el.value !== undefined && el.value !== '') {
    const isSensitive =
      inputType === 'password' ||
      el.attributes?.name?.toLowerCase().includes('password') ||
      el.attributes?.autocomplete?.toLowerCase().includes('password') ||
      el.attributes?.autocomplete?.toLowerCase().includes('cc-');
    const valDisplay = isSensitive ? '•••' : el.value;
    parts.push(`value="${valDisplay}"`);
  }
  const label = compactValue(el.attributes?.label);
  if (
    label &&
    label !== compactValue(el.text) &&
    label !== compactValue(el.value) &&
    label !== '••••••••'
  ) {
    parts.push(`label="${label}"`);
  }
  if (el.attributes?.['visual-shape']) parts.push(`shape="${el.attributes['visual-shape']}"`);

  if (el.attributes?.required === 'true' || el.attributes?.required === '') parts.push('required');
  if (el.attributes?.disabled === 'true' || el.attributes?.disabled === '') parts.push('disabled');
  if (el.attributes?.invalid === 'true') {
    parts.push('invalid');
    if (el.attributes.invalidReason) {
      parts.push(`invalidReason="${compactValue(el.attributes.invalidReason)}"`);
    }
    if (el.attributes.validationMessage) {
      parts.push(`validationMessage="${compactValue(el.attributes.validationMessage)}"`);
    }
    if (el.attributes.errormessage) {
      parts.push(`errormessage="${compactValue(el.attributes.errormessage)}"`);
    }
  }
  if (el.attributes?.description) {
    parts.push(`description="${compactValue(el.attributes.description)}"`);
  }
  if (
    el.attributes?.['aria-checked'] === 'true' ||
    el.attributes?.checked === 'true' ||
    el.attributes?.checked === ''
  )
    parts.push('checked');
  if (el.attributes?.['aria-selected'] === 'true') parts.push('selected');
  if (el.attributes?.['aria-expanded']) parts.push(`expanded=${el.attributes['aria-expanded']}`);
  if (el.attributes?.focused === 'true') parts.push('focused');

  if (frameId !== undefined && frameId !== 0 && frameId !== '0') {
    parts.push(`frame="${frameId}"`);
  }

  if (el.isActionTrigger) {
    parts.push(`(action-trigger${el.actionTriggerType ? `: ${el.actionTriggerType}` : ''})`);
  }

  if (el.isOccluded) {
    parts.push(`[occluded${el.occludedBy ? ` by ${el.occludedBy}` : ''}]`);
  }

  return parts.join(' ');
}

/**
 * In-page inspection to detect active slider verification or bot challenges.
 */
