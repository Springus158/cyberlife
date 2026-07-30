// Shared keyboard-list engine: j/k or arrows move a cursor over DOM items,
// Enter opens, single-letter verbs act on the selection. Modules build their
// onKey hook with this and register it in the shell registry.
//
// With getKey the cursor is identity-based (e.g. a thread id): re-renders
// replace the DOM nodes but refresh() repaints the cursor on the same item,
// so background refreshes never move it. Without getKey it falls back to a
// positional index.

export function createSelectableList({ getItems, onOpen, onMove = null, verbs = {}, getKey = null, anchor = null }) {
  let index = -1;
  let key = null;

  function visibleItems() {
    return getItems().filter(el => el.offsetParent !== null);
  }

  // The cursor position for this keystroke: a live key wins; a vanished key
  // (or no cursor yet) falls back to the module's anchor (its "open" item)
  function resolveIndex(items) {
    if (getKey) {
      if (key !== null) {
        const i = items.findIndex(el => getKey(el) === key);
        if (i !== -1) return i;
      }
    } else if (index >= 0 && index < items.length && items[index].classList.contains('kb-selected')) {
      return index;
    }
    if (anchor) {
      const pred = anchor();
      if (pred) {
        const i = items.findIndex(pred);
        if (i !== -1) return i;
      }
    }
    return Math.min(index, items.length - 1);
  }

  function setCursor(items, i) {
    index = i;
    key = getKey && items[i] ? getKey(items[i]) : key;
    items.forEach((el, n) => el.classList.toggle('kb-selected', n === i));
    if (items[i]) items[i].scrollIntoView({ block: 'nearest' });
  }

  return {
    reset() {
      index = -1;
      key = null;
    },

    selected() {
      const items = visibleItems();
      return items[resolveIndex(items)] || null;
    },

    // syncTo moves the cursor to an externally-chosen item (mouse/hint
    // click); renders should use refresh(), which never moves it
    syncTo(predicate) {
      const items = visibleItems();
      const i = items.findIndex(predicate);
      if (i === -1) {
        index = -1;
        key = null;
        items.forEach(el => el.classList.remove('kb-selected'));
        return;
      }
      setCursor(items, i);
    },

    // refresh repaints the cursor after a re-render (same item, new nodes)
    refresh() {
      if (!getKey || key === null) return;
      const items = visibleItems();
      const i = items.findIndex(el => getKey(el) === key);
      if (i !== -1) setCursor(items, i);
    },

    // Returns true when the key was consumed
    onKey(e) {
      const items = visibleItems();

      if (items.length > 0) {
        switch (e.key) {
          case 'j':
          case 'ArrowDown':
            e.preventDefault();
            setCursor(items, Math.min(items.length - 1, resolveIndex(items) + 1));
            if (onMove) onMove(items[index] || null);
            return true;
          case 'k':
          case 'ArrowUp':
            e.preventDefault();
            setCursor(items, Math.max(0, resolveIndex(items) - 1));
            if (onMove) onMove(items[index] || null);
            return true;
          case 'Enter': {
            const sel = items[resolveIndex(items)];
            if (!sel) return false;
            e.preventDefault();
            if (onOpen) onOpen(sel);
            else sel.click();
            return true;
          }
        }
      }

      const verb = verbs[e.key];
      if (verb) {
        e.preventDefault();
        // Verbs like compose/refresh/undo work without a selection;
        // the handler receives null then
        verb(items[resolveIndex(items)] || null);
        return true;
      }
      return false;
    },
  };
}
