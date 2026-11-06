// Turns one folder from room/content.json into page elements. Shared by the room (room/main.js, the windows that open
// over it) and the text version (classic.html, every folder in a column), so both always say and look the same.

export function el(tag, text, props = {}) {
  const e = Object.assign(document.createElement(tag), props);
  if (text != null) e.textContent = text;
  return e;
}

export function linkLabel(url) {
  if (url.startsWith('mailto:')) return 'Send an email →';
  if (url.includes('github.com')) return 'On GitHub ↗';
  return /^https?:/.test(url) ? 'Open ↗' : 'Open →';
}

// The inside of a window: the title, an optional intro, then one row per item (logo, title, meta, text: a paragraph,
// or a list of bullet points; link, image), or
// for a gallery (f.layout === 'gallery') a grid of polaroids: the square thumb and the title as a handwritten caption.
// The photos are only shown: nothing opens them (owner, 2026-11-06).
export function folderNodes(f) {
  const parts = [el('h2', f.title || f.name, { className: 'display' })];
  if (f.intro) parts.push(el('p', f.intro, { className: 'intro' }));
  if (f.layout === 'gallery') {
    const grid = el('div', null, { className: 'gallery' });
    for (const it of f.items || []) {
      const fig = el('figure', null, { className: 'snap' });
      fig.append(el('img', null, { src: it.thumb || it.image, alt: it.title || '', loading: 'lazy', draggable: false }), el('figcaption', it.title));
      grid.append(fig);
    }
    return [...parts, grid];
  }
  for (const it of f.items || []) {
    const row = el('div', null, { className: it.image ? 'row has-img' : 'row' });
    if (it.image) row.append(el('img', null, { src: it.image, alt: '', loading: 'lazy', draggable: false }));
    const body = el('div');
    let head = body;
    if (it.logo) {                                                 // a logo beside the title: a picture, or letters on a badge
      head = el('div', null, { className: 'head' });
      head.append(/\.(svg|png|jpe?g|webp)$/i.test(it.logo)
        ? el('img', null, { className: 'logo', src: it.logo, alt: '', loading: 'lazy', draggable: false })
        : el('span', it.logo, { className: 'logo', ariaHidden: 'true' }));
      body.append(head);
    }
    head.append(el('h3', it.title));
    if (it.meta) head.append(el('div', it.meta, { className: 'meta' }));
    if (Array.isArray(it.text)) {                                  // a list: bullet points
      const ul = el('ul', null, { className: 'points' });
      for (const t of it.text) ul.append(el('li', t));
      body.append(ul);
    } else if (it.text) body.append(el('p', it.text));
    if (it.link) {
      const a = el('a', linkLabel(it.link), { className: 'go', href: it.link });
      if (/^https?:/.test(it.link)) { a.target = '_blank'; a.rel = 'noopener'; }
      body.append(a);
    }
    row.append(body);
    parts.push(row);
  }
  return parts;
}

// A whole window: the title bar (three dots and a path) and the content.
export function windowNode(f, { id = f.id } = {}) {
  const win = el('section', null, { className: 'win', id });
  const head = el('header');
  const dots = el('div', null, { className: 'dots' });
  dots.append(el('i'), el('i'), el('i'));
  head.append(dots, el('span', `~/Desktop/${f.name}`));
  const content = el('div', null, { className: 'content' });
  content.append(...folderNodes(f));
  win.append(head, content);
  return win;
}

// A desktop icon's picture: a folder with the folder's symbol pressed into it, or a PDF page (kind 'pdf').
export function iconArt(kind, symbol = '') {
  const art = el('span', null, { className: kind === 'pdf' ? 'art doc' : 'art folder' });
  art.setAttribute('aria-hidden', 'true');
  art.append(kind === 'pdf' ? el('b', 'PDF') : el('i', symbol));
  return art;
}
