/**
 * Make sidebar `.grp` sections collapsible — clicking a section header toggles its
 * body. A few advanced sections start collapsed so the panels aren't a wall of
 * controls; everything else stays open.
 */
const COLLAPSED_BY_DEFAULT = ['lip-sync', 'transform', 'back screen'];

export function initCollapsibleSections(): void {
  for (const grp of document.querySelectorAll<HTMLElement>('.panel .grp')) {
    const h2 = grp.querySelector('h2');
    if (!h2) continue;
    const title = (h2.textContent || '').toLowerCase();
    if (COLLAPSED_BY_DEFAULT.some((t) => title.includes(t))) grp.classList.add('collapsed');
    h2.addEventListener('click', () => grp.classList.toggle('collapsed'));
  }
}
