type Root = Document | ShadowRoot;
type Entry = { key: string; state: string; value: unknown; registry: unknown; indexCount?: number };

/** One result per document. Uncertainty always falls back to the original collector. */
export class DocumentObservationCache {
  private observer: MutationObserver;
  private roots: Root[] = [];
  private nodes: Element[] = [];
  private shadows = new Map<Element, ShadowRoot | null>();
  private identities = new WeakMap<object, number>();
  private nextIdentity = 0;
  private dirty = true;
  private entry?: Entry;
  reused = false;
  private readonly pseudoStates: string[];

  constructor(
    private readonly doc: Document,
    private readonly shadowOf: (element: Element) => ShadowRoot | null,
  ) {
    this.pseudoStates = [
      ':defined',
      ':open',
      ':focus-visible',
      ':modal',
      ':popover-open',
      ':fullscreen',
      ':picture-in-picture',
      ':user-valid',
      ':user-invalid',
      ':autofill',
    ].filter((selector) => doc.defaultView?.CSS?.supports?.(`selector(${selector})`));
    this.observer = new MutationObserver((records) => {
      if (records.some((record) => !this.ignored(record.target))) {
        this.dirty = true;
        this.entry = undefined;
      }
    });
  }

  private ignored(node: Node): boolean {
    // The cursor supplies its actual closed-shadow node in this extension's isolated world.
    const overlay = (globalThis as any)[Symbol.for('__browserpaw_agent_overlay__')] as
      Element | undefined;
    return Boolean(overlay?.contains(node));
  }

  private changed(): boolean {
    return this.observer.takeRecords().some((record) => !this.ignored(record.target));
  }

  dispose(): void {
    this.observer.disconnect();
    this.entry = undefined;
    this.nodes = [];
    this.roots = [];
    this.shadows.clear();
    this.dirty = true;
  }

  private refresh(): void {
    this.observer.disconnect();
    this.roots = [this.doc];
    this.nodes = [];
    this.shadows.clear();
    for (const root of this.roots) {
      this.observer.observe(root, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
      for (const element of root.querySelectorAll('*')) {
        if (this.ignored(element)) continue;
        this.nodes.push(element);
        if (this.nodes.length > 5000) {
          this.dirty = false;
          return;
        }
        const shadow = this.shadowOf(element);
        this.shadows.set(element, shadow);
        if (shadow) this.roots.push(shadow);
      }
    }
    this.dirty = false;
  }

  private state(): string | null {
    const view = this.doc.defaultView;
    if (!view || this.doc.readyState !== 'complete' || !this.doc.getAnimations) return null;
    if (this.doc.fonts?.status === 'loading') return null;
    if (this.changed()) this.dirty = true;
    if (!this.dirty && this.nodes.some((el) => this.shadowOf(el) !== this.shadows.get(el)))
      this.dirty = true;
    if (this.dirty) {
      this.entry = undefined;
      this.refresh();
    }
    if (this.nodes.length > 5000) return null;
    if (
      this.roots.some(
        (root) =>
          !root.getAnimations ||
          root.getAnimations().some((animation) => {
            const target = (animation.effect as KeyframeEffect | null)?.target;
            return !target || !this.ignored(target);
          }),
      )
    )
      return null;
    if (
      this.nodes.some((el) =>
        /^(animate|animatemotion|animatetransform|set|audio|video)$/i.test(el.tagName),
      )
    )
      return null;

    const css: unknown[] = [];
    const importing = new Set<CSSStyleSheet>();
    let cssLength = 0;
    const conditions = (rules: CSSRuleList): void => {
      for (const rule of rules) {
        if ('media' in rule)
          css.push(view.matchMedia((rule as CSSMediaRule).media.mediaText).matches);
        if ('styleSheet' in rule) {
          const imported = (rule as CSSImportRule).styleSheet;
          if (!imported) throw new Error('Stylesheet import is not ready');
          addSheet(imported);
        }
        if ('cssRules' in rule) conditions((rule as CSSGroupingRule).cssRules);
      }
    };
    const addSheet = (sheet: CSSStyleSheet): void => {
      if (importing.has(sheet)) throw new Error('Cyclic stylesheet import');
      importing.add(sheet);
      const media = sheet.media?.mediaText || '';
      css.push(
        this.identity(sheet),
        sheet.href,
        sheet.disabled,
        media,
        media ? view.matchMedia(media).matches : true,
      );
      for (const rule of sheet.cssRules) {
        if (/:state\(/i.test(rule.cssText))
          throw new Error('Custom element states require full capture');
        cssLength += rule.cssText.length;
        if (cssLength > 250_000) throw new Error('Stylesheet exceeds reuse probe budget');
        css.push(rule.cssText);
      }
      conditions(sheet.cssRules);
      importing.delete(sheet);
    };
    // CSSOM changes are not MutationObserver records. Opaque sheets cannot be reused safely.
    for (const root of this.roots) {
      css.push('root');
      if (!(root as Document).styleSheets && root.querySelector('style,link[rel="stylesheet"]'))
        return null;
      for (const sheet of (root as Document).styleSheets || []) addSheet(sheet);
      for (const sheet of root.adoptedStyleSheets || []) addSheet(sheet);
    }

    let controlChars = 0;
    const states = this.nodes.map((el) => {
      const rect = el.getBoundingClientRect();
      const html = el as HTMLElement;
      const control = el as HTMLInputElement;
      const type = control.type;
      const value = ['password', 'hidden', 'file'].includes(type) ? undefined : control.value;
      const validation = control.validationMessage;
      controlChars += (typeof value === 'string' ? value.length : 0) + (validation?.length || 0);
      if (controlChars > 64_000 || (control.files?.length ?? 0) > 100)
        throw new Error('Control exceeds reuse probe budget');
      return [
        rect.x,
        rect.y,
        rect.width,
        rect.height,
        html.scrollTop,
        html.scrollLeft,
        html.scrollWidth,
        html.scrollHeight,
        html.clientWidth,
        html.clientHeight,
        value,
        control.checked,
        control.indeterminate,
        (el as HTMLSelectElement).selectedIndex,
        (el as HTMLOptionElement).selected,
        control.validity?.valid,
        validation,
        (el as HTMLImageElement).currentSrc,
        control.files
          ? Array.from(control.files, (f) => [f.name, f.size, f.lastModified])
          : undefined,
        el.matches(':hover'),
        el.matches(':active'),
        this.pseudoStates.map((selector) => el.matches(selector)),
        el.tagName === 'SLOT'
          ? (el as HTMLSlotElement).assignedNodes().map((n) => this.identity(n))
          : undefined,
      ];
    });
    return JSON.stringify([
      this.doc.URL,
      this.doc.designMode,
      this.doc.baseURI,
      this.doc.title,
      view.innerWidth,
      view.innerHeight,
      view.scrollX,
      view.scrollY,
      view.devicePixelRatio,
      view.visualViewport?.width,
      view.visualViewport?.height,
      view.visualViewport?.scale,
      this.doc.fonts
        ? Array.from(this.doc.fonts, (font) => [
            this.identity(font),
            font.family,
            font.style,
            font.weight,
            font.status,
          ])
        : [],
      this.roots.map((root) => (root.activeElement ? this.identity(root.activeElement) : null)),
      css,
      states,
      (globalThis as any)[Symbol.for('__browser_use_index_namespace__')],
    ]);
  }

  private identity(node: object): number {
    let id = this.identities.get(node);
    if (id === undefined) {
      id = ++this.nextIdentity;
      this.identities.set(node, id);
    }
    return id;
  }

  read<T>(mode: 'standard' | 'fast', options: unknown, collect: () => T): T {
    this.reused = false;
    const highlight = (options as { highlight?: boolean } | undefined)?.highlight;
    const provided = Object.fromEntries(
      Object.entries((options ?? {}) as Record<string, unknown>).filter(
        ([, value]) => value !== undefined,
      ),
    );
    const effective =
      mode === 'standard'
        ? {
            viewportThreshold: 1000,
            highlight: false,
            startingIndex: 1,
            maxTextLength: 120,
            format: 'compact',
            ...provided,
          }
        : provided;
    const key = JSON.stringify([
      mode,
      Object.entries(effective).sort(([a], [b]) => a.localeCompare(b)),
    ]);
    let state: string | null = null;
    try {
      if (!highlight && !/:state\(/i.test(key)) state = this.state();
    } catch {
      /* Full capture remains authoritative. */
    }
    const registry = (globalThis as any)[Symbol.for('__browser_use_isolated_index_map__')];
    const lastMode = (globalThis as any)[Symbol.for('__browser_use_last_snapshot_type__')];
    if (
      state !== null &&
      this.entry?.key === key &&
      this.entry.state === state &&
      lastMode === mode &&
      this.entry.registry === registry &&
      this.entry.indexCount === registry?.size
    ) {
      this.reused = true;
      return structuredClone(this.entry.value) as T;
    }
    this.entry = undefined;
    const value = collect();
    const changedDuringCapture = this.changed();
    if (changedDuringCapture) this.dirty = true;
    if (state !== null && !changedDuringCapture) {
      const activeRegistry = (globalThis as any)[Symbol.for('__browser_use_isolated_index_map__')];
      this.entry = {
        key,
        state,
        value: structuredClone(value),
        registry: activeRegistry,
        indexCount: activeRegistry?.size,
      };
    }
    return value;
  }
}
