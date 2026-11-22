type LexTokenKind = 'ident' | 'number' | 'string' | 'template' | 'regex' | 'punct';

interface LexToken {
  kind: LexTokenKind;
  value: string;
  start: number;
  end: number;
  lineBreakBefore: boolean;
}

interface TopToken {
  kind: LexTokenKind | 'group';
  value: string;
  start: number;
  end: number;
  lineBreakBefore: boolean;
  hasTopLevelSemiOrStmt?: boolean;
}

interface AnalyzeResult {
  invalid: boolean;
  topTokens: TopToken[];
  hasAwait: boolean;
}

const MULTI_CHAR_PUNCTUATORS = [
  '>>>=',
  '===',
  '!==',
  '>>>',
  '<<=',
  '>>=',
  '**=',
  '&&=',
  '||=',
  '??=',
  '...',
  '=>',
  '?.',
  '??',
  '&&',
  '||',
  '++',
  '--',
  '**',
  '<<',
  '>>',
  '<=',
  '>=',
  '==',
  '!=',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '&=',
  '^=',
  '|=',
] as const;

const REGEX_PREFIX_KEYWORDS = new Set([
  'return',
  'throw',
  'case',
  'delete',
  'void',
  'typeof',
  'yield',
  'await',
  'in',
  'instanceof',
  'of',
  'new',
  'else',
  'do',
]);

const STATEMENT_ONLY_KEYWORDS = new Set([
  'const',
  'let',
  'var',
  'if',
  'for',
  'while',
  'do',
  'switch',
  'try',
  'throw',
  'return',
  'break',
  'continue',
  'debugger',
  'export',
  'with',
]);

const RESERVED_VAR_NAMES = new Set([
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'import',
  'in',
  'instanceof',
  'new',
  'null',
  'return',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
  'await',
]);

const CONTROL_PAREN_KEYWORDS = new Set(['if', 'while', 'for', 'with']);

const PREFIX_UNARY_PUNCT = new Set(['+', '-', '!', '~', '++', '--', '...']);
const PREFIX_UNARY_KEYWORDS = new Set(['typeof', 'void', 'delete', 'await', 'yield', 'new']);

const BINARY_PUNCT = new Set([
  '+',
  '-',
  '*',
  '/',
  '%',
  '**',
  '=',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '**=',
  '<<=',
  '>>=',
  '>>>=',
  '&=',
  '^=',
  '|=',
  '&&=',
  '||=',
  '??=',
  '==',
  '!=',
  '===',
  '!==',
  '<',
  '<=',
  '>',
  '>=',
  '<<',
  '>>',
  '>>>',
  '&',
  '|',
  '^',
  '&&',
  '||',
  '??',
  '?',
  ':',
  ',',
]);

const BINARY_KEYWORDS = new Set(['in', 'instanceof']);

const ID_START_RE = /^[\p{ID_Start}$_#]/u;
const ID_CONTINUE_RE = /^[\p{ID_Continue}$\u200C\u200D]/u;

function isLineBreak(ch: string): boolean {
  return ch === '\n' || ch === '\r' || ch === '\u2028' || ch === '\u2029';
}

function isWhitespace(ch: string): boolean {
  return (
    ch === ' ' || ch === '\t' || ch === '\v' || ch === '\f' || ch === '\uFEFF' || ch === '\u00A0'
  );
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

function isIdentStart(code: string, index: number): boolean {
  const ch = code[index];
  if (!ch) return false;
  if (
    (ch >= 'a' && ch <= 'z') ||
    (ch >= 'A' && ch <= 'Z') ||
    ch === '_' ||
    ch === '$' ||
    ch === '#'
  ) {
    return true;
  }
  return ch.charCodeAt(0) >= 0x80 && ID_START_RE.test(code.slice(index, index + 2));
}

function isIdentContinue(code: string, index: number): boolean {
  const ch = code[index];
  if (!ch) return false;
  if (
    (ch >= 'a' && ch <= 'z') ||
    (ch >= 'A' && ch <= 'Z') ||
    (ch >= '0' && ch <= '9') ||
    ch === '_' ||
    ch === '$'
  ) {
    return true;
  }
  return ch.charCodeAt(0) >= 0x80 && ID_CONTINUE_RE.test(code.slice(index, index + 2));
}

function isOpenBracket(ch: string): ch is '(' | '[' | '{' {
  return ch === '(' || ch === '[' || ch === '{';
}

function matchingClose(open: '(' | '[' | '{'): ')' | ']' | '}' {
  if (open === '(') return ')';
  if (open === '[') return ']';
  return '}';
}

function canStartRegex(prev: LexToken | null, prevWasControlParenClose: boolean): boolean {
  if (!prev) return true;
  if (prev.kind === 'punct') {
    if (prev.value === ')' && prevWasControlParenClose) return true;
    if (prev.value === '}' || prev.value === ')' || prev.value === ']') return false;
    if (prev.value === '++' || prev.value === '--' || prev.value === '.' || prev.value === '?.') {
      return false;
    }
    return true;
  }
  if (prev.kind === 'ident') {
    return REGEX_PREFIX_KEYWORDS.has(prev.value);
  }
  return false;
}

/**
 * Lexes JavaScript source without using eval / Function / AsyncFunction (safe under MV3 SW CSP),
 * building balanced top-level atoms and tracking whether `await` appears in code position.
 */
function analyzeSource(code: string): AnalyzeResult {
  const len = code.length;
  const topTokens: TopToken[] = [];

  interface GroupFrame {
    open: '(' | '[' | '{';
    start: number;
    lineBreakBefore: boolean;
    isControlParen: boolean;
    isTemplateExpr: boolean;
    innerTokens?: LexToken[];
    hasTopLevelSemiOrStmt?: boolean;
  }

  const stack: GroupFrame[] = [];
  let index = 0;
  let pendingLineBreak = false;
  let prevToken: LexToken | null = null;
  let prevPrevToken: LexToken | null = null;
  let prevWasControlParenClose = false;
  let hasAwait = false;

  const recordToken = (tok: LexToken) => {
    if (
      tok.kind === 'ident' &&
      tok.value === 'await' &&
      !(prevToken?.kind === 'punct' && (prevToken.value === '.' || prevToken.value === '?.'))
    ) {
      // Check next non-whitespace char to avoid `{ await: 1 }` property key false positive
      let look = tok.end;
      while (look < len && (isWhitespace(code[look]) || isLineBreak(code[look]))) look++;
      if (code[look] !== ':') {
        hasAwait = true;
      }
    }

    if (stack.length === 1 && stack[0].open === '{' && !stack[0].isTemplateExpr) {
      stack[0].innerTokens!.push(tok);
    }

    if (stack.length === 0) {
      topTokens.push(tok);
    }

    prevPrevToken = prevToken;
    prevToken = tok;
    prevWasControlParenClose = false;
  };

  const scanTemplateChunk = (
    tokenStart: number,
    scanPos: number,
    lineBreakBefore: boolean,
  ): boolean => {
    let pos = scanPos;
    while (pos < len) {
      const ch = code[pos];
      if (ch === '\\') {
        if (pos + 1 >= len) return false;
        pos += 2;
        continue;
      }
      if (ch === '`') {
        pos++;
        const tok: LexToken = {
          kind: 'template',
          value: code.slice(tokenStart, pos),
          start: tokenStart,
          end: pos,
          lineBreakBefore,
        };
        index = pos;
        recordToken(tok);
        return true;
      }
      if (ch === '$' && code[pos + 1] === '{') {
        const braceStart = pos;
        pos += 2;
        index = pos;
        stack.push({
          open: '{',
          start: tokenStart,
          lineBreakBefore,
          isControlParen: false,
          isTemplateExpr: true,
        });
        const openTok: LexToken = {
          kind: 'punct',
          value: '${',
          start: braceStart,
          end: pos,
          lineBreakBefore: false,
        };
        prevPrevToken = prevToken;
        prevToken = openTok;
        prevWasControlParenClose = false;
        return true;
      }
      pos++;
    }
    return false;
  };

  while (index < len) {
    const ch = code[index];

    if (isLineBreak(ch)) {
      pendingLineBreak = true;
      index++;
      continue;
    }
    if (isWhitespace(ch)) {
      index++;
      continue;
    }

    // Single-line comment
    if (ch === '/' && code[index + 1] === '/') {
      index += 2;
      while (index < len && !isLineBreak(code[index])) index++;
      continue;
    }

    // Multi-line comment
    if (ch === '/' && code[index + 1] === '*') {
      index += 2;
      let closed = false;
      while (index + 1 < len) {
        if (isLineBreak(code[index])) pendingLineBreak = true;
        if (code[index] === '*' && code[index + 1] === '/') {
          index += 2;
          closed = true;
          break;
        }
        index++;
      }
      if (!closed) return { invalid: true, topTokens: [], hasAwait };
      continue;
    }

    const lineBreakBefore = pendingLineBreak;
    pendingLineBreak = false;

    // String literal
    if (ch === "'" || ch === '"') {
      const quote = ch;
      const start = index;
      index++;
      let closed = false;
      while (index < len) {
        const c = code[index];
        if (c === '\\') {
          if (index + 1 >= len) return { invalid: true, topTokens: [], hasAwait };
          if (code[index + 1] === '\r' && code[index + 2] === '\n') index += 3;
          else index += 2;
          continue;
        }
        if (c === quote) {
          index++;
          closed = true;
          break;
        }
        if (c === '\n' || c === '\r') {
          return { invalid: true, topTokens: [], hasAwait };
        }
        index++;
      }
      if (!closed) return { invalid: true, topTokens: [], hasAwait };
      recordToken({
        kind: 'string',
        value: code.slice(start, index),
        start,
        end: index,
        lineBreakBefore,
      });
      continue;
    }

    // Template literal
    if (ch === '`') {
      const ok = scanTemplateChunk(index, index + 1, lineBreakBefore);
      if (!ok) return { invalid: true, topTokens: [], hasAwait };
      continue;
    }

    // Regex literal vs division operator
    if (ch === '/' && canStartRegex(prevToken, prevWasControlParenClose)) {
      const start = index;
      index++;
      let inCharClass = false;
      let closed = false;
      while (index < len) {
        const c = code[index];
        if (c === '\\') {
          if (index + 1 >= len || isLineBreak(code[index + 1])) {
            return { invalid: true, topTokens: [], hasAwait };
          }
          index += 2;
          continue;
        }
        if (isLineBreak(c)) {
          return { invalid: true, topTokens: [], hasAwait };
        }
        if (c === '[') {
          inCharClass = true;
          index++;
          continue;
        }
        if (c === ']' && inCharClass) {
          inCharClass = false;
          index++;
          continue;
        }
        if (c === '/' && !inCharClass) {
          index++;
          closed = true;
          break;
        }
        index++;
      }
      if (!closed) return { invalid: true, topTokens: [], hasAwait };
      while (index < len && isIdentContinue(code, index)) index++;
      recordToken({
        kind: 'regex',
        value: code.slice(start, index),
        start,
        end: index,
        lineBreakBefore,
      });
      continue;
    }

    // Number literal
    if (isDigit(ch) || (ch === '.' && index + 1 < len && isDigit(code[index + 1]))) {
      const start = index;
      if (ch === '0' && (code[index + 1] === 'x' || code[index + 1] === 'X')) {
        index += 2;
        while (index < len && /[0-9a-fA-F_]/.test(code[index])) index++;
      } else if (ch === '0' && (code[index + 1] === 'b' || code[index + 1] === 'B')) {
        index += 2;
        while (index < len && /[01_]/.test(code[index])) index++;
      } else if (ch === '0' && (code[index + 1] === 'o' || code[index + 1] === 'O')) {
        index += 2;
        while (index < len && /[0-7_]/.test(code[index])) index++;
      } else {
        while (index < len && (isDigit(code[index]) || code[index] === '_')) index++;
        if (code[index] === '.' && code[index + 1] !== '.') {
          index++;
          while (index < len && (isDigit(code[index]) || code[index] === '_')) index++;
        }
        if (code[index] === 'e' || code[index] === 'E') {
          index++;
          if (code[index] === '+' || code[index] === '-') index++;
          while (index < len && (isDigit(code[index]) || code[index] === '_')) index++;
        }
      }
      if (code[index] === 'n') index++;
      recordToken({
        kind: 'number',
        value: code.slice(start, index),
        start,
        end: index,
        lineBreakBefore,
      });
      continue;
    }

    // Identifier or keyword
    if (isIdentStart(code, index)) {
      const start = index;
      index += code.codePointAt(index)! > 0xffff ? 2 : 1;
      while (index < len && isIdentContinue(code, index)) {
        index += code.codePointAt(index)! > 0xffff ? 2 : 1;
      }
      recordToken({
        kind: 'ident',
        value: code.slice(start, index),
        start,
        end: index,
        lineBreakBefore,
      });
      continue;
    }

    // Opening delimiter
    if (isOpenBracket(ch)) {
      const isControlParen =
        ch === '(' &&
        prevToken?.kind === 'ident' &&
        CONTROL_PAREN_KEYWORDS.has(prevToken.value) &&
        !(
          prevPrevToken?.kind === 'punct' &&
          (prevPrevToken.value === '.' || prevPrevToken.value === '?.')
        );

      const frame: GroupFrame = {
        open: ch,
        start: index,
        lineBreakBefore,
        isControlParen,
        isTemplateExpr: false,
        innerTokens: stack.length === 0 && ch === '{' ? [] : undefined,
      };
      const openTok: LexToken = {
        kind: 'punct',
        value: ch,
        start: index,
        end: index + 1,
        lineBreakBefore,
      };
      stack.push(frame);
      index++;
      prevPrevToken = prevToken;
      prevToken = openTok;
      prevWasControlParenClose = false;
      continue;
    }

    // Closing delimiter
    if (ch === ')' || ch === ']' || ch === '}') {
      const top = stack.pop();
      if (!top || matchingClose(top.open) !== ch) {
        return { invalid: true, topTokens: [], hasAwait };
      }
      index++;

      if (top.isTemplateExpr) {
        const ok = scanTemplateChunk(top.start, index, top.lineBreakBefore);
        if (!ok) return { invalid: true, topTokens: [], hasAwait };
        continue;
      }

      const closeTok: LexToken = {
        kind: 'punct',
        value: ch,
        start: index - 1,
        end: index,
        lineBreakBefore,
      };

      if (stack.length === 0) {
        let hasTopLevelSemiOrStmt = false;
        if (top.open === '{' && top.innerTokens) {
          hasTopLevelSemiOrStmt = hasBlockStatements(top.innerTokens);
        }
        topTokens.push({
          kind: 'group',
          value: top.open,
          start: top.start,
          end: index,
          lineBreakBefore: top.lineBreakBefore,
          hasTopLevelSemiOrStmt,
        });
      } else if (stack.length === 1 && stack[0].open === '{' && !stack[0].isTemplateExpr) {
        // Record nested group as a single placeholder token inside the depth-0 brace group
        stack[0].innerTokens!.push({
          kind: 'punct',
          value: top.open + ch,
          start: top.start,
          end: index,
          lineBreakBefore: top.lineBreakBefore,
        });
      }

      prevPrevToken = prevToken;
      prevToken = closeTok;
      prevWasControlParenClose = top.isControlParen;
      continue;
    }

    // Multi-char punctuators
    let matchedPunct = '';
    for (const candidate of MULTI_CHAR_PUNCTUATORS) {
      if (code.startsWith(candidate, index)) {
        // `?.` followed by a digit is ternary `?` followed by `.5`, not optional chaining
        if (candidate === '?.' && index + 2 < len && isDigit(code[index + 2])) {
          continue;
        }
        matchedPunct = candidate;
        break;
      }
    }

    if (matchedPunct) {
      const start = index;
      index += matchedPunct.length;
      recordToken({
        kind: 'punct',
        value: matchedPunct,
        start,
        end: index,
        lineBreakBefore,
      });
      continue;
    }

    // Single-char punctuator
    const start = index;
    index++;
    recordToken({
      kind: 'punct',
      value: ch,
      start,
      end: index,
      lineBreakBefore,
    });
  }

  if (stack.length !== 0) {
    return { invalid: true, topTokens: [], hasAwait };
  }

  return { invalid: false, topTokens, hasAwait };
}

function hasBlockStatements(innerTokens: LexToken[]): boolean {
  for (let i = 0; i < innerTokens.length; i++) {
    const tok = innerTokens[i];
    if (tok.kind === 'punct' && tok.value === ';') {
      return true;
    }
    if (tok.kind === 'ident' && STATEMENT_ONLY_KEYWORDS.has(tok.value)) {
      const prev = i > 0 ? innerTokens[i - 1] : null;
      const next = i + 1 < innerTokens.length ? innerTokens[i + 1] : null;
      const isMemberName = prev?.kind === 'punct' && (prev.value === '.' || prev.value === '?.');
      // Object property key: `{ return: 1 }`, `{ const: 2 }`, or method shorthand `{ delete() {} }`
      const isObjectPropertyKey =
        next?.kind === 'punct' && (next.value === ':' || next.value === ',' || next.value === '()');
      if (!isMemberName && !isObjectPropertyKey) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Validates that a slice of depth-0 tokens forms a single JavaScript expression
 * (rejecting multi-statement sequences separated by `;` or ASI line breaks).
 */
function isSingleExpressionTokens(tokens: TopToken[], allowTopLevelComma: boolean): boolean {
  if (tokens.length === 0) return false;

  let expectingOperand = true;
  let ternaryDepth = 0;
  let i = 0;

  while (i < tokens.length) {
    const tok = tokens[i];
    const next = i + 1 < tokens.length ? tokens[i + 1] : null;

    if (tok.kind === 'punct' && tok.value === ';') {
      return false;
    }

    if (expectingOperand) {
      if (tok.kind === 'punct') {
        if (PREFIX_UNARY_PUNCT.has(tok.value)) {
          i++;
          continue;
        }
        return false;
      }

      if (tok.kind === 'ident') {
        if (STATEMENT_ONLY_KEYWORDS.has(tok.value)) {
          return false;
        }
        if (tok.value === 'import') {
          if (
            (next?.kind === 'group' && next.value === '(') ||
            (next?.kind === 'punct' && next.value === '.')
          ) {
            expectingOperand = false;
            i++;
            continue;
          }
          return false;
        }
        if (tok.value === 'new' && next?.kind === 'punct' && next.value === '.') {
          expectingOperand = false;
          i++;
          continue;
        }
        if (tok.value === 'yield' && next?.kind === 'punct' && next.value === '*') {
          i += 2;
          continue;
        }
        if (PREFIX_UNARY_KEYWORDS.has(tok.value)) {
          i++;
          continue;
        }
        if (tok.value === 'async') {
          const nextNext = i + 2 < tokens.length ? tokens[i + 2] : null;
          const isAsyncFn =
            (next?.kind === 'ident' && next.value === 'function' && !next.lineBreakBefore) ||
            (next?.kind === 'group' &&
              next.value === '(' &&
              nextNext?.kind === 'punct' &&
              nextNext.value === '=>') ||
            (next?.kind === 'ident' &&
              !STATEMENT_ONLY_KEYWORDS.has(next.value) &&
              !next.lineBreakBefore &&
              nextNext?.kind === 'punct' &&
              nextNext.value === '=>');
          if (isAsyncFn) {
            i++;
            continue;
          }
        }
        if (tok.value === 'function') {
          let cursor = i + 1;
          if (tokens[cursor]?.kind === 'punct' && tokens[cursor].value === '*') cursor++;
          if (tokens[cursor]?.kind === 'ident') cursor++;
          if (tokens[cursor]?.kind !== 'group' || tokens[cursor].value !== '(') return false;
          cursor++;
          if (tokens[cursor]?.kind !== 'group' || tokens[cursor].value !== '{') return false;
          i = cursor + 1;
          expectingOperand = false;
          continue;
        }
        if (tok.value === 'class') {
          let cursor = i + 1;
          if (tokens[cursor]?.kind === 'ident' && tokens[cursor].value !== 'extends') cursor++;
          if (tokens[cursor]?.kind === 'ident' && tokens[cursor].value === 'extends') {
            cursor++;
            const extendsStart = cursor;
            while (
              cursor < tokens.length &&
              !(tokens[cursor].kind === 'group' && tokens[cursor].value === '{')
            ) {
              cursor++;
            }
            if (!isSingleExpressionTokens(tokens.slice(extendsStart, cursor), false)) {
              return false;
            }
          }
          if (tokens[cursor]?.kind !== 'group' || tokens[cursor].value !== '{') return false;
          i = cursor + 1;
          expectingOperand = false;
          continue;
        }
        // Labeled statement at start (e.g. `label: foo()`)
        if (i === 0 && next?.kind === 'punct' && next.value === ':') {
          return false;
        }
        expectingOperand = false;
        i++;
        continue;
      }

      if (
        tok.kind === 'number' ||
        tok.kind === 'string' ||
        tok.kind === 'template' ||
        tok.kind === 'regex'
      ) {
        expectingOperand = false;
        i++;
        continue;
      }

      if (tok.kind === 'group') {
        if (tok.value === '{' && tok.hasTopLevelSemiOrStmt) {
          return false;
        }
        expectingOperand = false;
        i++;
        continue;
      }

      return false;
    }

    // expectingOperand === false (after an operand)
    if (tok.kind === 'punct') {
      if (tok.value === '++' || tok.value === '--') {
        if (tok.lineBreakBefore) return false;
        i++;
        continue;
      }
      if (tok.value === '.' || tok.value === '?.') {
        if (
          tok.value === '?.' &&
          next?.kind === 'group' &&
          (next.value === '(' || next.value === '[')
        ) {
          i += 2;
          continue;
        }
        if (next?.kind === 'ident') {
          i += 2;
          continue;
        }
        return false;
      }
      if (tok.value === '=>') {
        if (tok.lineBreakBefore) return false;
        if (next?.kind === 'group' && next.value === '{') {
          i += 2;
          expectingOperand = false;
          continue;
        }
        i++;
        expectingOperand = true;
        continue;
      }
      if (BINARY_PUNCT.has(tok.value)) {
        if (tok.value === ',' && !allowTopLevelComma) return false;
        if (tok.value === '?') {
          ternaryDepth++;
        } else if (tok.value === ':') {
          if (ternaryDepth <= 0) return false;
          ternaryDepth--;
        }
        i++;
        expectingOperand = true;
        continue;
      }
      return false;
    }

    if (tok.kind === 'ident' && BINARY_KEYWORDS.has(tok.value)) {
      i++;
      expectingOperand = true;
      continue;
    }

    if (tok.kind === 'group' && (tok.value === '(' || tok.value === '[')) {
      i++;
      continue;
    }

    if (tok.kind === 'template') {
      i++;
      continue;
    }

    return false;
  }

  return !expectingOperand && ternaryDepth === 0;
}

function stripTrailingSemicolons(tokens: TopToken[]): TopToken[] {
  let end = tokens.length;
  while (end > 0 && tokens[end - 1].kind === 'punct' && tokens[end - 1].value === ';') {
    end--;
  }
  return tokens.slice(0, end);
}

/**
 * Detect if user code is a single JavaScript expression without calling eval/Function.
 * Correctly handles trailing semicolons, comments, strings, templates, regexes, and nested blocks.
 */
export function detectSingleExpression(code: string): string | null {
  const rawTrimmed = code.trim();
  if (!rawTrimmed) return null;

  const analyzed = analyzeSource(code);
  if (analyzed.invalid || analyzed.topTokens.length === 0) return null;

  const trimmedTokens = stripTrailingSemicolons(analyzed.topTokens);
  if (trimmedTokens.length === 0) return null;

  if (!isSingleExpressionTokens(trimmedTokens, true)) {
    return null;
  }

  const start = trimmedTokens[0].start;
  const end = trimmedTokens[trimmedTokens.length - 1].end;
  return code.slice(start, end);
}

/**
 * Detect if user code is a single `const|let|var <ident> = <expr>` declaration
 * so it can auto-return the declared variable.
 */
export function detectSingleVarDeclaration(code: string): string | null {
  const analyzed = analyzeSource(code);
  if (analyzed.invalid || analyzed.topTokens.length < 4) return null;

  const trimmedTokens = stripTrailingSemicolons(analyzed.topTokens);
  if (trimmedTokens.length < 4) return null;

  const [declKw, varIdent, eqTok, ...rhsTokens] = trimmedTokens;
  if (
    declKw.kind !== 'ident' ||
    (declKw.value !== 'const' && declKw.value !== 'let' && declKw.value !== 'var')
  ) {
    return null;
  }
  if (
    varIdent.kind !== 'ident' ||
    varIdent.value.startsWith('#') ||
    RESERVED_VAR_NAMES.has(varIdent.value)
  ) {
    return null;
  }
  if (eqTok.kind !== 'punct' || eqTok.value !== '=') {
    return null;
  }
  if (!isSingleExpressionTokens(rhsTokens, false)) {
    return null;
  }
  return varIdent.value;
}

/**
 * Prepare user code for execution inside a function body and report whether an
 * AsyncFunction wrapper is required (top-level or nested `await` usage).
 */
export function prepareUserCodeBody(code: string): { body: string; needsAsync: boolean } {
  const analyzed = analyzeSource(code);
  const needsAsync = analyzed.hasAwait;

  if (!analyzed.invalid && analyzed.topTokens.length > 0) {
    const trimmedTokens = stripTrailingSemicolons(analyzed.topTokens);
    if (trimmedTokens.length > 0 && isSingleExpressionTokens(trimmedTokens, true)) {
      const start = trimmedTokens[0].start;
      const end = trimmedTokens[trimmedTokens.length - 1].end;
      return {
        body: `return (\n${code.slice(start, end)}\n);\n`,
        needsAsync,
      };
    }

    if (trimmedTokens.length >= 4) {
      const [declKw, varIdent, eqTok, ...rhsTokens] = trimmedTokens;
      if (
        declKw.kind === 'ident' &&
        (declKw.value === 'const' || declKw.value === 'let' || declKw.value === 'var') &&
        varIdent.kind === 'ident' &&
        !varIdent.value.startsWith('#') &&
        !RESERVED_VAR_NAMES.has(varIdent.value) &&
        eqTok.kind === 'punct' &&
        eqTok.value === '=' &&
        isSingleExpressionTokens(rhsTokens, false)
      ) {
        return {
          body: `${code.trim()}\nreturn ${varIdent.value};\n`,
          needsAsync,
        };
      }
    }
  }

  return {
    body: `${code}\n`,
    needsAsync,
  };
}
