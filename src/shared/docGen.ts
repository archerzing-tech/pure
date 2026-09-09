// src/shared/docGen.ts
// Generate real DOCX / PPTX / XLSX binary files from JSON specs.
// The LLM provides a structured description (slides, paragraphs, sheets),
// and these functions produce the actual binary via the `docx`, `pptxgenjs`,
// and `xlsx` (SheetJS) libraries. The caller then saves via `save_file_binary`.

// ── Spec types (what the LLM provides) ──

export interface DocxSectionHeading { type: 'heading'; text: string; level: number }
export interface DocxSectionParagraph { type: 'paragraph'; text: string; bold?: boolean }
export interface DocxSectionBullet { type: 'bullet'; text: string }
export interface DocxSectionPageBreak { type: 'pageBreak' }
export type DocxSection = DocxSectionHeading | DocxSectionParagraph | DocxSectionBullet | DocxSectionPageBreak;

export interface DocxSpec {
  format: 'docx';
  sections: DocxSection[];
}

export interface PptxSlide {
  title?: string;
  content?: string[];
}

export interface PptxSpec {
  format: 'pptx';
  slides: PptxSlide[];
}

export interface XlsxSheet {
  name: string;
  rows: Array<Array<string | number | boolean>>;
}

export interface XlsxSpec {
  format: 'xlsx';
  sheets: XlsxSheet[];
}

export type DocumentSpec = DocxSpec | PptxSpec | XlsxSpec;

// ── Generation ──

export async function generateDocx(spec: DocxSpec): Promise<Uint8Array> {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel } = await import('docx');
  const children: InstanceType<typeof Paragraph>[] = [];
  for (const section of spec.sections) {
    if (section.type === 'heading') {
      const levels = [undefined, HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3];
      children.push(new Paragraph({
        text: section.text,
        heading: levels[Math.min(section.level ?? 1, 3)] ?? HeadingLevel.HEADING_1,
      }));
    } else if (section.type === 'bullet') {
      children.push(new Paragraph({ text: section.text, bullet: { level: 0 } }));
    } else if (section.type === 'pageBreak') {
      children.push(new Paragraph({ text: '', pageBreakBefore: true }));
    } else {
      children.push(new Paragraph({
        children: [new TextRun({ text: section.text, bold: section.bold ?? false })],
        spacing: { after: 200 },
      }));
    }
  }
  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

export async function generatePptx(spec: PptxSpec): Promise<Uint8Array> {
  const PptxGenJS = (await import('pptxgenjs')).default;
  const pptx = new PptxGenJS();
  for (const slide of spec.slides) {
    const s = pptx.addSlide();
    if (slide.title) {
      s.addText(slide.title, { x: 0.5, y: 0.4, w: 9, h: 0.8, fontSize: 28, bold: true, color: '333333' });
    }
    if (slide.content?.length) {
      s.addText(
        slide.content.map((text) => ({ text, options: { bullet: true, fontSize: 16, breakLine: true } })),
        { x: 0.8, y: 1.5, w: 8.4, h: 4.5, color: '444444' },
      );
    }
  }
  const data = await pptx.write({ outputType: 'base64' }) as string;
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function generateXlsx(spec: XlsxSpec): Promise<Uint8Array> {
  const XLSX = await import('xlsx');
  const wb = XLSX.utils.book_new();
  for (const sheet of spec.sheets) {
    const ws = XLSX.utils.aoa_to_sheet(sheet.rows);
    XLSX.utils.book_append_sheet(wb, ws, sheet.name);
  }
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  return new Uint8Array(buf);
}

/** Generate a binary document from a spec. Returns the bytes ready to save. */
export async function generateDocument(spec: DocumentSpec): Promise<Uint8Array> {
  switch (spec.format) {
    case 'docx': return generateDocx(spec);
    case 'pptx': return generatePptx(spec);
    case 'xlsx': return generateXlsx(spec);
  }
}

/** Convert Uint8Array to base64 (for save_file_binary IPC). */
export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(binary);
}
