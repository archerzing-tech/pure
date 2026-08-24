// src/ui/designPreviewCard.ts
// Design-first builds: when the model finishes the static mockup (design.html)
// it emits `## 设计稿已就绪：design.html` and stops. The GUI renders the
// mockup here in a sandboxed iframe so the user SEES the intended look before
// any implementation code is written, and confirms or requests adjustments.

export interface DesignPreviewCardHandle {
  el: HTMLElement;
  /** Flip the footer into the confirmed state (buttons disabled, badge shown). */
  setConfirmed(): void;
}

export function createDesignPreviewCard(
  html: string,
  fileName: string,
  onConfirm: () => void,
): DesignPreviewCardHandle {
  const el = document.createElement('div');
  el.className = 'bubble-row design-preview-row';

  const card = document.createElement('div');
  card.className = 'design-preview-card';

  const head = document.createElement('div');
  head.className = 'design-preview-head';
  const title = document.createElement('span');
  title.className = 'design-preview-title';
  title.textContent = '🎨 设计稿预览';
  const file = document.createElement('span');
  file.className = 'design-preview-file';
  file.textContent = fileName;
  head.append(title, file);

  const note = document.createElement('div');
  note.className = 'design-preview-note';
  note.textContent = '这是开始实现前的静态设计稿（布局 / 配色 / 字体）。确认后严格按它的设计实现；想调整直接回复你的意见。';

  const frame = document.createElement('iframe');
  frame.className = 'design-preview-frame';
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('title', `设计稿预览：${fileName}`);
  frame.srcdoc = html;

  const actions = document.createElement('div');
  actions.className = 'design-preview-actions';
  const confirm = document.createElement('button');
  confirm.type = 'button';
  confirm.className = 'design-preview-confirm';
  confirm.textContent = '✅ 确认设计，开始实现';
  confirm.addEventListener('click', () => {
    if (confirm.disabled) return;
    confirm.disabled = true;
    onConfirm();
  });
  actions.appendChild(confirm);

  card.append(head, note, frame, actions);
  el.appendChild(card);

  return {
    el,
    setConfirmed(): void {
      confirm.disabled = true;
      confirm.textContent = '✔ 已确认，开始按设计稿实现';
      el.classList.add('confirmed');
    },
  };
}
