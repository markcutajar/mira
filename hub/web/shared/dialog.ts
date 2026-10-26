// One modal dialog for the page, reused by starting, renaming and removing. A click on the
// backdrop or Escape closes it.

let box: HTMLDialogElement | null = null;

export function showDialog(label: string, html: string): HTMLDialogElement {
  if (!box) {
    const created = document.createElement('dialog');
    created.className = 'dialog box';
    created.addEventListener('click', (e) => { if (e.target === created) created.close(); });
    document.body.append(created);
    box = created;
  }
  box.setAttribute('aria-label', label);
  box.returnValue = ''; // otherwise the last answer would carry over to a dialog closed with Escape
  box.innerHTML = html;
  if (!box.open) box.showModal();
  return box;
}
