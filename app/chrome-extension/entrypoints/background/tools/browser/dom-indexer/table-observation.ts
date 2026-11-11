import {
  indexElement,
  extractCleanElementText,
  getSameRootReference,
  getVisibleReferenceText,
} from '../dom-indexer';

export type TableObservationRole =
  'table' | 'grid' | 'row' | 'header' | 'cell' | 'gridcell' | 'columnheader' | 'rowheader';

const TABLE_OBSERVATION_ROLES = new Set<TableObservationRole>([
  'table',
  'grid',
  'row',
  'cell',
  'gridcell',
  'columnheader',
  'rowheader',
]);

export function getTableObservationRole(el: Element): TableObservationRole | null {
  const explicit = (el.getAttribute('role') || '').trim().toLowerCase();
  if (explicit) {
    return TABLE_OBSERVATION_ROLES.has(explicit as TableObservationRole)
      ? (explicit as TableObservationRole)
      : null;
  }

  const tag = el.tagName.toLowerCase();
  if (tag === 'table') return 'table';
  if (tag === 'tr' || tag === 'td' || tag === 'th') {
    const nativeTable = el.closest('table');
    const tableRole = (nativeTable?.getAttribute('role') || '').trim().toLowerCase();
    if (tableRole === 'none' || tableRole === 'presentation') return null;
  }
  if (tag === 'tr') return 'row';
  if (tag === 'td') return 'cell';
  if (tag === 'th') {
    const scope = (el.getAttribute('scope') || '').toLowerCase();
    if (scope === 'row' || scope === 'rowgroup') return 'rowheader';
    if (scope === 'col' || scope === 'colgroup') return 'columnheader';
    return 'header';
  }
  return null;
}

export interface TableObservation {
  role: TableObservationRole;
  text?: string;
  attributes: Record<string, string>;
}

function positiveAriaIndex(value: string | null): number | undefined {
  if (!value || !/^\d+$/.test(value.trim())) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : undefined;
}

const TABLE_CELL_SELECTOR =
  'th,td,[role="columnheader"],[role="rowheader"],[role="cell"],[role="gridcell"]';

export interface TableObservationMetadata {
  hasComplexSpans: boolean;
  cells: Element[];
  rowPositions: WeakMap<Element, number>;
  nativeColumns: WeakMap<Element, number>;
  rowHeaders: WeakMap<Element, Element>;
  columnHeaders: WeakMap<Element, Element>;
  headerTexts: WeakMap<Element, string>;
}

export type TableObservationCache = WeakMap<Element, TableObservationMetadata>;

export function createTableObservationCache(): TableObservationCache {
  return new WeakMap();
}

function hasComplexSpan(cell: Element): boolean {
  for (const attr of ['rowspan', 'colspan', 'aria-rowspan', 'aria-colspan']) {
    const raw = cell.getAttribute(attr);
    if (raw === null) continue;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value !== 1) return true;
  }
  return false;
}

function nearestTableContainer(el: Element): Element | null {
  return el.closest('table,[role="table"],[role="grid"]');
}

export function isPresentationalNativeTable(table: Element): boolean {
  if (table.tagName.toLowerCase() !== 'table') return false;
  const role = (table.getAttribute('role') || '').trim().toLowerCase();
  return role === 'none' || role === 'presentation';
}

function buildTableObservationMetadata(
  table: Element,
  nativeTable: boolean,
): TableObservationMetadata {
  const metadata: TableObservationMetadata = {
    hasComplexSpans: false,
    cells: [],
    rowPositions: new WeakMap(),
    nativeColumns: new WeakMap(),
    rowHeaders: new WeakMap(),
    columnHeaders: new WeakMap(),
    headerTexts: new WeakMap(),
  };

  if (nativeTable) {
    const activeColumnHeaders = new Map<number, Element>();
    const rows = Array.from((table as HTMLTableElement).rows);
    rows.forEach((row, rowPosition) => {
      metadata.rowPositions.set(row, rowPosition + 1);
      const cells = Array.from(row.cells);
      metadata.cells.push(...cells);
      cells.forEach((cell, columnPosition) => {
        metadata.nativeColumns.set(cell, columnPosition + 1);
        if (hasComplexSpan(cell)) metadata.hasComplexSpans = true;
        const role = getTableObservationRole(cell);
        if (role === 'rowheader' && !metadata.rowHeaders.has(row)) {
          metadata.rowHeaders.set(row, cell);
        }
        if (role === 'columnheader') activeColumnHeaders.set(columnPosition, cell);
      });
      cells.forEach((cell, columnPosition) => {
        if (getTableObservationRole(cell) !== 'cell') return;
        const header = activeColumnHeaders.get(columnPosition);
        if (header) metadata.columnHeaders.set(cell, header);
      });
    });
    return metadata;
  }

  metadata.cells = Array.from(table.querySelectorAll(TABLE_CELL_SELECTOR)).filter(
    (cell) => nearestTableContainer(cell) === table,
  );
  metadata.hasComplexSpans = metadata.cells.some(hasComplexSpan);
  return metadata;
}

function getTableObservationMetadata(
  table: Element,
  nativeTable: boolean,
  cache?: TableObservationCache,
): TableObservationMetadata {
  const cached = cache?.get(table);
  if (cached) return cached;
  const metadata = buildTableObservationMetadata(table, nativeTable);
  cache?.set(table, metadata);
  return metadata;
}

function getTableHeaderText(metadata: TableObservationMetadata, header?: Element): string {
  if (!header) return '';
  const cached = metadata.headerTexts.get(header);
  if (cached !== undefined) return cached;
  const text = getVisibleReferenceText(header, 120);
  metadata.headerTexts.set(header, text);
  return text;
}

function tableCellText(el: Element, maxTextLength: number): string {
  return extractCleanElementText(el, maxTextLength).replace(/\s+/g, ' ').trim();
}

function resolveHeaderReferences(
  el: Element,
  table: Element,
): {
  elements: Element[];
  texts: string[];
} {
  const ids = (el.getAttribute('headers') || '').split(/\s+/).filter(Boolean);
  const elements: Element[] = [];
  const texts: string[] = [];
  for (const id of ids) {
    const ref = getSameRootReference(el, id);
    const role = ref ? getTableObservationRole(ref) : null;
    if (!ref || !role || nearestTableContainer(ref) !== table) continue;
    if (elements.includes(ref)) continue;
    elements.push(ref);
    const text = getVisibleReferenceText(ref, 120);
    if (text) texts.push(text);
  }
  return { elements, texts };
}

export function buildTableObservation(
  el: Element,
  maxTextLength = 120,
  cache?: TableObservationCache,
): TableObservation | null {
  const role = getTableObservationRole(el);
  if (!role) return null;

  const table =
    role === 'table' || role === 'grid' ? el : el.closest('table,[role="table"],[role="grid"]');
  if (!table || isPresentationalNativeTable(table)) return null;

  const nativeTable = table.tagName.toLowerCase() === 'table';
  const metadata = getTableObservationMetadata(table, nativeTable, cache);
  const rowEl = role === 'row' ? el : el.closest('tr,[role="row"]');
  const tableIndex = indexElement(table);
  const rowIndex = rowEl ? indexElement(rowEl) : undefined;
  const attributes: Record<string, string> = {};

  for (const attr of [
    'scope',
    'headers',
    'aria-rowindex',
    'aria-colindex',
    'aria-rowcount',
    'aria-colcount',
    'aria-rowspan',
    'aria-colspan',
    'aria-labelledby',
    'aria-sort',
  ]) {
    const value = el.getAttribute(attr);
    if (value !== null && value.trim() !== '') attributes[attr] = value.trim().slice(0, 120);
  }
  if (el.hasAttribute('rowspan')) attributes.rowspan = el.getAttribute('rowspan') || '1';
  if (el.hasAttribute('colspan')) attributes.colspan = el.getAttribute('colspan') || '1';
  if (!attributes.rowspan && attributes['aria-rowspan']) {
    attributes.rowspan = attributes['aria-rowspan'];
  }
  if (!attributes.colspan && attributes['aria-colspan']) {
    attributes.colspan = attributes['aria-colspan'];
  }

  const explicitRole = (el.getAttribute('role') || '').trim().toLowerCase();
  if (role === 'header' || role === 'rowheader' || role === 'columnheader') {
    if (explicitRole) {
      attributes.headerScopeSource = 'aria-role';
    } else if (el.tagName.toLowerCase() === 'th') {
      const scope = (el.getAttribute('scope') || '').trim().toLowerCase();
      attributes.headerScopeSource = !scope
        ? 'implicit-html'
        : ['row', 'rowgroup', 'col', 'colgroup'].includes(scope)
          ? 'scope'
          : 'scope-invalid';
    }
    if (role === 'header') attributes.headerDirection = 'unknown';
  }

  if (role !== 'table' && role !== 'grid') attributes.parentTable = String(tableIndex);
  if (role !== 'table' && role !== 'grid' && role !== 'row' && rowIndex !== undefined) {
    attributes.parentRow = String(rowIndex);
  }

  const explicitRow = positiveAriaIndex(el.getAttribute('aria-rowindex'));
  const rowElementIndex = rowEl
    ? positiveAriaIndex(rowEl.getAttribute('aria-rowindex'))
    : undefined;
  const nativeRowIndex = nativeTable && rowEl ? metadata.rowPositions.get(rowEl) : undefined;
  if (role !== 'table' && role !== 'grid') {
    const row = explicitRow ?? rowElementIndex ?? nativeRowIndex;
    attributes.row = row === undefined ? 'unknown' : String(row);
    attributes.rowSource =
      explicitRow || rowElementIndex ? 'aria' : nativeRowIndex ? 'dom-local' : 'unknown';
  }

  const explicitColumn = positiveAriaIndex(el.getAttribute('aria-colindex'));
  const tableHasSpans = metadata.hasComplexSpans;
  const nativeColumn = nativeTable && !tableHasSpans ? metadata.nativeColumns.get(el) : undefined;
  if (role !== 'table' && role !== 'grid' && role !== 'row') {
    const column = explicitColumn ?? nativeColumn;
    attributes.column = column === undefined ? 'unknown' : String(column);
    attributes.columnSource = explicitColumn ? 'aria' : nativeColumn ? 'dom-local' : 'unknown';
  }

  if ((role === 'table' || role === 'grid') && nativeTable && metadata.cells.length > 0) {
    attributes.tableSemantics = 'html';
  } else if ((role === 'table' || role === 'grid') && !nativeTable) {
    const hasMissingPosition = metadata.cells.some((cell) => {
      const cellRole = getTableObservationRole(cell);
      if (
        !cellRole ||
        cellRole === 'header' ||
        cellRole === 'columnheader' ||
        cellRole === 'rowheader'
      ) {
        return !positiveAriaIndex(cell.getAttribute('aria-colindex'));
      }
      return (
        !positiveAriaIndex(cell.getAttribute('aria-colindex')) ||
        (!positiveAriaIndex(cell.getAttribute('aria-rowindex')) &&
          !positiveAriaIndex(cell.closest('[role="row"]')?.getAttribute('aria-rowindex') || null))
      );
    });
    attributes.tableSemantics = hasMissingPosition ? 'aria-partial' : 'aria-explicit';
    if (hasMissingPosition) {
      attributes.tableNotice =
        'ARIA table/grid is missing aria-rowindex or aria-colindex; unknown positions are not inferred';
    }
  }

  if (role === 'table' || role === 'grid') {
    const labelText = (() => {
      const labelledBy = (el.getAttribute('aria-labelledby') || '')
        .split(/\s+/)
        .filter(Boolean)
        .map((id) => getVisibleReferenceText(getSameRootReference(el, id), 120))
        .filter(Boolean)
        .join(' ');
      if (labelledBy) return labelledBy;
      const ariaLabel = (el.getAttribute('aria-label') || '').trim();
      if (ariaLabel) return ariaLabel;
      const caption = nativeTable ? (table as HTMLTableElement).caption?.textContent || '' : '';
      return caption.replace(/\s+/g, ' ').trim();
    })();
    return {
      role,
      ...(labelText ? { text: labelText.slice(0, maxTextLength) } : {}),
      attributes,
    };
  }

  if (role === 'row') return { role, attributes };

  const text = tableCellText(el, maxTextLength);
  if (role === 'header' || role === 'columnheader' || role === 'rowheader') {
    return {
      role,
      ...(text ? { text } : {}),
      attributes,
    };
  }
  const headerRefs = resolveHeaderReferences(el, table);
  if (headerRefs.elements.length > 0) {
    attributes.headerRelation = 'explicit';
    if (headerRefs.texts.length > 0) attributes.headerText = headerRefs.texts.join(' ');
    attributes.headerRefs = headerRefs.elements.map((header) => indexElement(header)).join(' ');
    const rowHeaderTexts = headerRefs.elements
      .filter((header) => getTableObservationRole(header) === 'rowheader')
      .map((header) => getVisibleReferenceText(header, 120))
      .filter(Boolean);
    const columnHeaderTexts = headerRefs.elements
      .filter((header) => getTableObservationRole(header) === 'columnheader')
      .map((header) => getVisibleReferenceText(header, 120))
      .filter(Boolean);
    if (rowHeaderTexts.length > 0) attributes.rowHeader = rowHeaderTexts.join(' ');
    if (columnHeaderTexts.length > 0) attributes.columnHeader = columnHeaderTexts.join(' ');
  } else if (nativeTable && !tableHasSpans && role === 'cell') {
    const rowHeader = getTableHeaderText(
      metadata,
      rowEl ? metadata.rowHeaders.get(rowEl) : undefined,
    );
    const columnHeader = getTableHeaderText(metadata, metadata.columnHeaders.get(el));
    if (rowHeader) attributes.rowHeader = rowHeader;
    if (columnHeader) attributes.columnHeader = columnHeader;
    attributes.headerRelation = rowHeader || columnHeader ? 'derived' : 'unknown';
  } else {
    attributes.headerRelation = 'unknown';
  }

  return {
    role,
    ...(text ? { text } : {}),
    attributes,
  };
}

export function hasDirectTableAction(el: Element): boolean {
  if (el.hasAttribute('onclick') || el.hasAttribute('onmousedown')) return true;
  if (typeof (el as any).onclick === 'function') return true;
  if (
    (el as HTMLElement).isContentEditable ||
    el.getAttribute('contenteditable') === 'true' ||
    el.getAttribute('contenteditable') === ''
  ) {
    return true;
  }
  try {
    const getEventListeners = (globalThis as any).getEventListeners;
    if (typeof getEventListeners !== 'function') return false;
    const listeners = getEventListeners(el);
    return ['click', 'mousedown', 'pointerdown'].some(
      (type) => Array.isArray(listeners?.[type]) && listeners[type].length > 0,
    );
  } catch {
    return false;
  }
}
