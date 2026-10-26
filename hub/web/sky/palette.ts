// Build mode's palette (decision 39): choose a plant, a decoration, a kind of ground or a way to
// arrange the buildings, then click the island. Every change is kept as it's made.

import { esc } from '../shared/format.ts';
import { ITEMS, type ItemKind, type Tool } from './build.ts';

export interface PaletteOptions {
  /** A picture of what a tool places, if it places something. */
  preview(tool: Tool): string | null;
  onTool(tool: Tool): void;
  onUndo(): void;
  onDone(): void;
}

export interface Palette {
  show(on: boolean): void;
  hint(text: string): void;
  canUndo(can: boolean): void;
}

const items = (group: 'Plants' | 'Decor') => (Object.keys(ITEMS) as ItemKind[]).filter((k) => ITEMS[k].group === group).map((tool) => ({ tool, label: ITEMS[tool].label }));
const GROUPS: Array<{ name: string; tools: Array<{ tool: Tool; label: string }> }> = [
  { name: 'Plants', tools: items('Plants') },
  { name: 'Decor', tools: items('Decor') },
  { name: 'Ground', tools: [{ tool: 'path', label: 'Path' }, { tool: 'grass', label: 'Grass' }] },
  { name: 'Arrange', tools: [{ tool: 'move', label: 'Move' }, { tool: 'restyle', label: 'Restyle' }, { tool: 'remove', label: 'Remove' }] },
];

export function createPalette(root: HTMLElement, options: PaletteOptions): Palette {
  let tool: Tool = 'tree';

  // Drawn when it opens, by which time the island's art exists to show in it.
  function render() {
    root.innerHTML = `
      <header class="palette-head"><h2>Build</h2><button type="button" class="go small" data-done>Done</button></header>
      ${GROUPS.map((group) => `<section class="palette-group"><h3 class="eyebrow">${group.name}</h3><div class="tools">${group.tools.map((t) => {
        const picture = options.preview(t.tool);
        return `<button type="button" class="tool" data-tool="${t.tool}" aria-pressed="${t.tool === tool}">${picture ? `<img src="${picture}" alt="">` : ''}<span>${esc(t.label)}</span></button>`;
      }).join('')}</div></section>`).join('')}
      <p class="hint palette-hint" data-hint role="status"></p>
      <footer class="palette-foot"><button type="button" class="ghost small" data-undo disabled>Undo</button><span class="hint">Kept as you go, the same in every browser.</span></footer>`;
  }

  root.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const chosen = target.closest<HTMLElement>('[data-tool]')?.dataset.tool as Tool | undefined;
    if (chosen) {
      tool = chosen;
      for (const button of root.querySelectorAll<HTMLElement>('[data-tool]')) button.setAttribute('aria-pressed', String(button.dataset.tool === tool));
      return options.onTool(tool);
    }
    if (target.closest('[data-undo]')) return options.onUndo();
    if (target.closest('[data-done]')) options.onDone();
  });

  return {
    show(on) {
      if (on) {
        render();
        options.onTool(tool);
      }
      root.hidden = !on;
    },
    hint(text) {
      const el = root.querySelector('[data-hint]');
      if (el) el.textContent = text;
    },
    canUndo(can) {
      const button = root.querySelector<HTMLButtonElement>('[data-undo]');
      if (button) button.disabled = !can;
    },
  };
}
