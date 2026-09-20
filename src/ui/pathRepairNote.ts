// src/ui/pathRepairNote.ts
// Roadmap 阶段 11.2 (P1) — the visible half of path repair.
//
// A corrected path is a silent rewrite of the user's own words, so it must never
// be silent in the transcript (iron law #4: visible + undoable). This renders a
// small note under the user bubble naming the correction, next to the one action
// that matters: putting the ORIGINAL words back in the composer to edit and send
// again. It deliberately does not resend by itself — replaying a turn from a
// click in the transcript is a side effect the user did not ask for, and the
// composer is where they can also fix the typo their way.

import { t } from '../shared/i18n';
import type { PathRepair } from './pathIndex';

/** Returns null when there is nothing to report. `useOriginal` is called with
 *  no arguments: the caller already owns the original draft text. */
export function createPathRepairNote(repairs: readonly PathRepair[], useOriginal: () => void): HTMLElement | null {
  if (repairs.length === 0) return null;
  const note = document.createElement('div');
  note.className = 'path-repair-note';

  const text = document.createElement('span');
  text.className = 'path-repair-note-text';
  text.textContent = t('repair.pathNote').replace('{pairs}', repairs.map((r) => `${r.from} → ${r.to}`).join('，'));
  note.appendChild(text);

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'path-repair-note-btn';
  button.textContent = t('repair.useOriginal');
  button.addEventListener('click', () => useOriginal());
  note.appendChild(button);

  return note;
}
