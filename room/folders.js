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

// The inside of a window: the title, an optional intro, then one row per item (title, meta, text, link, image), or
// for a gallery (f.layout === 'gallery') a grid of polaroids: the square thumb, the title as a handwritten caption,
// and a click opens the full photo.
export function folderNodes(f) {
  const parts = [el('h2', f.title || f.name, { className: 'display' })];
  if (f.intro) parts.push(el('p', f.intro, { className: 'intro' }));
  if (f.layout === 'gallery') {
    const grid = el('div', null, { className: 'gallery' });
    for (const it of f.items || []) {
      const fig = el('figure', null, { className: 'snap' });
      const a = el('a', null, { href: it.image, target: '_blank', rel: 'noopener' });
      a.append(el('img', null, { src: it.thumb || it.image, alt: it.title || '', loading: 'lazy' }));
      fig.append(a, el('figcaption', it.title));
      grid.append(fig);
    }
    return [...parts, grid];
  }
  for (const it of f.items || []) {
    const row = el('div', null, { className: it.image ? 'row has-img' : 'row' });
    if (it.image) row.append(el('img', null, { src: it.image, alt: '', loading: 'lazy' }));
    const body = el('div');
    body.append(el('h3', it.title));
    if (it.meta) body.append(el('div', it.meta, { className: 'meta' }));
    if (it.text) body.append(el('p', it.text));
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
