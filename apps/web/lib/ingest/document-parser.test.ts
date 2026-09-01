import { describe, expect, it } from 'bun:test';
import { strToU8, zipSync } from 'fflate';
import { extractDocument, type ImageToDescribe } from './document-parser';

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const xml = (value: string): Uint8Array => bytes(value);

function archive(files: Record<string, string | Uint8Array>): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(files).map(([name, value]) => [
    name,
    typeof value === 'string' ? strToU8(value) : value,
  ])));
}

function docxFixture(includeImage = false): Uint8Array {
  return archive({
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    'word/document.xml': [
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
      '<w:body><w:p><w:r><w:t>DOCX paragraph</w:t></w:r></w:p>',
      '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc>',
      '<w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc></w:tr></w:tbl>',
      '</w:body></w:document>',
    ].join(''),
    ...(includeImage ? { 'word/media/diagram.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) } : {}),
  });
}

function pptxFixture(): Uint8Array {
  return archive({
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    'ppt/presentation.xml': [
      '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"',
      ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
      '<p:sldIdLst><p:sldId id="1" r:id="rId2"/><p:sldId id="2" r:id="rId1"/></p:sldIdLst>',
      '</p:presentation>',
    ].join(''),
    'ppt/_rels/presentation.xml.rels': [
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>',
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>',
      '</Relationships>',
    ].join(''),
    'ppt/slides/slide1.xml': '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:p><a:r><a:t>First slide</a:t></a:r></a:p></p:sld>',
    'ppt/slides/slide2.xml': '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:p><a:r><a:t>Second slide</a:t></a:r></a:p></p:sld>',
    'ppt/slides/_rels/slide2.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide2.xml"/></Relationships>',
    'ppt/notesSlides/notesSlide2.xml': '<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:p><a:r><a:t>Speaker note</a:t></a:r></a:p></p:notes>',
  });
}

function epubFixture(): Uint8Array {
  return archive({
    mimetype: 'application/epub+zip',
    'META-INF/container.xml': '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    'OEBPS/content.opf': [
      '<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><manifest>',
      '<item id="one" href="one.xhtml" media-type="application/xhtml+xml"/>',
      '<item id="two" href="two.xhtml" media-type="application/xhtml+xml"/>',
      '</manifest><spine><itemref idref="one"/><itemref idref="two"/></spine></package>',
    ].join(''),
    'OEBPS/one.xhtml': '<html><body><h1>One</h1><script>bad()</script><p>chapter one</p></body></html>',
    'OEBPS/two.xhtml': '<html><body><p>chapter two</p></body></html>',
  });
}

function imageFixture(): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
}

function pdfFixture(): Uint8Array {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    '<< /Length 41 >>\nstream\nBT /F1 12 Tf 72 720 Td (Hello PDF) Tj ET\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let source = '%PDF-1.4\n';
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(source.length);
    source += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = source.length;
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  source += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return bytes(source);
}

async function expectError(promise: Promise<Awaited<ReturnType<typeof extractDocument>>>, code: string) {
  const result = await promise;
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe(code);
}

describe('extractDocument', () => {
  it('keeps UTF-8 Markdown text', async () => {
    const result = await extractDocument({ filename: 'note.md', mime: 'text/markdown', data: bytes('# 標題\n內容') });
    expect(result).toEqual({ ok: true, text: '# 標題\n內容' });
  });

  it('extracts PDF pages with page headings', async () => {
    const result = await extractDocument({ filename: 'sample.pdf', mime: 'application/pdf', data: pdfFixture() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toContain('## Page 1');
      expect(result.text).toContain('Hello PDF');
    }
  });

  it('extracts DOCX paragraphs and table cells', async () => {
    const result = await extractDocument({
      filename: 'sample.docx',
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      data: docxFixture(),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text).toContain('DOCX paragraph\nA | B');
  });

  it('keeps PPTX slide order and speaker notes', async () => {
    const result = await extractDocument({
      filename: 'sample.pptx',
      mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      data: pptxFixture(),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text.indexOf('Second slide')).toBeLessThan(result.text.indexOf('First slide'));
      expect(result.text).toContain('Speaker note');
    }
  });

  it('extracts EPUB spine in order without executing scripts', async () => {
    const result = await extractDocument({ filename: 'sample.epub', mime: 'application/epub+zip', data: epubFixture() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text.indexOf('chapter one')).toBeLessThan(result.text.indexOf('chapter two'));
      expect(result.text).not.toContain('bad()');
    }
  });

  it('uses the image describer for standalone and embedded images', async () => {
    const seen: ImageToDescribe[] = [];
    const describe = async (image: ImageToDescribe) => {
      seen.push(image);
      return `A ${image.name}`;
    };
    const standalone = await extractDocument({ filename: 'cat.png', mime: 'image/png', data: imageFixture(), describeImage: describe });
    expect(standalone).toEqual({ ok: true, text: 'A cat.png' });
    const embedded = await extractDocument({ filename: 'sample.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', data: docxFixture(true), describeImage: describe });
    expect(embedded.ok).toBe(true);
    if (embedded.ok) expect(embedded.text).toContain('### Image: diagram.png\nA diagram.png');
    expect(seen.map(image => image.mime)).toContain('image/png');
  });

  it('returns a structured error when a standalone image cannot be described', async () => {
    await expectError(extractDocument({ filename: 'cat.png', mime: 'image/png', data: imageFixture() }), 'IMAGE_DESCRIBER_REQUIRED');
    await expectError(extractDocument({ filename: 'cat.png', mime: 'image/png', data: imageFixture(), describeImage: () => { throw new Error('provider') } }), 'IMAGE_DESCRIPTION_FAILED');
  });

  it('rejects unsafe paths, zip bombs, and entry-count overflow', async () => {
    await expectError(extractDocument({ filename: 'bad.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', data: archive({ '../evil.txt': 'x' }) }), 'ARCHIVE_ZIP_SLIP');
    const bomb = archive({ 'large.txt': strToU8('A'.repeat(9 * 1024 * 1024)) });
    await expectError(extractDocument({ filename: 'bomb.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', data: bomb }), 'ARCHIVE_ENTRY_TOO_LARGE');
    const expanded = archive(Object.fromEntries(Array.from({ length: 5 }, (_, index) => [
      `part${index}.txt`,
      strToU8('B'.repeat(7 * 1024 * 1024)),
    ])));
    await expectError(extractDocument({ filename: 'expanded.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', data: expanded }), 'ARCHIVE_OUTPUT_LIMIT');
    const many = Object.fromEntries(Array.from({ length: 2_001 }, (_, index) => [`e${index}.txt`, strToU8('x')]));
    await expectError(extractDocument({ filename: 'many.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', data: zipSync(many) }), 'ARCHIVE_ENTRY_LIMIT');
  });

  it('rejects unsupported, mismatched, and invalid-magic inputs', async () => {
    await expectError(extractDocument({ filename: 'sheet.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', data: bytes('x') }), 'UNSUPPORTED_TYPE');
    await expectError(extractDocument({ filename: 'note.pdf', mime: 'text/plain', data: bytes('hello') }), 'TYPE_MISMATCH');
    await expectError(extractDocument({ filename: 'note.pdf', mime: 'application/pdf', data: bytes('not pdf') }), 'INVALID_MAGIC');
  });
});
