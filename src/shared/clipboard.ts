export interface ClipboardWriter {
  writeText(text: string): Promise<void>;
}

export async function copyTextToClipboard(text: string, clipboard?: ClipboardWriter): Promise<boolean> {
  if (!text) return false;

  const writer = clipboard ?? (typeof navigator !== 'undefined' ? navigator.clipboard : undefined);
  if (writer) {
    try {
      await writer.writeText(text);
      return true;
    } catch {
    }
  }

  if (typeof document === 'undefined' || !document.body || typeof document.execCommand !== 'function') {
    return false;
  }

  const helper = document.createElement('textarea');
  helper.value = text;
  helper.setAttribute('readonly', '');
  helper.style.position = 'fixed';
  helper.style.opacity = '0';
  document.body.appendChild(helper);
  helper.select();
  try {
    return document.execCommand('copy');
  } finally {
    helper.remove();
  }
}
