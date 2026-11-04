/** Runs in an isolated CDP world. Return booleans only; never return page/secret contents. */
export function codeProbe(text: string, clear: boolean): string {
  return `(() => {
    const code = ${JSON.stringify(text)};
    const roots = [document];
    const fields = [];
    let visible = document.title || '';
    for (let i = 0; i < roots.length; i++) {
      const root = roots[i];
      visible += (root === document ? document.body?.innerText : root.textContent) || '';
      for (const el of root.querySelectorAll('*')) {
        // Pixels in embedded content cannot be verified as secret-free by a DOM probe.
        if (el.matches('canvas,object,embed,video')) return false;
        if (el.matches('svg text')) visible += el.textContent || '';
        if (el.shadowRoot) roots.push(el.shadowRoot);
        if (el.matches('input,textarea,[contenteditable="true"]')) fields.push(el);
      }
    }
    const value = el => el.isContentEditable ? el.innerText : el.value;
    const values = fields.map(value);
    const split = values.filter(v => /^\\d$/.test(v)).join('');
    const matches = fields.filter(el => value(el)?.includes(code) || (split.includes(code) && /^\\d$/.test(value(el))));
    if (${clear}) {
      for (const el of matches) {
        if (el.isContentEditable) el.textContent = '';
        else {
          const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, '');
        }
        el.dispatchEvent(new Event('input', {bubbles:true}));
        el.dispatchEvent(new Event('change', {bubbles:true}));
      }
      return false;
    }
    return !matches.length && !visible.includes(code);
  })()`;
}
