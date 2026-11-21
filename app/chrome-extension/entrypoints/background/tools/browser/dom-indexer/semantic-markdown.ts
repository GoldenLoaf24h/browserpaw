import { getShadowRoot } from '../dom-indexer';

export interface SemanticMarkdownOptions {
  includeLinks?: boolean;
  fit?: boolean;
}

export interface SemanticMarkdownResult {
  markdown: string;
}

export function inPageExtractMarkdown(includeLinks = true, fit = false): string {
  const droppedTags = new Set([
    'script',
    'style',
    'head',
    'meta',
    'link',
    'title',
    'noscript',
    'template',
    'svg',
  ]);

  function isVisible(el: Element): boolean {
    if (!(el instanceof HTMLElement)) return true;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (parseFloat(style.opacity || '1') <= 0) return false;
    return true;
  }

  // fit mode: crawl4ai-style heuristic pruning (in-browser equivalent of chrome fit-markdown).
  // Only removes structural noise without BM25/scoring agent filters content downstream.
  let fitRoot: ParentNode = document;
  const fitNoise = new Set<Element>();
  if (fit) {
    try {
      const main = document.querySelector('article, main, [role=main], #content, .content');
      fitRoot =
        main instanceof HTMLElement && main.innerText.trim().length > 200 ? main : document.body;
      const noise = fitRoot.querySelectorAll(
        'nav, header, footer, aside, form, [role=navigation], [role=banner], [role=contentinfo], [aria-hidden=true]',
      );
      noise.forEach((el) => fitNoise.add(el));
    } catch {}
  }

  const visited = new Set<Node>();

  function serializeChildren(node: Node): string {
    let res = '';
    for (const child of Array.from(node.childNodes)) {
      res += serializeNode(child);
    }
    return res;
  }

  function serializeNode(node: Node): string {
    if (visited.has(node)) return '';
    visited.add(node);
    if (node.nodeType === Node.TEXT_NODE) {
      return (node.textContent || '').replace(/\r\n/g, '\n');
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return '';
    }

    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (droppedTags.has(tag)) return '';
    if (fitNoise.size > 0 && fitNoise.has(el)) return '';
    if (!isVisible(el)) return '';

    // Handle image elements
    if (tag === 'img') {
      const src = (el as HTMLImageElement).src || el.getAttribute('src') || '';
      const alt = el.getAttribute('alt') || '';
      if (!src) return '';
      return alt ? `![${alt}](${src})` : `![](${src})`;
    }

    // Handle horizontal rule and line break
    if (tag === 'hr') return '\n\n---\n\n';
    if (tag === 'br') return '\n';

    let inner = '';
    if (tag === 'slot') {
      const assigned =
        typeof (el as HTMLSlotElement).assignedNodes === 'function'
          ? (el as HTMLSlotElement).assignedNodes({ flatten: true })
          : [];
      if (assigned.length > 0) {
        return assigned.map((n) => serializeNode(n)).join('');
      }
      return serializeChildren(el);
    }
    const shadow = getShadowRoot(el);
    if (shadow) {
      for (const child of Array.from(shadow.childNodes)) {
        inner += serializeNode(child);
      }
    } else {
      inner = serializeChildren(el);
    }

    const trimmed = inner.trim();

    // Preserve whitespace around inline formatting tokens
    const leadingSpace = inner.match(/^\s*/)?.[0] || '';
    const trailingSpace = inner.match(/\s*$/)?.[0] || '';

    switch (tag) {
      case 'h1':
        return trimmed ? `\n\n# ${trimmed}\n\n` : '';
      case 'h2':
        return trimmed ? `\n\n## ${trimmed}\n\n` : '';
      case 'h3':
        return trimmed ? `\n\n### ${trimmed}\n\n` : '';
      case 'h4':
        return trimmed ? `\n\n#### ${trimmed}\n\n` : '';
      case 'h5':
        return trimmed ? `\n\n##### ${trimmed}\n\n` : '';
      case 'h6':
        return trimmed ? `\n\n###### ${trimmed}\n\n` : '';
      case 'p':
        return trimmed ? `\n\n${trimmed}\n\n` : '';
      case 'a': {
        const href = (el as HTMLAnchorElement).href || el.getAttribute('href');
        if (includeLinks && href && trimmed) {
          return `${leadingSpace}[${trimmed}](${href})${trailingSpace}`;
        }
        return `${leadingSpace}${trimmed}${trailingSpace}`;
      }
      case 'strong':
      case 'b':
        return trimmed ? `${leadingSpace}**${trimmed}**${trailingSpace}` : '';
      case 'em':
      case 'i':
        return trimmed ? `${leadingSpace}*${trimmed}*${trailingSpace}` : '';
      case 'code':
        return trimmed ? `${leadingSpace}\`${trimmed}\`${trailingSpace}` : '';
      case 'pre': {
        const codeText = (el.textContent || '').trim();
        return codeText ? `\n\n\`\`\`\n${codeText}\n\`\`\`\n\n` : '';
      }
      case 'blockquote':
        return trimmed ? `\n\n> ${trimmed.replace(/\n/g, '\n> ')}\n\n` : '';
      case 'li': {
        const parentTag = el.parentElement?.tagName.toLowerCase();
        if (parentTag === 'ol') {
          const siblings = Array.from(el.parentElement?.children || []).filter(
            (c) => c.tagName.toLowerCase() === 'li',
          );
          const idx = siblings.indexOf(el) + 1;
          return `\n${idx > 0 ? idx : 1}. ${trimmed}`;
        }
        return trimmed ? `\n- ${trimmed}` : '';
      }
      case 'ul':
      case 'ol':
        return trimmed ? `\n\n${trimmed}\n\n` : '';
      case 'button':
        return trimmed ? `[Button: ${trimmed}]` : '';
      case 'table':
        return trimmed ? `\n\n${trimmed}\n\n` : '';
      case 'tr': {
        const cells = Array.from(el.children).filter(
          (c) => c.tagName.toLowerCase() === 'td' || c.tagName.toLowerCase() === 'th',
        );
        if (cells.length === 0) return '';
        const rowStr =
          '| ' +
          cells.map((c) => (c.textContent || '').trim().replace(/\|/g, '\\|')).join(' | ') +
          ' |';
        const isHeaderRow =
          cells.every((c) => c.tagName.toLowerCase() === 'th') ||
          el.parentElement?.tagName.toLowerCase() === 'thead';
        if (isHeaderRow) {
          const sep = '| ' + cells.map(() => '---').join(' | ') + ' |';
          return `\n${rowStr}\n${sep}`;
        }
        return `\n${rowStr}`;
      }
      case 'td':
      case 'th':
        return trimmed;
      case 'thead':
      case 'tbody':
      case 'tfoot':
        return inner;
      case 'div':
      case 'section':
      case 'article':
      case 'main':
      case 'header':
      case 'footer':
      case 'aside':
      case 'nav':
        return trimmed ? `\n\n${trimmed}\n\n` : '';
      default:
        return inner;
    }
  }

  const rawSource: Node = fit ? fitRoot : (document.body as Node);
  const raw = rawSource ? serializeNode(rawSource) : '';

  // Apply light SPA JSON blob cleanup mirroring browser-use
  const processed = raw
    .replace(/`\{["\w].*?\}`/gs, '')
    .replace(/\{"\$type":[^}]{100,}\}/g, '')
    .replace(/\{"[^"]{5,}":\{[^}]{100,}\}/g, '');

  const lines = processed.split('\n');
  const filteredLines: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 100 && (trimmed.startsWith('{') || trimmed.startsWith('{"'))) {
      try {
        JSON.parse(trimmed);
        continue;
      } catch {}
    }
    filteredLines.push(line.trimEnd());
  }

  try {
    delete (window as any).__mcpFitNoise__;
  } catch {}

  return filteredLines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
